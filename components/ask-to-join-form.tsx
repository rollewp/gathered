'use client'
import { useActionState } from 'react'
import { askToJoin, type JoinFormState } from '@/app/member/actions'
import { SubmitButton } from '@/components/submit-button'

export function AskToJoinForm({ groupId }: { groupId: string }) {
  const [state, action] = useActionState<JoinFormState, FormData>(askToJoin, {})
  return (
    <form action={action}>
      <input type="hidden" name="groupId" value={groupId} />
      <label htmlFor="note" className="sr-only">A short note to the group leader (optional)</label>
      <textarea
        id="note" name="note" maxLength={500}
        placeholder="Optional. Share only what feels comfortable."
        className="min-h-28 w-full rounded-xl border border-[#dce5da] bg-[#fbfcf8] p-4 text-sm outline-none focus:ring-2 focus:ring-[#9eb99f]"
      />
      {state.error && <p role="alert" className="mt-3 text-sm text-[#8a3b2e]">{state.error}</p>}
      <SubmitButton pendingText="Sending…" className="mt-5 w-full sm:w-auto">Ask to join</SubmitButton>
    </form>
  )
}
