'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { getRecommendations } from '@/lib/recommendations'
import { requestToJoin } from '@/lib/member'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'

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
