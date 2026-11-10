'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'

// Mock auth only: remember which seeded persona the demo is "logged in" as.
export async function selectPersona(formData: FormData) {
  const key = String(formData.get('personaKey') ?? '')
  if (!findPersona(key)) throw new Error('Unknown persona')
  ;(await cookies()).set(PERSONA_COOKIE, key, { httpOnly: true, sameSite: 'lax', path: '/' })
  redirect(`/${findPersona(key)!.role}`)
}
