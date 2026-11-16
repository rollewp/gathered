import Link from 'next/link'
import { cookies } from 'next/headers'
import { AppHeader, PageIntro } from '@/components/app-shell'
import { PersonaChooser } from '@/components/persona-chooser'
import { PreferencesForm } from '@/components/preferences-form'
import { getMyPreferences, type MyPreferences } from '@/lib/member'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'

export const dynamic = 'force-dynamic'

/**
 * /member/intake. A member with a confirmed profile edits it here ("Your preferences"). The route
 * is kept for Journey 2: a member with no profile will describe themselves in free text here and
 * confirm what is proposed. That AI-assisted step is not built yet, so nothing is faked.
 */
export default async function IntakePage() {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'member') return <PersonaChooser role="member" label="Member" currentName={persona?.display} />

  let prefs: MyPreferences | null = null
  let failed = false
  try { prefs = await getMyPreferences(persona.key) } catch { failed = true }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen">
      <AppHeader persona="member" name={persona.display} />
      <main className="mx-auto max-w-3xl px-5 py-10 lg:py-16">{children}</main>
    </div>
  )

  if (failed) {
    return shell(<>
      <PageIntro eyebrow="Member home" title="Your preferences" backHref="/member" />
      <p role="alert" className="rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">We couldn't load your preferences just now. Nothing was changed. Please try again in a moment.</p>
    </>)
  }

  if (!prefs) {
    return shell(<>
      <PageIntro eyebrow="Member intake" title="A little about you" description="Describing yourself in your own words is the next step we are building. It is not available in this demo yet." backHref="/member" />
      <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 text-sm leading-6 text-[#69736b] sm:p-8">
        Nothing has been saved. <Link href="/member" className="font-semibold text-[#55745c] underline underline-offset-4">Back to your home page</Link>
      </div>
    </>)
  }

  return shell(<>
    <PageIntro
      eyebrow="Member home"
      title="Your preferences"
      description="These help Gathered narrow the catalog and compare group descriptions. Nothing changes until you save."
      backHref="/member"
    />
    <PreferencesForm initial={{
      life_stage: prefs.life_stage, available_slots: prefs.available_slots ?? [], group_pref: prefs.group_pref,
      interests: prefs.interests ?? [], about_me: prefs.about_me,
    }} />
  </>)
}
