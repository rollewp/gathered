import Link from 'next/link'
import { cookies } from 'next/headers'
import { ArrowLeft, ArrowRight, ClipboardList, Sparkles } from 'lucide-react'
import { AppHeader, PageIntro, SectionLabel } from '@/components/app-shell'
import { CatalogFilterForm, CatalogPagination } from '@/components/catalog-controls'
import { GroupCard } from '@/components/group-card'
import { PersonaChooser } from '@/components/persona-chooser'
import { SubmitButton } from '@/components/submit-button'
import { getCatalogPage, type CatalogPage } from '@/lib/catalog'
import { hasActiveFilters, parseCatalogParams } from '@/lib/catalog-params'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { peekRecommendations } from '@/lib/recommendations'
import { getMyPreferences, getMyRequests } from '@/lib/member'
import { groupPrefLabel, lifeStageLabel, slotLabel, tagLabel, toGroupView } from '@/lib/group-view'
import { requestMyRecommendations } from '../actions'

export const dynamic = 'force-dynamic'

const NOTICES: Record<string, string> = {
  unavailable: "We couldn't reach our matching assistant just now. Nothing was changed. Please try again in a moment.",
  error: 'Something went wrong finding groups for you. Please try again.',
}

const COUNT_WORDS = ['No', 'One', 'Two', 'Three']

function Panel({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 sm:p-8">{children}</div>
}

type SearchParams = Record<string, string | string[] | undefined>

export default async function MemberPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'member') {
    return <PersonaChooser role="member" label="Member" currentName={persona?.display} />
  }
  const sp = await searchParams
  const notice = typeof sp.notice === 'string' ? sp.notice : undefined

  // Reading only: opening this page, searching, filtering and paging never generate
  // recommendations or call the model. Only the "Find my best matches" form does.
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

  const noticeBox = notice && NOTICES[notice] && (
    <p role="alert" className="mb-6 rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">{NOTICES[notice]}</p>
  )

  const prefLine = prefs
    ? [lifeStageLabel(prefs.life_stage), prefs.group_pref ? `${groupPrefLabel(prefs.group_pref)} group` : null,
       prefs.available_slots?.length ? prefs.available_slots.map(slotLabel).join(', ') : null,
       prefs.interests?.length ? prefs.interests.map(tagLabel).join(', ') : null].filter(Boolean).join(' · ')
    : ''

  const aside = (
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
  )

  // ---- Recommendations: only when the member has a saved run and asked to see it ----
  if (sp.view === 'recommendations' && view.status === 'ok') {
    const groups = view.groups.slice(0, 3).map(toGroupView)
    return shell(<>
      <PageIntro
        eyebrow="Member home"
        title={groups.length === 0 ? 'No groups to suggest yet' : `${COUNT_WORDS[groups.length]} ${groups.length === 1 ? 'group' : 'groups'} selected for you`}
        description={groups.length === 0 ? undefined : 'Explore these options and decide what feels right. You decide.'}
      />
      {noticeBox}
      <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
        <section aria-label="Your recommended groups">
          {groups.length === 0 ? (
            <Panel>
              <p className="font-medium text-[#3e644b]">No group fits your mornings yet. We've let our groups pastor know.</p>
            </Panel>
          ) : (
            <div className="grid gap-4">
              {groups.map((g) => <GroupCard key={g.id} group={g} requested={pendingGroupIds.has(g.id)} />)}
            </div>
          )}
          <Link href="/member" className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-[#55745c] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]">
            <ArrowLeft className="size-4" aria-hidden /> Browse all groups
          </Link>
        </section>
        {aside}
      </div>
    </>)
  }

  // ---- Browse Groups: the default view for an eligible member who is not in a group ----
  const params = parseCatalogParams(sp)
  let catalog: CatalogPage | null = null
  let catalogFailed = false
  try {
    catalog = await getCatalogPage(persona.key, params)
  } catch {
    catalogFailed = true // never surface the database error to a member
  }
  const filtered = hasActiveFilters(params)
  const first = catalog && catalog.matching > 0 ? (catalog.page - 1) * catalog.pageSize + 1 : 0
  const last = catalog ? Math.min(catalog.matching, catalog.page * catalog.pageSize) : 0
  const hasSaved = view.status === 'ok'

  return shell(<>
    <PageIntro
      eyebrow="Member home"
      title="Find your group"
      description={`${catalog ? `${catalog.total} ${catalog.total === 1 ? 'group meets' : 'groups meet'}` : 'Groups meet'} throughout the week, online, and across the Winter Garden area. Browse them all, or let us narrow it down. You decide.`}
    />
    {noticeBox}

    <div className="mb-8 flex flex-col gap-5 rounded-2xl border border-[#dfebdc] bg-[#f0f6ee] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
      <div className="flex gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-[#55745c]"><Sparkles className="size-5" aria-hidden /></span>
        <div>
          <p className="font-medium text-[#3e644b]">{hasSaved ? 'Your matches are saved' : 'Not sure where to start?'}</p>
          <p className="mt-1 text-sm leading-6 text-[#69736b]">
            {hasSaved
              ? 'Pick up where you left off, or keep browsing below.'
              : "We'll look at the groups that are open to new people and suggest a few to consider. This usually takes a few seconds."}
          </p>
        </div>
      </div>
      {hasSaved ? (
        <Link href="/member?view=recommendations" className="inline-flex items-center justify-center gap-2 rounded-md bg-[#3e644b] px-4 py-2 text-sm font-medium text-white hover:bg-[#315239] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]">
          View my best matches <ArrowRight className="size-4" aria-hidden />
        </Link>
      ) : (
        <form action={requestMyRecommendations}>
          <SubmitButton pendingText="Finding groups for you…" className="w-full sm:w-auto">Find my best matches</SubmitButton>
        </form>
      )}
    </div>

    <div className="grid gap-10 lg:grid-cols-[1fr_280px]">
      <section aria-label="Browse groups">
        {catalogFailed || !catalog ? (
          <p role="alert" className="rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">
            We couldn't load the groups just now. Nothing was changed. Please try again in a moment.
          </p>
        ) : catalog.total === 0 ? (
          <Panel><p className="font-medium text-[#3e644b]">There are no groups to browse yet. Please check back soon.</p></Panel>
        ) : (
          <>
            <CatalogFilterForm filters={params} />
            {params.ignored && (
              <p role="note" className="mt-4 text-sm text-[#876f46]">Some of the search options in the address weren't recognised, so they were ignored.</p>
            )}
            <p role="status" aria-live="polite" className="mb-4 mt-6 text-sm text-[#69736b]">
              {catalog.matching === 0
                ? 'No groups match.'
                : <>Showing {first}–{last} of {catalog.matching} {filtered ? 'matching groups' : catalog.matching === 1 ? 'group' : 'groups'}{filtered ? ` (${catalog.total} in all)` : ''}</>}
            </p>
            {catalog.matching === 0 ? (
              <Panel>
                <p className="font-medium text-[#3e644b]">No groups match those filters.</p>
                <p className="mt-2 text-sm leading-6 text-[#69736b]">Try fewer filters or a different word, or <Link href="/member" className="font-semibold text-[#55745c] underline underline-offset-4">clear them all</Link>.</p>
              </Panel>
            ) : (
              <div className="grid gap-4 md:grid-cols-2">
                {catalog.groups.map((g) => <GroupCard key={g.group_id} group={toGroupView(g)} requested={pendingGroupIds.has(g.group_id)} />)}
              </div>
            )}
            <CatalogPagination filters={params} page={catalog.page} pageSize={catalog.pageSize} pageCount={catalog.pageCount} />
          </>
        )}
      </section>
      {aside}
    </div>
  </>)
}
