import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AppHeader, PageIntro } from '@/components/app-shell'
import { GroupCard } from '@/components/group-card'
import { withPersona } from '@/lib/db'
import { PERSONAS, findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { peekRecommendations } from '@/lib/recommendations'
import { requestRecommendations } from './actions'

export const dynamic = 'force-dynamic'

type AuditRow = {
  run_id: string; person_id: string; is_current: boolean; generated_at: string; invalidated_at: string | null
  invalidation_reason: string | null; outcome: string; model: string | null; prompt_version: string | null
  confidence: string | null; internal_rationale: string | null; group_id: string | null
  shortlist_position: number | null; score: string | null; rank: number | null
}

const REASONS: Record<string, string> = {
  none: 'No current run for this member yet.',
  no_profile: 'Not eligible: no opted-in profile.',
  in_group: 'Not eligible: already in an active group, so no recommendations.',
}

export default async function RecommendationTestPage({ searchParams }: { searchParams: Promise<{ result?: string; calls?: string }> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona) redirect('/')
  const sp = await searchParams

  // Manager sees the audit; everyone else sees their own current run. Neither path calls the LLM.
  const audit = persona.role === 'manager'
    ? await withPersona(persona.key, async (db) => (await db.query<AuditRow>('select * from app.manager_recommendation_audit()')).rows)
    : null
  const names = audit
    ? Object.fromEntries((await withPersona(persona.key, async (db) =>
        (await db.query<{ group_id: string; name: string }>('select group_id, name from app.group_card()')).rows)).map((g) => [g.group_id, g.name]))
    : {}
  const view = audit ? null : await peekRecommendations(persona.key)

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:px-8 lg:py-16">
        <PageIntro eyebrow="Recommendation test" title="Recommendation lifecycle" description="Slice 1 test page: request, reuse, invalidate, regenerate." />
        <div className="mb-8 rounded-xl border border-dashed border-[#c9a96a] bg-[#fbf6e9] p-4 text-sm text-[#6b5320]" data-testid="debug-badge">
          <p className="mb-2 text-xs font-semibold tracking-[0.14em]">DEMO / DEBUG · SLICE 1 ONLY</p>
          <p>Persona: {persona.display} ({persona.role})</p>
          {sp.result && <p data-testid="last-result">Last request: <strong>{sp.result}</strong> · ranking model attempts this request: <strong>{sp.calls}</strong></p>}
          {view?.status === 'ok' && <p className="font-mono">run {view.runId} · current</p>}
          {view && view.status !== 'ok' && <p>{view.status === 'none' ? REASONS.none : REASONS[view.reason]}</p>}
          <div className="mt-3 flex gap-4">
            {!audit && <form action={requestRecommendations}><button className="rounded-md bg-[#3e644b] px-3 py-1.5 font-medium text-white">Request recommendations</button></form>}
            <Link href="/" className="font-semibold underline underline-offset-4">Switch persona</Link>
            <Link href="/connection-test" className="font-semibold underline underline-offset-4">Connection test</Link>
          </div>
        </div>

        {view?.status === 'ok' && (
          <div className="grid gap-4 md:grid-cols-2">
            {view.groups.map((g) => (
              <GroupCard key={g.group_id} linked={false} group={{
                id: g.group_id, name: g.name, description: g.description, tags: g.tags ?? [],
                slot: g.meeting_slot, area: g.is_online ? 'Online' : g.area_label, openSeats: g.open_seats,
                childcare: g.childcare ? 'Childcare available' : 'No childcare',
              }} />
            ))}
            {view.groups.length === 0 && <p className="text-sm text-[#69736b]">No group fits right now. This empty result is stored and reused until something relevant changes.</p>}
          </div>
        )}

        {audit && (
          <section data-testid="audit">
            <h2 className="mb-3 font-serif text-xl text-[#26382b]">Manager audit: recommendation runs</h2>
            <div className="overflow-x-auto rounded-xl border border-[#e1e8df] bg-white">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#f4f7f2] text-[#55745c]"><tr>
                  <th className="p-2">Member</th><th className="p-2">Run</th><th className="p-2">State</th><th className="p-2">Outcome</th>
                  <th className="p-2">Prompt</th><th className="p-2">Shortlisted group</th><th className="p-2">Score</th><th className="p-2">Rank</th><th className="p-2">Rationale</th>
                </tr></thead>
                <tbody>
                  {audit.map((r, i) => (
                    <tr key={`${r.run_id}-${r.group_id ?? i}`} className="border-t border-[#eef1ec] align-top">
                      <td className="p-2">{PERSONAS.find((p) => p.person_id === r.person_id)?.display ?? r.person_id.slice(0, 8)}</td>
                      <td className="p-2 font-mono">{r.run_id.slice(0, 8)}</td>
                      <td className="p-2">{r.is_current ? 'current' : `invalid: ${r.invalidation_reason}`}</td>
                      <td className="p-2">{r.outcome}</td>
                      <td className="p-2">{r.prompt_version ?? '-'}</td>
                      <td className="p-2">{r.group_id ? `${r.shortlist_position}. ${names[r.group_id] ?? r.group_id.slice(0, 8)}` : '(empty run)'}</td>
                      <td className="p-2">{r.score ?? ''}</td>
                      <td className="p-2">{r.rank ?? ''}</td>
                      <td className="p-2">{r.shortlist_position === 1 || !r.group_id ? r.internal_rationale : ''}</td>
                    </tr>
                  ))}
                  {audit.length === 0 && <tr><td className="p-3" colSpan={9}>No runs yet.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
