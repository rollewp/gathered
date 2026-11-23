import { cookies } from 'next/headers'
import { AlertCircle, Sparkles } from 'lucide-react'
import { AppHeader, PageIntro, RoleBadge, SectionLabel } from '@/components/app-shell'
import { PersonaChooser } from '@/components/persona-chooser'
import { SubmitButton } from '@/components/submit-button'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { listInsights, type InsightRow } from '@/lib/review/schedule-review'
import { runAiReview } from './actions'

export const dynamic = 'force-dynamic'

type SearchParams = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined)
const num = (v: string | string[] | undefined) => Math.max(0, Math.min(999, Number.parseInt(one(v) ?? '0', 10) || 0))

function resultLine(sp: SearchParams): { tone: 'ok' | 'bad'; text: string } | null {
  const r = one(sp.review)
  if (r === 'unavailable') return { tone: 'bad', text: "We couldn't reach the review assistant just now. Nothing was changed. Please try again in a moment." }
  if (r === 'error') return { tone: 'bad', text: 'Something went wrong running the review. Nothing was changed. Please try again.' }
  if (r !== 'done') return null
  const [c, raised, already, notRaised, invalid] = [num(sp.c), num(sp.r), num(sp.a), num(sp.n), num(sp.i)]
  if (c === 0) return { tone: 'ok', text: 'Reviewed: there are no pending requests with a possible schedule overlap.' }
  const parts = [`${c} pending ${c === 1 ? 'request' : 'requests'} checked`]
  if (raised) parts.push(`${raised} new ${raised === 1 ? 'insight' : 'insights'}`)
  if (already) parts.push(`${already} already on this page`)
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
    </article>
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
      </main>
    </div>
  )
}
