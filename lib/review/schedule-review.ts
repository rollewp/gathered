import 'server-only'
import OpenAI from 'openai'
import { withPersona } from '@/lib/db'
import { findPersona } from '@/lib/personas'
import type { ModelResponse, ModelUsage } from '@/lib/ranking/llm'
import {
  REVIEW_KIND, REVIEW_PROMPT_VERSION, REVIEW_SYSTEM_PROMPT, parseReview, reviewFacts,
} from '@/lib/review/schedule-conflict.mjs'

// Manager schedule-conflict review (architecture §7, §8 #1). Runs ONLY when the Manager chooses
// "Run AI review" (never on a page view, never when a request is created). For each pending join
// request whose requester serves on the same day the group meets, one narrow question goes to the
// review model; a validated "raise" becomes one advisory escalation. It never changes the join
// request, membership, serving data or recommendation runs, and never contacts anyone.

export class ReviewForbiddenError extends Error { name = 'ReviewForbiddenError' }
export class ReviewUnavailableError extends Error { name = 'ReviewUnavailableError' }

export type ReviewCandidate = {
  request_id: string
  person_id: string
  group_id: string
  requested_at: string
  member_note: string | null
  first_name: string
  group_name: string
  group_description: string
  meeting_slot: string
  about_me: string | null
  busy_slots: string[] | null
  serving_areas: string[] | null
}

/** One model attempt. Injected in tests so no external call is made. */
export type ReviewModelCall = (facts: unknown, attempt: number) => Promise<ModelResponse>

export type ReviewSummary = {
  candidates: number
  alreadyRaised: number
  reviewed: number
  raised: number
  notRaised: number
  invalid: number
  attempts: number
  escalationIds: string[]
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number; latency_ms: number }
  model: string | null
}

export const openRouterReviewCall: ReviewModelCall = async (facts) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL_REVIEW
  if (!apiKey || !model) throw new ReviewUnavailableError('OPENROUTER_API_KEY / OPENROUTER_MODEL_REVIEW are not set')
  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' })
  const t0 = Date.now()
  const resp = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: REVIEW_SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(facts) }],
  })
  return { raw: resp.choices[0]?.message?.content ?? '', usage: resp.usage as ModelUsage | undefined, latencyMs: Date.now() - t0, model }
}

const CANDIDATES = `
  select jr.request_id, jr.person_id, jr.group_id, jr.requested_at, jr.member_note,
         p.first_name, g.name as group_name, g.description as group_description, g.meeting_slot,
         mp.about_me, pf.busy_slots, pf.serving_areas
  from app.join_request jr
  join app.person p on p.person_id = jr.person_id
  join app.grp g on g.group_id = jr.group_id
  join app.person_features pf on pf.person_id = jr.person_id
  left join app.member_profile mp on mp.person_id = jr.person_id
  where jr.status = 'requested'
    and exists (select 1 from unnest(coalesce(pf.busy_slots, '{}')) b
                where split_part(b, '_', 1) = split_part(g.meeting_slot, '_', 1))
  order by jr.requested_at, jr.request_id
  limit 10`

const EXISTING = `
  select escalation_id from app.escalation
  where source = 'ai' and kind = $1 and person_id = $2 and group_id = $3 and status in ('open', 'acknowledged')
  limit 1`

async function audit(personKey: string, action: string, entity: string, entityId: string, detail: Record<string, unknown>) {
  await withPersona(personKey, (db) =>
    db.query(
      `insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
       values ((select user_id from app.portal_user where person_id = app._person()), $1, $2, $3, $4::jsonb)`,
      [action, entity, entityId, JSON.stringify(detail)],
    ))
}

async function logAttempt(
  personKey: string, requestId: string,
  d: { attempt: number; outcome: 'ok' | 'invalid_output' | 'error'; model: string | null; latencyMs: number | null; usage?: ModelUsage; error?: string },
) {
  // The prompt, the supplied facts and about_me are never stored here.
  await audit(personKey, 'llm_review_attempt', 'join_request', requestId, {
    purpose: 'schedule_conflict_review', model: d.model, prompt_version: REVIEW_PROMPT_VERSION, attempt: d.attempt, outcome: d.outcome,
    latency_ms: d.latencyMs, prompt_tokens: d.usage?.prompt_tokens ?? null, completion_tokens: d.usage?.completion_tokens ?? null,
    total_tokens: d.usage?.total_tokens ?? null, cost_usd: d.usage?.cost ?? null, error: d.error ?? null,
  })
}

/** Write the escalation unless an open or acknowledged one already exists for this person and group. */
async function persistEscalation(
  personKey: string, c: ReviewCandidate, facts: unknown,
  result: { severity: string; summary: string; evidence: string[] }, provenance: { model: string; prompt_version: string },
): Promise<{ created: boolean; id: string }> {
  return withPersona(personKey, async (db) => {
    // serialise concurrent reviews for the same person and group so a double click cannot duplicate
    await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${REVIEW_KIND}:${c.person_id}:${c.group_id}`])
    const dup = (await db.query<{ escalation_id: string }>(EXISTING, [REVIEW_KIND, c.person_id, c.group_id])).rows[0]
    if (dup) return { created: false, id: dup.escalation_id }
    const evidence = {
      request_id: c.request_id, requested_at: c.requested_at,
      supplied_facts: facts, model_evidence: result.evidence, ...provenance,
    }
    const row = (await db.query<{ escalation_id: string }>(
      `insert into app.escalation (escalation_id, source, kind, severity, group_id, person_id, summary, evidence)
       values (gen_random_uuid(), 'ai', $1, $2, $3, $4, $5, $6::jsonb) returning escalation_id`,
      [REVIEW_KIND, result.severity, c.group_id, c.person_id, result.summary, JSON.stringify(evidence)])).rows[0]
    await db.query(
      `insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
       values ((select user_id from app.portal_user where person_id = app._person()), 'escalation_created', 'escalation', $1, $2::jsonb)`,
      [row.escalation_id, JSON.stringify({ kind: REVIEW_KIND, source: 'ai', request_id: c.request_id, group_id: c.group_id, person_id: c.person_id, ...provenance })])
    return { created: true, id: row.escalation_id }
  })
}

/**
 * The Manager's explicit "Run AI review". Rejects any persona that is not a Manager before
 * anything is read. Up to two model attempts per candidate (the established limit): an invalid
 * reply is retried once, then dropped with nothing stored; an unreachable model stops the run
 * with nothing partial stored. Candidates that already have an open or acknowledged
 * schedule-conflict escalation are skipped without a model call.
 */
export async function runScheduleReview(personKey: string, deps: { callModel?: ReviewModelCall } = {}): Promise<ReviewSummary> {
  const persona = findPersona(personKey)
  if (!persona || persona.role !== 'manager') throw new ReviewForbiddenError('Only the Manager can run the AI review')
  const callModel = deps.callModel ?? openRouterReviewCall

  const candidates = await withPersona(personKey, async (db) => (await db.query<ReviewCandidate>(CANDIDATES)).rows)
  const out: ReviewSummary = {
    candidates: candidates.length, alreadyRaised: 0, reviewed: 0, raised: 0, notRaised: 0, invalid: 0, attempts: 0, escalationIds: [],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms: 0 }, model: null,
  }

  for (const c of candidates) {
    const existing = await withPersona(personKey, async (db) => (await db.query(EXISTING, [REVIEW_KIND, c.person_id, c.group_id])).rowCount)
    if (existing) { out.alreadyRaised++; continue }

    const facts = reviewFacts({ ...c })
    out.reviewed++
    let verdict: ReturnType<typeof parseReview> | null = null
    let lastError = ''
    let responded = false
    for (let attempt = 1; attempt <= 2 && !verdict; attempt++) {
      out.attempts++
      let resp: ModelResponse
      try {
        resp = await callModel(facts, attempt)
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'model call failed'
        await logAttempt(personKey, c.request_id, { attempt, outcome: 'error', model: null, latencyMs: null, error: lastError.slice(0, 200) })
        continue
      }
      responded = true
      out.model = resp.model
      out.usage.prompt_tokens += resp.usage?.prompt_tokens ?? 0
      out.usage.completion_tokens += resp.usage?.completion_tokens ?? 0
      out.usage.total_tokens += resp.usage?.total_tokens ?? 0
      out.usage.cost_usd += resp.usage?.cost ?? 0
      out.usage.latency_ms += resp.latencyMs
      try {
        verdict = parseReview(resp.raw, facts)
        await logAttempt(personKey, c.request_id, { attempt, outcome: 'ok', model: resp.model, latencyMs: resp.latencyMs, usage: resp.usage })
      } catch (e) {
        lastError = e instanceof Error ? e.message : 'invalid output'
        await logAttempt(personKey, c.request_id, { attempt, outcome: 'invalid_output', model: resp.model, latencyMs: resp.latencyMs, usage: resp.usage, error: lastError.slice(0, 200) })
      }
    }
    if (!verdict) {
      if (!responded) throw new ReviewUnavailableError(`review model unreachable: ${lastError}`)
      out.invalid++
      continue
    }
    if (!verdict.raise) { out.notRaised++; continue }
    const saved = await persistEscalation(personKey, c, facts, verdict, { model: out.model ?? 'unknown', prompt_version: REVIEW_PROMPT_VERSION })
    if (saved.created) { out.raised++; out.escalationIds.push(saved.id) } else out.alreadyRaised++
  }
  return out
}

export type InsightRow = {
  escalation_id: string
  severity: string | null
  summary: string | null
  status: string
  created_at: string
  first_name: string
  last_name: string
  group_name: string
  evidence: { model_evidence?: string[]; model?: string; prompt_version?: string; request_id?: string } | null
  request_status: string | null
}

/** The Manager's persisted insights (read only; reading never calls the model). */
export async function listInsights(personKey: string): Promise<InsightRow[]> {
  return withPersona(personKey, async (db) => (await db.query<InsightRow>(
    `select e.escalation_id, e.severity, e.summary, e.status, e.created_at, p.first_name, p.last_name, g.name as group_name, e.evidence,
            (select jr.status from app.join_request jr where jr.request_id = (e.evidence->>'request_id')::uuid) as request_status
     from app.escalation e
     join app.person p on p.person_id = e.person_id
     join app.grp g on g.group_id = e.group_id
     where e.source = 'ai' and e.kind = $1 and e.status in ('open', 'acknowledged')
     order by e.created_at desc`, [REVIEW_KIND])).rows)
}
