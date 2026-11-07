'use client'

import Link from 'next/link'
import { ArrowLeft, ArrowRight, ClipboardCheck, Leaf, Menu, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'

export type Persona = 'member' | 'leader' | 'manager'

const personaMeta = {
  member: { label: 'Member', href: '/member' },
  leader: { label: 'Leader', href: '/leader' },
  manager: { label: 'Manager', href: '/manager' },
}

export function DemoBanner() {
  return <div className="border-b border-[#d9e2d8] bg-[#eef4ed] px-4 py-2 text-center text-xs text-[#54705b]">Showcase Demonstration · AI-powered Recommendations with Guardrails</div>
}

export function AppHeader({ persona }: { persona?: Persona }) {
  return (
    <>
      <DemoBanner />
      <header className="border-b border-[#e6e8e2] bg-[#fbfcf8]/95">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-5 lg:px-8">
          <Link href="/" className="flex items-center gap-2.5 text-[#26382b]">
            <span className="flex size-8 items-center justify-center rounded-full bg-[#dcead9]"><Leaf className="size-4" /></span>
            <span className="font-serif text-xl font-semibold tracking-tight">Gathered</span>
          </Link>
          <div className="flex items-center gap-3">
            {persona && <span className="hidden text-sm text-[#69736b] sm:inline">Viewing as <strong className="font-medium text-[#36463b]">{personaMeta[persona].label}</strong></span>}
            <Link href="/" className="text-sm font-medium text-[#647267] underline-offset-4 hover:text-[#26382b] hover:underline">Switch persona</Link>
            <button className="rounded-md p-2 text-[#647267] sm:hidden" aria-label="Open menu"><Menu className="size-5" /></button>
          </div>
        </div>
      </header>
    </>
  )
}

export function PageIntro({ eyebrow, title, description, backHref }: { eyebrow?: string; title: string; description?: string; backHref?: string }) {
  return <div className="mb-8 flex items-start gap-4">
    {backHref && <Link href={backHref} className="mt-1 rounded-full p-2 text-[#718074] hover:bg-[#eef4ed]" aria-label="Go back"><ArrowLeft className="size-4" /></Link>}
    <div><div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-[#718b70]">{eyebrow}</div><h1 className="font-serif text-4xl leading-tight text-[#26382b] sm:text-5xl">{title}</h1>{description && <p className="mt-3 max-w-2xl text-base leading-7 text-[#69736b]">{description}</p>}</div>
  </div>
}

export function RoleBadge({ children }: { children: React.ReactNode }) { return <span className="inline-flex items-center rounded-full bg-[#edf2eb] px-2.5 py-1 text-xs font-semibold text-[#54705b]">{children}</span> }
export function Tag({ children }: { children: React.ReactNode }) { return <span className="rounded-full border border-[#dce5da] bg-white px-2.5 py-1 text-xs text-[#647267]">{children}</span> }
export function SectionLabel({ children }: { children: React.ReactNode }) { return <h2 className="mb-3 text-xs font-semibold uppercase tracking-[0.16em] text-[#718b70]">{children}</h2> }
export function AccentIcon({ children }: { children: React.ReactNode }) { return <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#edf4ea] text-[#55745c]">{children}</span> }
export { ArrowRight, ClipboardCheck, Sparkles }
