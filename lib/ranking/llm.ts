import 'server-only'
import OpenAI from 'openai'
import { withPersona } from '@/lib/db'
import {
  PROMPT_VERSION, SYSTEM_PROMPT, memberPayload, shortlistPayload, parseRanking, scoreOrderFallback,
} from '@/lib/ranking/rank-v2.mjs'

// Ranking client (architecture §5.5, §7). Server-side only; the OpenRouter key never reaches the
// browser. One audit_log row is written for every actual model attempt, with purpose, model,
// prompt version, token counts, latency, attempt number and outcome. The prompt and about_me are
// never stored. app.persist_recommendation_run stores the final provenance and aggregate usage
// on the run and writes no audit row of its own, so a call is never recorded twice.

export type ShortlistItem = {
  shortlist_position: number
  group_id: string
  name: string
  description: string
  tags: string[]
  meeting_slot: string
  gender_focus: string | null
  life_stage_focus: string | null
  childcare: boolean
  is_online: boolean
  status: string
  open_seats: number
  group_mix: Record<string, number>
  score: string
}
export type MemberProfile = { life_stage: string | null; group_pref: string | null; interests: string[] | null; about_me: string | null }

export type ModelUsage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number }
export type ModelResponse = { raw: string; usage?: ModelUsage; latencyMs: number; model: string }
/** One model attempt. Injected in tests so no external call is made. */
export type ModelCall = (payload: unknown, attempt: number) => Promise<ModelResponse>

export type RankResult = {
  orderedIds: string[]
  outcome: 'llm' | 'llm_after_retry' | 'score_fallback'
  confidence: 'high' | 'medium' | 'low'
  internalRationale: string
  model: string
  promptVersion: string
  usage: { attempts: number; prompt_tokens: number; completion_tokens: number; total_tokens: number; cost_usd: number; latency_ms: number }
}

/** Every attempt failed to reach the model: nothing is persisted, so the next request retries. */
export class RankingUnavailableError extends Error {
  name = 'RankingUnavailableError'
}

export const openRouterCall: ModelCall = async (payload) => {
  const apiKey = process.env.OPENROUTER_API_KEY
  const model = process.env.OPENROUTER_MODEL_FAST
  if (!apiKey || !model) throw new RankingUnavailableError('OPENROUTER_API_KEY / OPENROUTER_MODEL_FAST are not set')
  const client = new OpenAI({ apiKey, baseURL: 'https://openrouter.ai/api/v1' })
  const t0 = Date.now()
  const resp = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify(payload) }],
  })
  return {
    raw: resp.choices[0]?.message?.content ?? '',
    usage: resp.usage as ModelUsage | undefined,
    latencyMs: Date.now() - t0,
    model,
  }
}

type AttemptOutcome = 'ok' | 'invalid_output' | 'error'

async function logAttempt(
  personKey: string,
  d: { attempt: number; outcome: AttemptOutcome; model: string | null; latencyMs: number | null; usage?: ModelUsage; error?: string },
) {
  const detail = {
    purpose: 'recommendation_rank',
    model: d.model,
    prompt_version: PROMPT_VERSION,
    attempt: d.attempt,
    outcome: d.outcome,
    latency_ms: d.latencyMs,
    prompt_tokens: d.usage?.prompt_tokens ?? null,
    completion_tokens: d.usage?.completion_tokens ?? null,
    total_tokens: d.usage?.total_tokens ?? null,
    cost_usd: d.usage?.cost ?? null,
    error: d.error ?? null, // error class/message only, never prompt content
  }
  await withPersona(personKey, (db) =>
    db.query(
      `insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
       values ((select user_id from app.portal_user where person_id = app._person()),
               'llm_rank_attempt', 'person', app._person(), $1::jsonb)`,
      [JSON.stringify(detail)],
    ),
  )
}

/**
 * Rank a non-empty shortlist: up to two model attempts, each validated against the shortlist.
 * Both invalid -> deterministic score-order fallback. Both unreachable -> RankingUnavailableError.
 */
export async function rankShortlist(
  personKey: string,
  input: { member: MemberProfile; shortlist: ShortlistItem[] },
  callModel: ModelCall = openRouterCall,
): Promise<RankResult> {
  const idList = input.shortlist.map((g) => g.group_id)
  const ids = new Set(idList)
  const n = Math.min(3, idList.length)
  const payload = {
    member: memberPayload(input.member),
    shortlist: shortlistPayload(input.shortlist, { includeScore: true }),
  }

  const total = { attempts: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: 0, latency_ms: 0 }
  let model = process.env.OPENROUTER_MODEL_FAST ?? 'unknown'
  let responded = false
  let lastError = ''

  for (let attempt = 1; attempt <= 2; attempt++) {
    total.attempts = attempt
    let resp: ModelResponse
    try {
      resp = await callModel(payload, attempt)
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'model call failed'
      await logAttempt(personKey, { attempt, outcome: 'error', model: null, latencyMs: null, error: lastError.slice(0, 200) })
      continue
    }
    responded = true
    model = resp.model
    total.prompt_tokens += resp.usage?.prompt_tokens ?? 0
    total.completion_tokens += resp.usage?.completion_tokens ?? 0
    total.total_tokens += resp.usage?.total_tokens ?? 0
    total.cost_usd += resp.usage?.cost ?? 0
    total.latency_ms += resp.latencyMs
    try {
      const parsed = parseRanking(resp.raw, ids, n)
      await logAttempt(personKey, { attempt, outcome: 'ok', model, latencyMs: resp.latencyMs, usage: resp.usage })
      return {
        orderedIds: parsed.orderedIds,
        outcome: attempt === 1 ? 'llm' : 'llm_after_retry',
        confidence: parsed.confidence,
        internalRationale: parsed.internal_rationale,
        model, promptVersion: PROMPT_VERSION, usage: total,
      }
    } catch (e) {
      lastError = e instanceof Error ? e.message : 'invalid output'
      await logAttempt(personKey, { attempt, outcome: 'invalid_output', model, latencyMs: resp.latencyMs, usage: resp.usage, error: lastError.slice(0, 200) })
    }
  }

  if (!responded) throw new RankingUnavailableError(`ranking model unreachable: ${lastError}`)
  return {
    orderedIds: scoreOrderFallback(idList, n),
    outcome: 'score_fallback',
    confidence: 'low',
    internalRationale: `Fallback to score order: model output invalid after retry (${lastError.slice(0, 120)})`,
    model, promptVersion: PROMPT_VERSION, usage: total,
  }
}
