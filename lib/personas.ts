import raw from '@/seed/out/personas.json'

export type PersonaRole = 'member' | 'leader' | 'manager'
export type PersonaDef = { key: string; person_id: string; display: string; role: PersonaRole; blurb: string }

// Mock auth (W5): personas come from the seeded personas.json, bundled at build time.
export const PERSONAS = raw as PersonaDef[]
export const PERSONA_COOKIE = 'personaKey'

export function findPersona(key: string | undefined): PersonaDef | undefined {
  return PERSONAS.find((p) => p.key === key)
}
