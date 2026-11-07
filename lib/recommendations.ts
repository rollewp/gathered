import 'server-only'
import { withPersona } from '@/lib/db'
import { PROMPT_VERSION } from '@/lib/ranking/rank-v2.mjs'
import { rankShortlist, type MemberProfile, type ModelCall, type ShortlistItem } from '@/lib/ranking/llm'

// Recommendation lifecycle orchestrator (architecture §6.1):
//   eligible request -> current run stored? -> reuse | shortlist -> rank -> persist -> return.
// All database access goes through withPersona. Each database step is its own short transaction
// so no connection is held open during the model call. Authorization and every integrity rule
// (eligibility, shortlist-only ranking, one current run) live in the database functions.

export type RecommendedGroup = {
  rank: number
  group_id: string
  name: string
  description: string
  tags: string[]
  meeting_slot: string
  is_online: boolean
  childcare: boolean
  open_seats: number
  area_label: string
}

export type RecommendationResult =
  | { status: 'ineligible'; reason: 'no_profile' | 'in_group'; llmAttempts: 0 }
  | { status: 'ok'; source: 'reused' | 'generated'; runId: string; groups: RecommendedGroup[]; llmAttempts: number }

export type RecommendationDeps = { callModel?: ModelCall }

const LOAD_GROUPS = `
  select r.rank, gc.group_id, gc.name, gc.description, gc.tags, gc.meeting_slot, gc.is_online,
         gc.childcare, gc.open_seats, gc.area_label
  from app.recommendation r
  join app.group_card() gc on gc.group_id = r.group_id
  where r.run_id = $1
  order by r.rank`

/**
 * The member's state and, if a current run exists, its ordered groups. Each statement in a
 * READ COMMITTED transaction sees fresh data, so a concurrent request can supersede the run
 * between "which run is current" and "load its groups". The run is therefore re-checked after
 * the groups are loaded, and the read is repeated if it was superseded in between.
 */
async function readCurrent(personKey: string) {
  return withPersona(personKey, async (db) => {
    for (let attempt = 0; ; attempt++) {
      const s = (await db.query<{ out_state: string; out_run_id: string | null }>(
        'select * from app.current_recommendation_run($1)', [PROMPT_VERSION])).rows[0]
      if (s.out_state !== 'current' || !s.out_run_id) return { state: s.out_state, runId: null, groups: [] as RecommendedGroup[] }
      const groups = (await db.query<RecommendedGroup>(LOAD_GROUPS, [s.out_run_id])).rows
      const stillCurrent = (await db.query('select 1 from app.recommendation_run where run_id = $1 and is_current', [s.out_run_id])).rowCount === 1
      if (stillCurrent || attempt >= 4) return { state: s.out_state, runId: s.out_run_id, groups }
    }
  })
}

/** Read-only view of the member's current run. Never generates, never calls the LLM. */
export async function peekRecommendations(personKey: string): Promise<RecommendationResult | { status: 'none' }> {
  const c = await readCurrent(personKey)
  if (c.state === 'no_profile' || c.state === 'in_group') return { status: 'ineligible', reason: c.state, llmAttempts: 0 }
  if (c.state === 'current' && c.runId) return { status: 'ok', source: 'reused', runId: c.runId, groups: c.groups, llmAttempts: 0 }
  return { status: 'none' }
}

/** An eligible member asks for recommendations: reuse the current run, or generate and persist one. */
export async function getRecommendations(personKey: string, deps: RecommendationDeps = {}): Promise<RecommendationResult> {
  const peek = await peekRecommendations(personKey)
  if (peek.status !== 'none') return peek

  let llmAttempts = 0
  for (let tries = 0; tries < 2; tries++) {
    const { shortlist, member } = await withPersona(personKey, async (db) => ({
      shortlist: (await db.query<ShortlistItem>('select * from app.recommendation_shortlist()')).rows,
      member: (await db.query<MemberProfile>(
        'select life_stage, group_pref, interests, about_me from app.member_profile where person_id = app._person()')).rows[0],
    }))
    const shortlistIds = shortlist.map((g) => g.group_id)

    let args: unknown[]
    if (shortlist.length === 0) {
      args = [shortlistIds, [], 'no_candidates', null, null, null, null, null]
    } else {
      const ranked = await rankShortlist(personKey, { member, shortlist }, deps.callModel)
      llmAttempts += ranked.usage.attempts
      args = [shortlistIds, ranked.orderedIds, ranked.outcome, ranked.confidence, ranked.internalRationale,
        ranked.model, ranked.promptVersion, JSON.stringify(ranked.usage)]
    }

    try {
      const runId = await withPersona(personKey, async (db) =>
        (await db.query<{ run_id: string }>(
          'select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, $4, $5, $6, $7, $8::jsonb) as run_id', args)).rows[0].run_id)
      // A concurrent request may have superseded our run already; members only ever read their
      // current run, so return whichever run is current in one consistent snapshot.
      const now = await readCurrent(personKey)
      const finalRun = now.state === 'current' && now.runId ? now.runId : runId
      return {
        status: 'ok', source: finalRun === runId ? 'generated' : 'reused', runId: finalRun,
        groups: now.groups, llmAttempts,
      }
    } catch (e) {
      // A material change landed between the shortlist and the write: redo the whole flow once.
      if (e instanceof Error && e.message.includes('shortlist_changed') && tries === 0) continue
      throw e
    }
  }
  throw new Error('recommendation generation did not settle')
}
