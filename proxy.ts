import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { ACCESS_COOKIE, hasDemoAccess } from '@/lib/demo-access-token'

// Demo access gate (outermost layer; see lib/demo-access-token.ts). Anyone without a valid
// demo-access cookie is sent to /access. This is not the persona system and grants no role.
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl
  if (pathname === '/access' || pathname.startsWith('/access/')) return NextResponse.next()
  if (hasDemoAccess(request.cookies.get(ACCESS_COOKIE)?.value)) return NextResponse.next()

  const url = request.nextUrl.clone()
  url.pathname = '/access'
  url.search = ''
  if (request.method === 'GET' && pathname !== '/') url.searchParams.set('next', pathname + search)
  return NextResponse.redirect(url, 303)
}

// Everything except Next.js build assets and files with an extension (favicon, /public images).
export const config = {
  matcher: ['/((?!_next/static|_next/image|.*\\..*).*)'],
}
