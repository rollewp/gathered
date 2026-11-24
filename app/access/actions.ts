'use server'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ACCESS_COOKIE, ACCESS_TTL_SECONDS, accessConfig, issueAccessToken, passwordMatches, safeNext } from '@/lib/demo-access-token'

/**
 * Validates the shared demo password on the server and, if it matches, sets a signed HTTP-only
 * cookie (no password in it). The password is only ever read from the environment here; it is
 * never sent to the browser, logged, or placed in a URL.
 */
export async function enterDemo(formData: FormData) {
  const cfg = accessConfig()
  const next = safeNext(formData.get('next'))
  if (cfg.mode === 'open') redirect(next)
  if (cfg.mode === 'unavailable') redirect('/access')
  if (!passwordMatches(formData.get('password'), cfg.password)) {
    redirect(`/access?error=1${next === '/' ? '' : `&next=${encodeURIComponent(next)}`}`)
  }
  ;(await cookies()).set(ACCESS_COOKIE, issueAccessToken(cfg.password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TTL_SECONDS,
  })
  redirect(next)
}
