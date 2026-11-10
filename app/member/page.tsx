import Link from 'next/link'
import { cookies } from 'next/headers'
import { ArrowRight, ClipboardList, Sparkles } from 'lucide-react'
import { AppHeader, PageIntro, SectionLabel } from '@/components/app-shell'
import { GroupCard } from '@/components/group-card'
import { PersonaChooser } from '@/components/persona-chooser'
import { SubmitButton } from '@/components/submit-button'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { peekRecommendations } from '@/lib/recommendations'
import { getMyPreferences, getMyRequests } from '@/lib/member'
import { groupPrefLabel, lifeStageLabel, slotLabel, tagLabel, toGroupView } from '@/lib/group-view'
import { requestMyRecommendations } from './actions'

export const dynamic = 'force-dynamic'

const NOTICES: Record<string, string> = {
  unavailable: "We couldn't reach our matching assistant just now. Nothing was changed. Please try again in a moment.",
  error: 'Something went wrong finding groups for you. Please try again.',
}

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 sm:p-8">{children}</div>
}

export default async function MemberPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'member') {
    return <PersonaChooser role="member" label="Member" currentName={persona?.display} />
  }
  const { notice } = await searchParams

  // Reading only: opening this page never generates recommendations or calls the model.
  const [view, requests, prefs] = await Promise.all([
    peekRecommendations(persona.key),
    getMyRequests(persona.key),
    getMyPreferences(persona.key),
  ])
  const pendingGroupIds = new Set(requests.filter((r) => r.status === 'requested').map((r) => r.group_id))
  const pending = requests.filter((r) => r.status === 'requested')

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen">
      <AppHeader persona="member" name={persona.display} />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:px-8 lg:py-16">{children}</main>
    </div>
  )

  if (view.status === 'ineligible' && view.reason === 'no_profile') {
    return shell(<>
      <PageIntro eyebrow="Member home" title="Let's get to know you" description="Tell us a little about you and when you're free, and we'll suggest groups to consider." />
      <Panel>
        <Link href="/member/intake" className="inline-flex items-center gap-2 text-sm font-semibold text-[#55745c]">Start with a few words about you <ArrowRight className="size-4" /></Link>
      </Panel>
    </>)
  }

  if (view.status === 'ineligible') {
    return shell(<>
      <PageIntro eyebrow="Member home" title="You're part of a group" description="Recommendations are for members who are looking for a group, so there is nothing to suggest right now." />
    </>)
  }

  const heading = <PageIntro eyebrow="Member home" title="Groups that might fit you" description="A few groups that may be a good place to begin. Take a look, and ask to join the one that feels right. You decide." />
  const noticeBox = notice && NOTICES[notice] && (
    <p role="alert" className="mb-6 rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">{NOTICES[notice]}</p>
  )

  if (view.status === 'none') {
    return shell(<>
      {heading}
      {noticeBox}
      <Panel>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#edf4ea] text-[#55745c]"><Sparkles className="size-5" /></span>
            <div>
              <p className="font-medium text-[#3e644b]">Ready when you are</p>
              <p className="mt-1 text-sm leading-6 text-[#69736b]">We'll look at the groups that are open to new people and suggest a few to consider. This usually takes a few seconds.</p>
            </div>
          </div>
          <form action={requestMyRecommendations}>
            <SubmitButton pendingText="Finding groups for you…">Show me groups</SubmitButton>
          </form>
        </div>
      </Panel>
    </>)
  }

  const groups = view.groups.map(toGroupView)
  const prefLine = prefs
    ? [lifeStageLabel(prefs.life_stage), prefs.group_pref ? `${groupPrefLabel(prefs.group_pref)} group` : null,
       prefs.available_slots?.length ? prefs.available_slots.map(slotLabel).join(', ') : null,
       prefs.interests?.length ? prefs.interests.map(tagLabel).join(', ') : null].filter(Boolean).join(' · ')
    : ''

  return shell(<>
    {heading}
    {noticeBox}
    {prefs && (
      <div className="mb-10 flex flex-col justify-between gap-4 rounded-2xl border border-[#dfebdc] bg-[#f0f6ee] p-5 sm:flex-row sm:items-center">
        <div className="flex gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-[#55745c]"><Sparkles className="size-5" /></span>
          <div>
            <p className="font-medium text-[#3e644b]">Your preferences are ready</p>
            <p className="mt-1 text-sm text-[#69736b]">We use these to find groups that are open and meet when you're free.</p>
          </div>
        </div>
        <Link href="/member/intake" className="flex items-center gap-2 text-sm font-semibold text-[#55745c]">Review preferences <ArrowRight className="size-4" /></Link>
      </div>
    )}
    <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
      <section>
        <SectionLabel>Recommended for you</SectionLabel>
        {groups.length === 0 ? (
          <Panel>
            <p className="font-medium text-[#3e644b]">No group fits your mornings yet. We've let our groups pastor know.</p>
          </Panel>
        ) : (
          <div className="grid gap-4">
            {groups.map((g) => <GroupCard key={g.id} group={g} requested={pendingGroupIds.has(g.id)} />)}
          </div>
        )}
      </section>
      <aside className="flex h-fit flex-col gap-5">
        {pending.length > 0 && (
          <div className="rounded-2xl border border-[#e1e8df] bg-white p-5">
            <SectionLabel>Your requests</SectionLabel>
            <ul className="flex flex-col gap-3 text-sm text-[#69736b]">
              {pending.map((r) => (
                <li key={r.request_id}>
                  <Link href={`/member/groups/${r.group_id}`} className="font-medium text-[#36463b] underline-offset-4 hover:underline">{r.group_name ?? 'Group'}</Link>
                  <span className="block">{r.leader_first_name ? `${r.leader_first_name} will reach out if it's a fit.` : "A leader will reach out if it's a fit."}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {prefs && (
          <div className="rounded-2xl border border-[#e1e8df] bg-white p-5">
            <ClipboardList className="size-5 text-[#789277]" />
            <h2 className="mt-4 font-serif text-xl text-[#26382b]">Your preferences</h2>
            <p className="mt-2 text-sm leading-6 text-[#69736b]">{prefLine || 'None added yet.'}</p>
            <Link href="/member/intake" className="mt-5 inline-block text-sm font-semibold text-[#55745c] underline underline-offset-4">Edit intake</Link>
          </div>
        )}
      </aside>
    </div>
  </>)
}
