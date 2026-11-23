'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { ReviewUnavailableError, runScheduleReview } from '@/lib/review/schedule-review'

/**
 * The Manager explicitly chooses "Run AI review". This is the only thing that calls the review
 * model: a page view, a refresh and a member's join request never do. Anyone who is not the
 * Manager persona is sent back without anything being read or sent to a model.
 */
export async function runAiReview() {
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
