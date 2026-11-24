import { cookies } from 'next/headers'
import { AlertCircle, BarChart3, Sparkles } from 'lucide-react'
import { AppHeader, PageIntro, RoleBadge, SectionLabel } from '@/components/app-shell'
import { PersonaChooser } from '@/components/persona-chooser'
import { SubmitButton } from '@/components/submit-button'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { getDemandGaps, type DemandGap, type DemandGapSummary } from '@/lib/analytics/demand-gaps'
import { lifeStageLabel, slotLabel } from '@/lib/group-view'
import { listInsights, type InsightRow } from '@/lib/review/schedule-review'
import { resolveAiInsight, runAiReview } from './actions'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined)
const num = (v: string | string[] | undefined) => Math.max(0, Math.min(999, Number.parseInt(one(v) ?? '0', 10) || 0))

function resultLine(sp: SearchParams): { tone: 'ok' | 'bad'; text: string } | null {
  const n = one(sp.notice)
  if (n === 'resolved') return { tone: 'ok', text: 'Insight resolved. It has left this list and stays in history.' }
  if (n === 'resolve_stale') return { tone: 'ok', text: 'That insight was already resolved, so nothing was changed.' }
  if (n === 'resolve_failed') return { tone: 'bad', text: 'Something went wrong resolving the insight. Nothing was changed. Please try again.' }
  const r = one(sp.review)
  if (r === 'unavailable') return { tone: 'bad', text: "We couldn't reach the review assistant just now. Nothing was changed. Please try again in a moment." }
  if (r === 'error') return { tone: 'bad', text: 'Something went wrong running the review. Nothing was changed. Please try again.' }
  if (r !== 'done') return null
  const [c, raised, already, notRaised, invalid] = [num(sp.c), num(sp.r), num(sp.a), num(sp.n), num(sp.i)]
  if (c === 0) return { tone: 'ok', text: 'Reviewed: there are no pending requests with a possible schedule overlap.' }
  const parts = [`${c} pending ${c === 1 ? 'request' : 'requests'} checked`]
  if (raised) parts.push(`${raised} new ${raised === 1 ? 'insight' : 'insights'}`)
  if (already) parts.push(`${already} already reviewed`)
  if (notRaised) parts.push(`${notRaised} with no conflict found`)
  if (invalid) parts.push(`${invalid} the assistant could not answer reliably`)
  return { tone: 'ok', text: `Review finished: ${parts.join(', ')}.` }
}

function Insight({ i }: { i: InsightRow }) {
  const evidence = i.evidence?.model_evidence ?? []
  const status = i.status === 'open' ? 'Needs review' : 'Acknowledged'
  return (
    <article className="rounded-2xl border border-[#eadfcf] bg-[#fffdf9] p-6" aria-label="Potential schedule conflict">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#9a7c4b]">Potential schedule conflict</p>
          <h3 className="mt-2 font-serif text-2xl text-[#26382b]">{i.first_name} {i.last_name} · {i.group_name}</h3>
        </div>
        <AlertCircle className="mt-1 size-5 shrink-0 text-[#9a7c4b]" aria-hidden />
      </div>
      <p className="mt-3 text-sm leading-6 text-[#4a5a4e]">{i.summary}</p>
      <h4 className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-[#718b70]">Evidence</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-[#4a5a4e]">
        {evidence.map((e, k) => <li key={k}>{e}</li>)}
      </ul>
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#69736b]">
        <span className="font-semibold text-[#876f46]">Status: {status}</span>
        {i.request_status && <span>Join request: {i.request_status === 'requested' ? 'still pending' : i.request_status}</span>}
        <span>Advisory only. You decide; nothing has been sent to anyone.</span>
      </div>
      <details className="mt-5">
        <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-[#dce5da] bg-white px-3 text-sm font-medium text-[#3e644b] hover:bg-[#f0f6ee] [&::-webkit-details-marker]:hidden">Resolve insight</summary>
        <form action={resolveAiInsight} className="mt-3 flex flex-col gap-3 rounded-xl border border-[#eadfcf] bg-white p-4 sm:flex-row sm:items-center sm:justify-between" aria-label="Confirm resolving this insight">
          <input type="hidden" name="escalationId" value={i.escalation_id} />
          <p className="text-sm leading-6 text-[#4a5a4e]">Resolve this insight? It leaves this list and stays in history. The request is not changed.</p>
          <SubmitButton pendingText="Resolving…" className="w-full sm:w-auto">Yes, resolve</SubmitButton>
        </form>
      </details>
    </article>
  )
}

const GAP_NOTE: Record<DemandGap['gap_classification'], (g: DemandGap) => string> = {
  'No current group': () => 'No open group meets at this time for this life stage.',
  'High demand': (g) => `About ${g.people_per_open_seat?.toFixed(1)} people for every open seat.`,
  'Limited reach': (g) => `${g.people_without_reachable_group} of ${g.opted_in_ungrouped_count} have no suitable open group within 5 miles.`,
}

function DemandGapCard({ g }: { g: DemandGap }) {
  const stage = lifeStageLabel(g.life_stage) ?? g.life_stage
  return (
    <li className="rounded-2xl border border-[#e1e8df] bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-serif text-xl text-[#26382b]">{stage} · {slotLabel(g.available_slot)}</p>
          <p className="mt-1 text-sm leading-6 text-[#4a5a4e]">{GAP_NOTE[g.gap_classification](g)}</p>
        </div>
        <span className="rounded-full bg-[#f6efe2] px-3 py-1 text-xs font-semibold text-[#876f46]">{g.gap_classification}</span>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3 text-sm">
        <div><dt className="text-xs uppercase tracking-[0.12em] text-[#718b70]">People without a group</dt><dd className="mt-1 text-lg text-[#26382b]">{g.opted_in_ungrouped_count}</dd></div>
        <div><dt className="text-xs uppercase tracking-[0.12em] text-[#718b70]">Open groups</dt><dd className="mt-1 text-lg text-[#26382b]">{g.serving_group_count}</dd></div>
        <div><dt className="text-xs uppercase tracking-[0.12em] text-[#718b70]">Open seats</dt><dd className="mt-1 text-lg text-[#26382b]">{g.available_seat_count}</dd></div>
      </dl>
    </li>
  )
}

function DemandGaps({ d, failed }: { d: DemandGapSummary | null; failed: boolean }) {
  return (
    <section aria-label="Group demand gaps" className="mt-12">
      <div className="mb-3 flex items-center gap-3"><SectionLabel>Group demand gaps</SectionLabel>{d && <RoleBadge>{d.totalGapCohorts}</RoleBadge>}</div>
      <p className="mb-4 flex gap-3 text-sm leading-6 text-[#69736b]">
        <BarChart3 className="mt-1 size-4 shrink-0 text-[#718b70]" aria-hidden />
        <span>Where opted-in adults without a group are concentrated in life-stage and time combinations the current groups serve poorly. Analyzed in Databricks across the whole congregation; only totals are shown.</span>
      </p>
      {failed ? (
        <p role="alert" className="rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">We couldn't load the demand analysis just now. Please try again in a moment.</p>
      ) : !d || d.cohortsAnalyzed === 0 ? (
        <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 text-sm leading-6 text-[#69736b]">The demand analysis has not been loaded yet. It is produced by the scheduled Databricks refresh.</div>
      ) : d.gaps.length === 0 ? (
        <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 text-sm leading-6 text-[#69736b]">No cohort is poorly served right now ({d.cohortsAnalyzed} life-stage and time combinations checked).</div>
      ) : (
        <>
          <ul className="flex flex-col gap-3">{d.gaps.map((g) => <DemandGapCard key={`${g.life_stage}|${g.available_slot}`} g={g} />)}</ul>
          <p className="mt-3 text-xs leading-5 text-[#69736b]">
            Top {d.gaps.length} of {d.totalGapCohorts} gaps, from {d.cohortsAnalyzed} life-stage and time combinations{d.asOf ? `, engagement data through ${d.asOf}` : ''}. A person who is free at several times is counted in each, so rows are not additive.
          </p>
        </>
      )}
    </section>
  )
}

export default async function ManagerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'manager') return <PersonaChooser role="manager" label="Manager" currentName={persona?.display} />
  const sp = await searchParams
  const line = resultLine(sp)

  let insights: InsightRow[] = []
  let failed = false
  try { insights = await listInsights(persona.key) } catch { failed = true } // never show a database error to the Manager
  let demand: DemandGapSummary | null = null
  let demandFailed = false
  try { demand = await getDemandGaps(persona.key) } catch { demandFailed = true }

  return (
    <div className="min-h-screen">
      <AppHeader persona="manager" name={persona.display} />
      <main className="mx-auto max-w-4xl px-5 py-10 lg:px-8 lg:py-16">
        <PageIntro eyebrow="Manager" title="Insights requiring review"
          description="Run a review and Gathered checks pending group requests for practical conflicts that the structured data alone does not show. It only suggests; you decide." />

        <div className="mb-8 flex flex-col gap-5 rounded-2xl border border-[#dfebdc] bg-[#f0f6ee] p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex gap-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-white text-[#55745c]"><Sparkles className="size-5" aria-hidden /></span>
            <div>
              <p className="font-medium text-[#3e644b]">AI review</p>
              <p className="mt-1 text-sm leading-6 text-[#69736b]">Reviews run only when you ask. Nothing changes for members or leaders, and nobody is contacted.</p>
            </div>
          </div>
          <form action={runAiReview}>
            <SubmitButton pendingText="Reviewing requests…" className="w-full sm:w-auto">Run AI review</SubmitButton>
          </form>
        </div>

        {line && (
          <p role={line.tone === 'bad' ? 'alert' : 'status'}
            className={`mb-6 rounded-xl border px-4 py-3 text-sm ${line.tone === 'bad' ? 'border-[#ecd9d4] bg-[#fbf3f1] text-[#8a3b2e]' : 'border-[#dfebdc] bg-[#f0f6ee] text-[#3e644b]'}`}>{line.text}</p>
        )}

        <section aria-label="Insights">
          <div className="mb-3 flex items-center gap-3"><SectionLabel>Insights requiring review</SectionLabel><RoleBadge>{insights.length}</RoleBadge></div>
          {failed ? (
            <p role="alert" className="rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">We couldn't load the insights just now. Please try again in a moment.</p>
          ) : insights.length === 0 ? (
            <div className="rounded-2xl border border-[#e1e8df] bg-white p-6 text-sm leading-6 text-[#69736b]">No insights yet. Choose <strong>Run AI review</strong> to check the pending requests.</div>
          ) : (
            <div className="flex flex-col gap-4">{insights.map((i) => <Insight key={i.escalation_id} i={i} />)}</div>
          )}
        </section>

        <DemandGaps d={demand} failed={demandFailed} />
      </main>
    </div>
  )
}
