'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { z } from 'zod'
import { requireDemoAccess } from '@/lib/demo-access'
import { ReviewUnavailableError, resolveInsight, runScheduleReview } from '@/lib/review/schedule-review'

/**
 * The Manager explicitly chooses "Run AI review". This is the only thing that calls the review
 * model: a page view, a refresh and a member's join request never do. Anyone who is not the
 * Manager persona is sent back without anything being read or sent to a model.
 */
export async function runAiReview() {
  await requireDemoAccess()
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'manager') redirect('/manager')
  let query = ''
  try {
    const s = await runScheduleReview(persona.key)
    query = `?review=done&c=${s.candidates}&r=${s.raised}&a=${s.alreadyRaised}&n=${s.notRaised}&i=${s.invalid}`
  } catch (e) {
    query = e instanceof ReviewUnavailableError ? '?review=unavailable' : '?review=error'
  }
  redirect(`/manager${query}`)
}

/**
 * The Manager confirms resolving one insight. Only the Manager persona can reach the write (the
 * database policy also allows only the Manager to update an escalation). No model call; the join
 * request and everything else are left exactly as they were.
 */
export async function resolveAiInsight(formData: FormData) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'manager') redirect('/manager')
  const id = z.uuid().safeParse(formData.get('escalationId'))
  if (!id.success) redirect('/manager')
  let notice = 'resolved'
  try {
    const r = await resolveInsight(persona.key, id.data)
    if (!r.ok) notice = 'resolve_stale'
  } catch {
    notice = 'resolve_failed'
  }
  redirect(`/manager?notice=${notice}`)
}
