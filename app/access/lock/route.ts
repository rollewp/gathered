import { NextResponse } from 'next/server'
import { ACCESS_COOKIE } from '@/lib/demo-access-token'
import { PERSONA_COOKIE } from '@/lib/personas'

// "Lock demo": clears the access cookie (and the persona choice) and returns to the password page.
// A plain POST form, so it adds no server-action fields to the pages that contain it.
export function POST(request: Request) {
  const res = NextResponse.redirect(new URL('/access', request.url), 303)
  res.cookies.delete(ACCESS_COOKIE)
  res.cookies.delete(PERSONA_COOKIE)
  return res
}
