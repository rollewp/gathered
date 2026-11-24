import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { Check, Heart, MapPin, Users } from 'lucide-react'
import { z } from 'zod'
import { AppHeader, PageIntro, SectionLabel, Tag } from '@/components/app-shell'
import { AskToJoinForm } from '@/components/ask-to-join-form'
import { SubmitButton } from '@/components/submit-button'
import { withdrawMyRequest } from '@/app/member/actions'
import { PersonaChooser } from '@/components/persona-chooser'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { getGroupCard, getMyRequests } from '@/lib/member'
import { peekRecommendations } from '@/lib/recommendations'
import { slotLabel, tagLabel } from '@/lib/group-view'

export const dynamic = 'force-dynamic'

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#e1e8df] bg-white p-6">{children}</div>
}

const NOTICES: Record<string, { tone: 'ok' | 'bad'; text: string }> = {
  withdrawn: { tone: 'ok', text: 'Request withdrawn. You can ask to join again whenever you like.' },
  withdraw_stale: { tone: 'ok', text: 'That request was no longer pending, so nothing was changed.' },
  withdraw_failed: { tone: 'bad', text: 'Something went wrong withdrawing your request. Nothing was changed. Please try again.' },
}

export default async function GroupDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string }> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'member') {
    return <PersonaChooser role="member" label="Member" currentName={persona?.display} />
  }
  const { id } = await params
  const notice = NOTICES[String((await searchParams).notice ?? '')] ?? null
  if (!z.uuid().safeParse(id).success) notFound()

  const [group, requests, state] = await Promise.all([
    getGroupCard(persona.key, id),
    getMyRequests(persona.key),
    peekRecommendations(persona.key),
  ])
  if (!group) notFound()

  const request = requests.find((r) => r.group_id === id && r.status === 'requested')
  const eligible = !(state.status === 'ineligible')
  const takingRequests = ['open', 'forming'].includes(group.status) && group.open_seats > 0
  const people = Math.max(0, group.capacity_max - group.open_seats)
  const leader = request?.leader_first_name ?? null

  return (
    <div className="min-h-screen">
      <AppHeader persona="member" name={persona.display} />
      <main className="mx-auto max-w-3xl px-5 py-10 lg:py-16">
        <PageIntro eyebrow="Group" title={group.name} description={group.description} backHref="/member" />
        <div className="grid gap-5 sm:grid-cols-2">
          <Card>
            <SectionLabel>At a glance</SectionLabel>
            <div className="flex flex-col gap-4 text-sm text-[#69736b]">
              <span className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg bg-[#edf4ea]"><MapPin className="size-4 text-[#55745c]" /></span>{group.is_online ? 'Online' : group.area_label}</span>
              <span className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg bg-[#edf4ea]"><Users className="size-4 text-[#55745c]" /></span>{group.open_seats} open {group.open_seats === 1 ? 'seat' : 'seats'} · {people} {people === 1 ? 'person' : 'people'} currently</span>
              <span className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-lg bg-[#edf4ea]"><Heart className="size-4 text-[#55745c]" /></span>{group.childcare ? 'Childcare available' : 'No childcare'}</span>
            </div>
          </Card>
          <Card>
            <SectionLabel>This group is about</SectionLabel>
            <div className="flex flex-wrap gap-2">{(group.tags ?? []).map((t) => <Tag key={t}>{tagLabel(t)}</Tag>)}</div>
            <p className="mt-5 text-sm leading-6 text-[#69736b]">{slotLabel(group.meeting_slot)}{group.frequency ? ` · ${group.frequency}` : ''}</p>
          </Card>
        </div>

        {notice && (
          <p role={notice.tone === 'bad' ? 'alert' : 'status'}
            className={`mt-5 rounded-xl border px-4 py-3 text-sm ${notice.tone === 'bad' ? 'border-[#ecd9d4] bg-[#fbf3f1] text-[#8a3b2e]' : 'border-[#dfebdc] bg-[#f0f6ee] text-[#3e644b]'}`}>{notice.text}</p>
        )}

        <div className="mt-5">
          <Card>
            {request ? (
              <>
                <SectionLabel>Request sent · Pending</SectionLabel>
                <p className="flex items-center gap-2 font-medium text-[#3e644b]"><Check className="size-4" /> {leader ? `${leader} will reach out if it's a fit.` : "The group leader will reach out if it's a fit."}</p>
                {request.member_note && <p className="mt-4 rounded-xl bg-[#fbfcf8] p-4 text-sm leading-6 text-[#69736b]">Your note: {request.member_note}</p>}
                <details className="group mt-5">
                  <summary className="inline-flex h-9 w-full cursor-pointer list-none items-center justify-center rounded-lg border border-[#dce5da] bg-white px-4 text-sm font-medium text-[#3e644b] hover:bg-[#f0f6ee] sm:w-auto [&::-webkit-details-marker]:hidden">Withdraw request</summary>
                  <form action={withdrawMyRequest} className="mt-3 rounded-xl border border-[#eadfcf] bg-[#fffdf9] p-4" aria-label="Confirm withdrawing your request">
                    <input type="hidden" name="requestId" value={request.request_id} />
                    <input type="hidden" name="groupId" value={group.group_id} />
                    <p className="text-sm leading-6 text-[#4a5a4e]">Withdraw your request to join this group? You can ask to join again later. Select <strong>Withdraw request</strong> above to keep it instead.</p>
                    <SubmitButton pendingText="Withdrawing…" className="mt-4 w-full sm:w-auto">Yes, withdraw</SubmitButton>
                  </form>
                </details>
              </>
            ) : !eligible ? (
              <>
                <SectionLabel>Ask to join</SectionLabel>
                <p className="text-sm leading-6 text-[#69736b]">Requests are for members who are looking for a group.</p>
              </>
            ) : !takingRequests ? (
              <>
                <SectionLabel>Ask to join</SectionLabel>
                <p className="text-sm leading-6 text-[#69736b]">This group isn't taking new requests right now.</p>
              </>
            ) : (
              <>
                <SectionLabel>Introduce yourself</SectionLabel>
                <p className="mb-4 text-sm leading-6 text-[#69736b]">A short note helps the leader welcome you well. Share only what feels comfortable.</p>
                <AskToJoinForm groupId={group.group_id} />
              </>
            )}
          </Card>
        </div>
      </main>
    </div>
  )
}
