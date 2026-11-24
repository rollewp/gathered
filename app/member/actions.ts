'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getRecommendations } from '@/lib/recommendations'
import { requestToJoin, saveMyProfile, withdrawRequest } from '@/lib/member'
import { parseProfileForm, type ProfileFields } from '@/lib/profile-schema'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { requireDemoAccess } from '@/lib/demo-access'

async function memberPersona() {
  const p = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  return p && p.role === 'member' ? p : null
}

/**
 * The member explicitly asks for their recommendations. Reuses the current run when there is one
 * (zero model calls); otherwise the Slice 1 orchestrator generates and persists a run. Page
 * renders, catalog searches, filters and paging never call this.
 */
export async function requestMyRecommendations() {
  await requireDemoAccess()
  const persona = await memberPersona()
  if (!persona) redirect('/member')
  let notice = ''
  try {
    await getRecommendations(persona.key)
  } catch (e) {
    notice = e instanceof Error && e.name === 'RankingUnavailableError' ? 'unavailable' : 'error'
  }
  redirect(notice ? `/member?notice=${notice}` : '/member?view=recommendations')
}

export type JoinFormState = { error?: string }

const MESSAGES: Record<string, string> = {
  duplicate_request: 'You already have a request open for this group.',
  group_unavailable: "This group isn't taking new requests right now.",
  not_eligible: "We can't take a request from this account right now.",
  note_too_long: 'Please keep your note under 500 characters.',
  error: 'Something went wrong sending your request. Please try again.',
}

const JoinInput = z.object({ groupId: z.uuid(), note: z.string().max(500) })

export async function askToJoin(_prev: JoinFormState, formData: FormData): Promise<JoinFormState> {
  const persona = await memberPersona()
  if (!persona) redirect('/member')
  const parsed = JoinInput.safeParse({ groupId: formData.get('groupId'), note: String(formData.get('note') ?? '') })
  if (!parsed.success) return { error: parsed.error.issues.some((i) => i.path[0] === 'note') ? MESSAGES.note_too_long : MESSAGES.error }
  const res = await requestToJoin(persona.key, parsed.data.groupId, parsed.data.note.trim() || null)
  if (!res.ok && res.code !== 'duplicate_request') return { error: MESSAGES[res.code] }
  // success (or already requested): show the confirmation state, which is read back from the database
  redirect(`/member/groups/${parsed.data.groupId}`)
}

const WithdrawInput = z.object({ requestId: z.uuid(), groupId: z.uuid() })

/**
 * The member confirms withdrawing their own pending request. Who is withdrawing comes from the
 * persona cookie, never the form. No model call. A request that is no longer pending (a repeat
 * submit, another tab) is not an error for the member: the page simply shows its current state.
 */
export async function withdrawMyRequest(formData: FormData) {
  const persona = await memberPersona()
  if (!persona) redirect('/member')
  const parsed = WithdrawInput.safeParse({ requestId: formData.get('requestId'), groupId: formData.get('groupId') })
  if (!parsed.success) redirect('/member')
  const res = await withdrawRequest(persona.key, parsed.data.requestId)
  const notice = res.ok ? 'withdrawn' : res.code === 'error' ? 'withdraw_failed' : 'withdraw_stale'
  redirect(`/member/groups/${parsed.data.groupId}?notice=${notice}`)
}

export type PreferencesFormState = { errors?: Partial<Record<keyof ProfileFields | 'form', string>>; values?: ProfileFields }

/**
 * The member confirms their preferences. Who is saving comes from the persona cookie, never from
 * the form; the form carries only the five editable fields, each validated against the allowed
 * lists. Saving never calls a model. A real change sends the member to Browse Groups, where the
 * database has already marked the saved run out of date; an identical confirmation changes nothing.
 */
export async function savePreferences(_prev: PreferencesFormState, formData: FormData): Promise<PreferencesFormState> {
  const persona = await memberPersona()
  if (!persona) redirect('/member')
  const parsed = parseProfileForm(formData)
  const submitted: ProfileFields = {
    life_stage: String(formData.get('life_stage') ?? '') || null,
    available_slots: formData.getAll('available_slots').map(String),
    group_pref: String(formData.get('group_pref') ?? '') || null,
    interests: formData.getAll('interests').map(String),
    about_me: String(formData.get('about_me') ?? ''),
  }
  if (!parsed.ok) return { errors: parsed.errors, values: submitted }
  const res = await saveMyProfile(persona.key, parsed.value)
  if (!res.ok) {
    return { errors: { form: res.code === 'no_profile' ? "We couldn't find your profile to update." : 'Something went wrong saving your preferences. Nothing was changed. Please try again.' }, values: submitted }
  }
  redirect(res.changed.length > 0 ? '/member?notice=preferences_updated' : '/member?notice=preferences_unchanged')
}
