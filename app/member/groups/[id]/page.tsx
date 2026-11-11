import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { Check, Heart, MapPin, Users } from 'lucide-react'
import { z } from 'zod'
import { AppHeader, PageIntro, SectionLabel, Tag } from '@/components/app-shell'
import { AskToJoinForm } from '@/components/ask-to-join-form'
import { PersonaChooser } from '@/components/persona-chooser'
import { findPersona, PERSONA_COOKIE } from '@/lib/personas'
import { getGroupCard, getMyRequests } from '@/lib/member'
import { peekRecommendations } from '@/lib/recommendations'
import { slotLabel, tagLabel } from '@/lib/group-view'

export const dynamic = 'force-dynamic'

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-[#e1e8df] bg-white p-6">{children}</div>
}

export default async function GroupDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const persona = findPersona((await cookies()).get(PERSONA_COOKIE)?.value)
  if (!persona || persona.role !== 'member') {
    return <PersonaChooser role="member" label="Member" currentName={persona?.display} />
  }
  const { id } = await params
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

        <div className="mt-5">
          <Card>
            {request ? (
              <>
                <SectionLabel>Request sent</SectionLabel>
                <p className="flex items-center gap-2 font-medium text-[#3e644b]"><Check className="size-4" /> {leader ? `${leader} will reach out if it's a fit.` : "The group leader will reach out if it's a fit."}</p>
                {request.member_note && <p className="mt-4 rounded-xl bg-[#fbfcf8] p-4 text-sm leading-6 text-[#69736b]">Your note: {request.member_note}</p>}
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
