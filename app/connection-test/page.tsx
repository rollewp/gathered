import Link from 'next/link'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { AppHeader, PageIntro } from '@/components/app-shell'
import { GroupCard } from '@/components/group-card'
import { withPersona } from '@/lib/db'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'

export const dynamic = 'force-dynamic'

type CardRow = {
  group_id: string; name: string; description: string; meeting_slot: string; is_online: boolean
  childcare: boolean; tags: string[] | null; open_seats: number; area_label: string
}

export default async function ConnectionTestPage() {
  const key = (await cookies()).get(PERSONA_COOKIE)?.value
  const persona = findPersona(key)
  if (!persona) redirect('/')

  const t0 = Date.now()
  const { ctx, cards } = await withPersona(persona.key, async (db) => {
    // Effective database context, read back from the same transaction that serves the cards.
    const ctx = (await db.query<{ db_user: string; role: string; person_id: string }>(
      "select current_user as db_user, current_setting('app.role', true) as role, current_setting('app.person_id', true) as person_id",
    )).rows[0]
    const cards = (await db.query<CardRow>('select * from app.group_card()')).rows
    return { ctx, cards }
  })
  const ms = Date.now() - t0

  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-6xl px-5 py-10 lg:px-8 lg:py-16">
        <PageIntro eyebrow="Connection test" title="Public group cards" description="Read from the database through the selected persona's request context." />
        <div className="mb-8 rounded-xl border border-dashed border-[#c9a96a] bg-[#fbf6e9] p-4 text-sm text-[#6b5320]" data-testid="debug-badge">
          <p className="mb-2 text-xs font-semibold tracking-[0.14em]">DEMO / DEBUG · SLICE 0 ONLY</p>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt>Persona</dt><dd>{persona.display}</dd>
            <dt>current_user</dt><dd className="font-mono">{ctx.db_user}</dd>
            <dt>app.role</dt><dd className="font-mono">{ctx.role}</dd>
            <dt>app.person_id</dt><dd className="font-mono">{ctx.person_id || '(empty)'}</dd>
            <dt>Cards returned</dt><dd className="font-mono">{cards.length} · {ms} ms</dd>
          </dl>
          <Link href="/" className="mt-3 inline-block font-semibold underline underline-offset-4">Switch persona</Link>
          <Link href="/recommendation-test" className="mt-3 ml-4 inline-block font-semibold underline underline-offset-4">Recommendation test</Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {cards.map((c) => (
            <GroupCard
              key={c.group_id}
              linked={false}
              group={{
                id: c.group_id, name: c.name, description: c.description, tags: c.tags ?? [],
                slot: c.meeting_slot, area: c.is_online ? 'Online' : c.area_label, openSeats: c.open_seats,
                childcare: c.childcare ? 'Childcare available' : 'No childcare',
              }}
            />
          ))}
        </div>
      </main>
    </div>
  )
}
