import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { Leaf } from 'lucide-react'
import { ACCESS_COOKIE, accessConfig, hasDemoAccess, safeNext } from '@/lib/demo-access-token'
import { enterDemo } from './actions'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Gathered Demo' }

export default async function AccessPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const next = safeNext(typeof sp.next === 'string' ? sp.next : undefined)
  // Already in (or running locally with no demo password set): nothing to ask.
  if (hasDemoAccess((await cookies()).get(ACCESS_COOKIE)?.value)) redirect(next)
  const available = accessConfig().mode === 'enforced'
  const wrong = sp.error === '1'

  return (
    <div className="flex min-h-screen items-center justify-center px-5">
      <main className="w-full max-w-sm rounded-2xl border border-[#e1e8df] bg-white p-8 shadow-[0_8px_30px_-20px_rgba(39,63,45,.4)]">
        <div className="mb-6 flex items-center gap-2.5 text-[#26382b]">
          <span className="flex size-8 items-center justify-center rounded-full bg-[#dcead9]"><Leaf className="size-4" /></span>
          <span className="font-serif text-xl font-semibold tracking-tight">Gathered Demo</span>
        </div>
        {available ? (
          <>
            <p className="text-sm leading-6 text-[#69736b]">This demo is password protected.</p>
            <form action={enterDemo} className="mt-5 space-y-4">
              <input type="hidden" name="next" value={next} />
              <label className="block text-sm font-medium text-[#36463b]">
                Password
                <input type="password" name="password" required autoFocus autoComplete="off" className="mt-1.5 block w-full rounded-lg border border-[#d4dfd2] bg-white px-3 py-2 text-base text-[#26382b] outline-none focus:border-[#718b70]" />
              </label>
              {wrong && <p role="alert" className="text-sm text-[#8a3b2e]">That password isn&apos;t correct.</p>}
              <button type="submit" className="w-full rounded-full bg-[#55745c] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#46614b]">Enter demo</button>
            </form>
          </>
        ) : (
          <p className="text-sm leading-6 text-[#69736b]">The demo isn&apos;t available right now. Please try again later.</p>
        )}
      </main>
    </div>
  )
}
