import { AppHeader, PageIntro } from '@/components/app-shell'
import { selectPersona } from '@/app/actions'
import { PERSONAS, type PersonaRole } from '@/lib/personas'

/** Mock-auth chooser for one role, shown when no persona of that role is selected. */
export function PersonaChooser({ role, label, currentName }: { role: PersonaRole; label: string; currentName?: string }) {
  const options = PERSONAS.filter((p) => p.role === role)
  return (
    <div className="min-h-screen">
      <AppHeader />
      <main className="mx-auto max-w-3xl px-5 py-10 lg:py-16">
        <PageIntro eyebrow="Choose a persona" title={`Continue as a ${label.toLowerCase()}`}
          description={currentName ? `You're currently viewing as ${currentName}. Choose a ${label.toLowerCase()} to continue.` : 'This is a guided demo with fictional people. Choose who to continue as.'} />
        <form action={selectPersona} className="grid gap-3 sm:grid-cols-2">
          {options.map((p) => (
            <button key={p.key} type="submit" name="personaKey" value={p.key}
              className="rounded-2xl border border-[#e1e8df] bg-white p-5 text-left shadow-[0_8px_30px_-24px_rgba(39,63,45,.35)] transition hover:-translate-y-0.5 hover:border-[#b5cbb5]">
              <span className="font-serif text-xl text-[#26382b]">{p.display}</span>
              <span className="mt-1 block text-sm leading-6 text-[#69736b]">{p.blurb}</span>
            </button>
          ))}
        </form>
      </main>
    </div>
  )
}
