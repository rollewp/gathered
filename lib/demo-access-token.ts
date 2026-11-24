// Demo access gate: the pure part (no Next.js imports, so the proxy and the tests can share it).
//
// This is DEMO ACCESS PROTECTION for the deployed hackathon app, not authentication. It sits in
// front of the persona picker; possession of the demo password grants no role and no data. The
// persona system (withPersona + Postgres RLS) is untouched and remains the only authorization.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

export const ACCESS_COOKIE = 'gatheredDemoAccess'
export const ACCESS_TTL_SECONDS = 24 * 60 * 60
const VERSION = 'v1'

type Env = Record<string, string | undefined>

export type AccessConfig =
  | { mode: 'enforced'; password: string } // DEMO_PASSWORD is set: the gate is on
  | { mode: 'open' } // development only: no DEMO_PASSWORD and NODE_ENV !== 'production'
  | { mode: 'unavailable' } // production without DEMO_PASSWORD: fail closed

/** Read the gate configuration. There is no bypass in production: a missing password closes the app. */
export function accessConfig(env: Env = process.env): AccessConfig {
  const password = env.DEMO_PASSWORD
  if (password) return { mode: 'enforced', password }
  return env.NODE_ENV === 'production' ? { mode: 'unavailable' } : { mode: 'open' }
}

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest()

/** Timing-safe password check (compares fixed-length digests, so length is not leaked either). */
export function passwordMatches(candidate: unknown, password: string): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) return false
  return timingSafeEqual(digest(candidate), digest(password))
}

// The signing key is derived from the password, so changing DEMO_PASSWORD revokes every cookie.
const signingKey = (password: string) => createHmac('sha256', 'gathered-demo-access/v1').update(password, 'utf8').digest()
const sign = (password: string, expiresAt: number) =>
  createHmac('sha256', signingKey(password)).update(`${VERSION}.${expiresAt}`, 'utf8').digest('base64url')

/** `v1.<expiry epoch seconds>.<HMAC-SHA256 signature>`: server-verifiable, contains no password. */
export function issueAccessToken(password: string, nowMs: number = Date.now(), ttlSeconds: number = ACCESS_TTL_SECONDS): string {
  const expiresAt = Math.floor(nowMs / 1000) + ttlSeconds
  return `${VERSION}.${expiresAt}.${sign(password, expiresAt)}`
}

export function verifyAccessToken(token: string | undefined, password: string, nowMs: number = Date.now()): boolean {
  if (!token) return false
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== VERSION || !/^\d{1,12}$/.test(parts[1])) return false
  const expiresAt = Number(parts[1])
  if (expiresAt <= Math.floor(nowMs / 1000)) return false
  const expected = Buffer.from(sign(password, expiresAt))
  const given = Buffer.from(parts[2])
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Does this cookie value grant demo access under the current configuration? */
export function hasDemoAccess(cookieValue: string | undefined, env: Env = process.env, nowMs: number = Date.now()): boolean {
  const cfg = accessConfig(env)
  if (cfg.mode === 'open') return true
  if (cfg.mode === 'unavailable') return false
  return verifyAccessToken(cookieValue, cfg.password, nowMs)
}

/** Only same-site paths are accepted as a return address (no `//host`, no scheme, never /access). */
export function safeNext(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  if (value === '/access' || value.startsWith('/access/') || value.startsWith('/access?')) return '/'
  return value
}
