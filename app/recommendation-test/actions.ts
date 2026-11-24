'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { getRecommendations } from '@/lib/recommendations'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { requireDemoAccess } from '@/lib/demo-access'

// Slice 1 test action: an eligible member explicitly asks for recommendations. Rendering the
// page never calls this; only the button does.
export async function requestRecommendations() {
  await requireDemoAccess()
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona) redirect('/')
  const result = await getRecommendations(persona.key)
  const q = new URLSearchParams({ result: result.status === 'ok' ? result.source : result.reason, calls: String(result.llmAttempts) })
  redirect(`/recommendation-test?${q}`)
}
