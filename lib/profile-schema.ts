import { z } from 'zod'

// The member-editable profile contract (architecture §3a, §10.2 intake schema). Pure: no database,
// no server-only import, so server code and tests share one definition of the allowed values.
// Nothing here covers fields a member may not edit (consent, source, distance, opt-in).

export const LIFE_STAGES = ['single', 'married_no_kids', 'young_kids', 'school_age_kids', 'teens', 'empty_nest', 'retired'] as const
export const GROUP_PREFS = ['men', 'women', 'mixed', 'couples'] as const
/** Meeting slots groups and members use today, in week order. */
export const SLOTS = ['sun_9', 'sun_pm', 'mon_eve', 'tue_am', 'tue_eve', 'wed_am', 'wed_eve', 'thu_am', 'thu_eve', 'sat_am'] as const
/** The group tag vocabulary a member's interests are matched against. */
export const INTERESTS = ['bible_reading', 'book_study', 'marriage', 'men', 'new_to_faith', 'outdoors', 'parenting', 'prayer',
  'recovery_friendly', 'serving_together', 'theology', 'women'] as const
export const ABOUT_ME_MAX = 1000

export type ProfileFields = {
  life_stage: string | null
  available_slots: string[]
  group_pref: string | null
  interests: string[]
  about_me: string | null
}

const oneOf = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values)
const uniqueOrdered = (allowed: readonly string[]) => (picked: string[]) => allowed.filter((v) => picked.includes(v))

export const ProfileInput = z.object({
  life_stage: oneOf(LIFE_STAGES).nullable(),
  available_slots: z.array(oneOf(SLOTS)).min(1, 'Pick at least one time you could meet.'),
  group_pref: oneOf(GROUP_PREFS).nullable(),
  interests: z.array(oneOf(INTERESTS)),
  about_me: z.string().max(ABOUT_ME_MAX, `Please keep this under ${ABOUT_ME_MAX} characters.`).nullable(),
}).transform((p) => ({
  ...p,
  // canonical order, no duplicates: the order a member ticks boxes in is not a change
  available_slots: uniqueOrdered(SLOTS)(p.available_slots),
  interests: uniqueOrdered(INTERESTS)(p.interests),
}))

/** Free text keeps its words; only line endings and outer whitespace are normalised. Empty becomes null. */
export function normalizeAboutMe(v: string | null | undefined): string | null {
  const t = (v ?? '').replace(/\r\n?/g, '\n').trim()
  return t === '' ? null : t
}

export type ProfileParse =
  | { ok: true; value: ProfileFields }
  | { ok: false; errors: Partial<Record<keyof ProfileFields, string>> }

const emptyToNull = (v: FormDataEntryValue | null) => (typeof v === 'string' && v !== '' ? v : null)

/** Read the form's named fields (never a person id) and validate every value against the allowed lists. */
export function parseProfileForm(form: FormData): ProfileParse {
  const raw = {
    life_stage: emptyToNull(form.get('life_stage')),
    available_slots: form.getAll('available_slots').map(String),
    group_pref: emptyToNull(form.get('group_pref')),
    interests: form.getAll('interests').map(String),
    about_me: normalizeAboutMe(typeof form.get('about_me') === 'string' ? (form.get('about_me') as string) : null),
  }
  return parseProfile(raw)
}

export function parseProfile(raw: unknown): ProfileParse {
  const r = ProfileInput.safeParse(raw)
  if (r.success) return { ok: true, value: r.data as ProfileFields }
  const errors: Partial<Record<keyof ProfileFields, string>> = {}
  for (const i of r.error.issues) {
    const k = i.path[0] as keyof ProfileFields
    if (errors[k]) continue
    // enum failures say what was wrong in zod's words; members get a plain sentence instead
    errors[k] = i.code === 'invalid_value' || i.code === 'invalid_type' ? 'Please choose from the options shown.' : i.message
  }
  return { ok: false, errors }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** Names of the profile fields whose values differ. Arrays compare as sets. */
export function changedFields(before: ProfileFields, after: ProfileFields): (keyof ProfileFields)[] {
  const out: (keyof ProfileFields)[] = []
  if (before.life_stage !== after.life_stage) out.push('life_stage')
  if (!sameSet(before.available_slots, after.available_slots)) out.push('available_slots')
  if (before.group_pref !== after.group_pref) out.push('group_pref')
  if (!sameSet(before.interests, after.interests)) out.push('interests')
  if (normalizeAboutMe(before.about_me) !== normalizeAboutMe(after.about_me)) out.push('about_me')
  return out
}
