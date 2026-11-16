import 'server-only'
import { withPersona } from '@/lib/db'
import type { GroupCardRow } from '@/lib/group-view'
import { changedFields, type ProfileFields } from '@/lib/profile-schema'

// Member-facing reads and the join-request write for Journey 1. Every call runs through
// withPersona, so row-level security applies. The only columns read are ones a member may see:
// public group card facts, their own profile preferences, and their own join requests.
// Ranking scores, shortlists, rationale and model details are never selected here.

export type MyRequest = {
  request_id: string
  group_id: string
  status: string
  member_note: string | null
  requested_at: string
  leader_first_name: string | null
  group_name: string | null
}

export type MyPreferences = {
  life_stage: string | null
  available_slots: string[] | null
  group_pref: string | null
  interests: string[] | null
  about_me: string | null
}

export async function getGroupCard(personKey: string, groupId: string): Promise<GroupCardRow | null> {
  return withPersona(personKey, async (db) =>
    (await db.query<GroupCardRow>('select * from app.group_card() where group_id = $1', [groupId])).rows[0] ?? null)
}

export async function getMyRequests(personKey: string): Promise<MyRequest[]> {
  return withPersona(personKey, async (db) => {
    const reqs = (await db.query<Omit<MyRequest, 'group_name'>>('select * from app.my_join_requests()')).rows
    const names = new Map((await db.query<{ group_id: string; name: string }>('select group_id, name from app.group_card()')).rows
      .map((g) => [g.group_id, g.name]))
    return reqs.map((r) => ({ ...r, group_name: names.get(r.group_id) ?? null }))
  })
}

export async function getMyPreferences(personKey: string): Promise<MyPreferences | null> {
  return withPersona(personKey, async (db) =>
    (await db.query<MyPreferences>(
      'select life_stage, available_slots, group_pref, interests, about_me from app.member_profile where person_id = app._person()')).rows[0] ?? null)
}

export type JoinResult =
  | { ok: true }
  | { ok: false; code: 'not_eligible' | 'group_unavailable' | 'duplicate_request' | 'note_too_long' | 'error' }

/** The database enforces eligibility, joinability, duplicates and the audit row (migration 0006). */
export async function requestToJoin(personKey: string, groupId: string, note: string | null): Promise<JoinResult> {
  try {
    await withPersona(personKey, (db) => db.query('select app.request_to_join($1, $2)', [groupId, note]))
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : ''
    for (const code of ['not_eligible', 'group_unavailable', 'duplicate_request', 'note_too_long'] as const) {
      if (msg.includes(code)) return { ok: false, code }
    }
    return { ok: false, code: 'error' }
  }
}

export type SaveProfileResult =
  | { ok: true; changed: (keyof ProfileFields)[] }
  | { ok: false; code: 'no_profile' | 'error' }

/**
 * The member confirms their preferences. Identity comes only from the persona context (the
 * caller's own row; there is no person id parameter). The five member-editable columns are the
 * only ones written; consent, source, distance and opt-in are untouched. An identical
 * confirmation writes nothing, so the database's material-change trigger never fires and the
 * saved recommendation run stays valid; a real change fires that trigger (reason
 * profile_changed). No model is called. One audit row records WHICH fields changed, never their
 * values, and never about_me.
 */
export async function saveMyProfile(personKey: string, next: ProfileFields): Promise<SaveProfileResult> {
  try {
    return await withPersona(personKey, async (db) => {
      const cur = (await db.query<ProfileFields>(
        `select life_stage, coalesce(available_slots, '{}') as available_slots, group_pref,
                coalesce(interests, '{}') as interests, about_me
         from app.member_profile where person_id = app._person() for update`)).rows[0]
      if (!cur) return { ok: false as const, code: 'no_profile' as const }
      const changed = changedFields(cur, next)
      if (changed.length === 0) return { ok: true as const, changed }
      await db.query(
        `update app.member_profile
            set life_stage = $1, available_slots = $2, group_pref = $3, interests = $4, about_me = $5
          where person_id = app._person()`,
        [next.life_stage, next.available_slots, next.group_pref, next.interests, next.about_me])
      await db.query(
        `insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
         values ((select pu.user_id from app.portal_user pu where pu.person_id = app._person()),
                 'member_profile_updated', 'member_profile', app._person(), $1::jsonb)`,
        [JSON.stringify({ changed_fields: changed })])
      return { ok: true as const, changed }
    })
  } catch {
    return { ok: false, code: 'error' }
  }
}
