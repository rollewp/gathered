'use client'
import { useActionState } from 'react'
import Link from 'next/link'
import { SectionLabel } from '@/components/app-shell'
import { SubmitButton } from '@/components/submit-button'
import { groupPrefLabel, lifeStageLabel, slotLabel, tagLabel } from '@/lib/group-view'
import { ABOUT_ME_MAX, GROUP_PREFS, INTERESTS, LIFE_STAGES, SLOTS, type ProfileFields } from '@/lib/profile-schema'
import { savePreferences, type PreferencesFormState } from '@/app/member/actions'

const field = 'rounded-xl border border-[#dce5da] bg-[#fbfcf8] text-sm text-[#26382b] outline-none ring-[#9eb99f] focus:ring-2'
const choice = 'flex items-center gap-2 rounded-lg border border-[#e1e8df] bg-white px-3 py-2 text-sm text-[#36463b] has-[:checked]:border-[#9eb99f] has-[:checked]:bg-[#f0f6ee] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[#9eb99f]'

function Err({ id, children }: { id: string; children?: string }) {
  return children ? <p id={id} role="alert" className="mt-2 text-sm text-[#8a3b2e]">{children}</p> : null
}

/** Every control starts from the member's stored profile; nothing is saved until "Save preferences". */
export function PreferencesForm({ initial }: { initial: ProfileFields }) {
  const [state, action] = useActionState<PreferencesFormState, FormData>(savePreferences, {})
  const v = state.values ?? initial
  const e = state.errors ?? {}
  // remount after a failed save so the inputs show what the member submitted
  const key = state.values ? 'submitted' : 'stored'
  return (
    <form action={action} key={key} className="rounded-2xl border border-[#e1e8df] bg-white p-5 sm:p-8">
      {e.form && <p role="alert" className="mb-6 rounded-xl border border-[#ecd9d4] bg-[#fbf3f1] px-4 py-3 text-sm text-[#8a3b2e]">{e.form}</p>}

      <fieldset>
        <legend><SectionLabel>Where you are in life</SectionLabel></legend>
        <label htmlFor="life_stage" className="sr-only">Life stage</label>
        <select id="life_stage" name="life_stage" defaultValue={v.life_stage ?? ''} aria-describedby={e.life_stage ? 'err-life' : undefined} className={`${field} h-11 w-full px-3 sm:w-72`}>
          <option value="">Prefer not to say</option>
          {LIFE_STAGES.map((s) => <option key={s} value={s}>{lifeStageLabel(s)}</option>)}
        </select>
        <Err id="err-life">{e.life_stage}</Err>
      </fieldset>

      <fieldset className="mt-8" aria-describedby={e.available_slots ? 'err-slots' : undefined}>
        <legend><SectionLabel>Times you could meet</SectionLabel></legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {SLOTS.map((s) => (
            <label key={s} className={choice}>
              <input type="checkbox" name="available_slots" value={s} defaultChecked={v.available_slots.includes(s)} className="size-4 accent-[#3e644b]" />
              {slotLabel(s)}
            </label>
          ))}
        </div>
        <Err id="err-slots">{e.available_slots}</Err>
      </fieldset>

      <fieldset className="mt-8">
        <legend><SectionLabel>The kind of group you would like</SectionLabel></legend>
        <label htmlFor="group_pref" className="sr-only">Group preference</label>
        <select id="group_pref" name="group_pref" defaultValue={v.group_pref ?? ''} aria-describedby={e.group_pref ? 'err-pref' : undefined} className={`${field} h-11 w-full px-3 sm:w-72`}>
          <option value="">No preference</option>
          {GROUP_PREFS.map((g) => <option key={g} value={g}>{groupPrefLabel(g)}</option>)}
        </select>
        <Err id="err-pref">{e.group_pref}</Err>
      </fieldset>

      <fieldset className="mt-8" aria-describedby={e.interests ? 'err-int' : undefined}>
        <legend><SectionLabel>What you are interested in</SectionLabel></legend>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {INTERESTS.map((i) => (
            <label key={i} className={choice}>
              <input type="checkbox" name="interests" value={i} defaultChecked={v.interests.includes(i)} className="size-4 accent-[#3e644b]" />
              {tagLabel(i)}
            </label>
          ))}
        </div>
        <Err id="err-int">{e.interests}</Err>
      </fieldset>

      <div className="mt-8">
        <label htmlFor="about_me"><SectionLabel>What you told Gathered about you</SectionLabel></label>
        <textarea id="about_me" name="about_me" defaultValue={v.about_me ?? ''} rows={5}
          aria-describedby={`about-help${e.about_me ? ' err-about' : ''}`}
          className={`${field} min-h-28 w-full resize-y p-4 leading-6`}
          placeholder="For example, what would make a group feel welcoming to you?" />
        <p id="about-help" className="mt-2 text-sm text-[#69736b]">In your own words, up to {ABOUT_ME_MAX} characters. Gathered keeps your words as you write them.</p>
        <Err id="err-about">{e.about_me}</Err>
      </div>

      <div className="mt-8 flex flex-col gap-3 border-t border-[#e6e8e2] pt-6 sm:flex-row sm:items-center">
        <SubmitButton pendingText="Saving…" className="w-full sm:w-auto">Save preferences</SubmitButton>
        <Link href="/member" className="inline-flex h-8 items-center justify-center text-sm font-semibold text-[#55745c] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9eb99f]">Cancel</Link>
      </div>
    </form>
  )
}
