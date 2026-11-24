// Gathered: demo access gate tests (no database, no network, no model).
//   npm run test:access
// Covers the token/cookie design, the proxy (redirects and allow-list), the fail-closed and
// development behaviour, the independent requireDemoAccess() helper, and that every action that
// can reach OpenRouter calls it before doing anything else.
import fs from 'node:fs'
import path from 'node:path'
import { NextRequest } from 'next/server'
import {
  ACCESS_COOKIE, ACCESS_TTL_SECONDS, accessConfig, hasDemoAccess, issueAccessToken, passwordMatches, safeNext, verifyAccessToken,
} from '../lib/demo-access-token.ts'
import { requireDemoAccess } from '../lib/demo-access.ts'
import { proxy, config } from '../proxy.ts'

let failed = 0
const check = (name, ok, extra = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`); if (!ok) failed++ }

// A throwaway value made for this run; it is never printed or stored.
const PW = `t-${Math.random().toString(36).slice(2)}-${Date.now()}`
const NOW = Date.UTC(2026, 10, 24, 12, 0, 0)
const prodEnv = { NODE_ENV: 'production', DEMO_PASSWORD: PW }

console.log('Password check')
check('the correct password matches', passwordMatches(PW, PW))
check('a wrong, empty, longer and non-string value does not', !passwordMatches('nope', PW) && !passwordMatches('', PW) && !passwordMatches(PW + 'x', PW) && !passwordMatches(null, PW) && !passwordMatches(undefined, PW))

console.log('\nCookie design')
const tok = issueAccessToken(PW, NOW)
const [ver, exp, sig] = tok.split('.')
check('the token is v1.<expiry>.<signature>', ver === 'v1' && /^\d+$/.test(exp) && sig.length >= 40)
check('the cookie does not contain the plaintext password (or its base64/hex forms)', ![PW, Buffer.from(PW).toString('base64'), Buffer.from(PW).toString('hex'), encodeURIComponent(PW)].some((p) => tok.includes(p)))
check('it expires about 24 hours after issue', Number(exp) - Math.floor(NOW / 1000) === ACCESS_TTL_SECONDS && ACCESS_TTL_SECONDS === 86400)
check('a valid token verifies', verifyAccessToken(tok, PW, NOW + 1000))
check('it is rejected after it expires', !verifyAccessToken(tok, PW, NOW + 86400 * 1000 + 1000))
check('a tampered expiry is rejected (cannot extend access)', !verifyAccessToken(`v1.${Number(exp) + 99999}.${sig}`, PW, NOW))
check('a tampered signature is rejected', !verifyAccessToken(`v1.${exp}.${sig.slice(0, -2)}AA`, PW, NOW))
check('a token signed with a different password is rejected (changing DEMO_PASSWORD revokes cookies)', !verifyAccessToken(issueAccessToken('other-password', NOW), PW, NOW))
check('empty, malformed and wrong-version values are rejected', ['', 'abc', 'v1.1.2.3', 'v2.' + exp + '.' + sig, `v1.-5.${sig}`, `v1..${sig}`].every((v) => !verifyAccessToken(v, PW, NOW)) && !verifyAccessToken(undefined, PW, NOW))

console.log('\nConfiguration: fail closed in production, explicit in development')
check('production with DEMO_PASSWORD: enforced', accessConfig(prodEnv).mode === 'enforced')
check('production WITHOUT DEMO_PASSWORD: unavailable (no bypass)', accessConfig({ NODE_ENV: 'production' }).mode === 'unavailable' && accessConfig({ NODE_ENV: 'production', DEMO_PASSWORD: '' }).mode === 'unavailable')
check('production without a password grants nothing, even to a well-formed cookie', !hasDemoAccess(tok, { NODE_ENV: 'production' }, NOW + 1000))
check('development without DEMO_PASSWORD: open (documented bypass)', accessConfig({ NODE_ENV: 'development' }).mode === 'open' && hasDemoAccess(undefined, { NODE_ENV: 'development' }))
check('development WITH DEMO_PASSWORD: enforced like production', accessConfig({ NODE_ENV: 'development', DEMO_PASSWORD: PW }).mode === 'enforced' && !hasDemoAccess(undefined, { NODE_ENV: 'development', DEMO_PASSWORD: PW }))

console.log('\nReturn address')
check('only same-site paths are accepted', safeNext('/member/groups/abc?x=1') === '/member/groups/abc?x=1' && safeNext('//evil.com') === '/' && safeNext('https://evil.com') === '/' && safeNext('/\\evil.com') === '/' && safeNext(undefined) === '/' && safeNext('/access') === '/' && safeNext('/access/lock') === '/')

console.log('\nProxy')
const saved = { pw: process.env.DEMO_PASSWORD, ne: process.env.NODE_ENV }
process.env.DEMO_PASSWORD = PW
process.env.NODE_ENV = 'production'
const req = (url, cookie, method = 'GET') => new NextRequest(`http://localhost:3000${url}`, { method, headers: cookie ? { cookie } : {} })
const go = (r) => { const res = proxy(r); return { status: res.status, loc: res.headers.get('location') ?? '', next: res.headers.get('x-middleware-next') === '1' } }
const live = issueAccessToken(PW)
for (const p of ['/', '/member', '/member/groups/abc', '/member/intake', '/manager', '/manager/members', '/leader', '/recommendation-test', '/connection-test', '/anything-else']) {
  const r = go(req(p))
  check(`${p}: no cookie -> redirected to /access`, r.status === 303 && new URL(r.loc).pathname === '/access', JSON.stringify(r))
}
check('the redirect remembers where the visitor was going', new URL(go(req('/member?view=recommendations')).loc).searchParams.get('next') === '/member?view=recommendations')
check('/access is reachable without the cookie', go(req('/access')).next && go(req('/access?error=1')).next && go(req('/access/lock', undefined, 'POST')).next)
check('a valid cookie lets protected pages through', ['/', '/member', '/manager', '/leader', '/recommendation-test'].every((p) => go(req(p, `${ACCESS_COOKIE}=${live}`)).next))
check('a valid cookie alongside the persona cookie still passes (the gate is outside the persona system)', go(req('/manager', `personaKey=manager; ${ACCESS_COOKIE}=${live}`)).next)
check('the persona cookie alone is not access', go(req('/manager', 'personaKey=manager')).status === 303)
check('an expired cookie is rejected', go(req('/member', `${ACCESS_COOKIE}=${issueAccessToken(PW, Date.now() - 2 * 86400 * 1000)}`)).status === 303)
check('a forged cookie is rejected', go(req('/member', `${ACCESS_COOKIE}=v1.9999999999.AAAA`)).status === 303 && go(req('/member', `${ACCESS_COOKIE}=${PW}`)).status === 303)
check('an unauthenticated POST (a server-action call) is redirected, not run', (() => { const r = go(req('/member', undefined, 'POST')); return r.status === 303 && new URL(r.loc).pathname === '/access' })())
process.env.DEMO_PASSWORD = ''
check('production with no DEMO_PASSWORD: everything but /access is refused', go(req('/member', `${ACCESS_COOKIE}=${live}`)).status === 303 && go(req('/access')).next)
process.env.NODE_ENV = 'development'
check('development with no DEMO_PASSWORD: pages open', go(req('/member')).next)
Object.assign(process.env, { NODE_ENV: saved.ne })
if (saved.pw === undefined) delete process.env.DEMO_PASSWORD; else process.env.DEMO_PASSWORD = saved.pw

console.log('\nProxy matcher')
const re = new RegExp('^' + config.matcher[0].replace(/\\\\/g, '\\') + '$')
check('pages are matched', ['/', '/member', '/manager/members', '/access', '/recommendation-test'].every((p) => re.test(p)))
check('Next.js build assets and public files are not', !['/_next/static/chunks/a.js', '/_next/image', '/favicon.ico', '/icon.svg', '/placeholder.jpg'].some((p) => re.test(p)))

console.log('\nrequireDemoAccess() (the independent check inside model-triggering actions)')
const attempt = async (cookieValue, env) => {
  const sv = { pw: process.env.DEMO_PASSWORD, ne: process.env.NODE_ENV }
  Object.assign(process.env, env)
  try { await requireDemoAccess(async () => cookieValue); return 'allowed' }
  catch (e) { return String(e?.digest ?? e).includes('NEXT_REDIRECT') && String(e.digest).includes('/access') ? 'redirected' : `error: ${e}` }
  finally { process.env.NODE_ENV = sv.ne; if (sv.pw === undefined) delete process.env.DEMO_PASSWORD; else process.env.DEMO_PASSWORD = sv.pw }
}
check('no cookie: redirected to /access', (await attempt(undefined, { NODE_ENV: 'production', DEMO_PASSWORD: PW })) === 'redirected')
check('forged cookie: redirected', (await attempt('v1.9999999999.AAAA', { NODE_ENV: 'production', DEMO_PASSWORD: PW })) === 'redirected')
check('expired cookie: redirected', (await attempt(issueAccessToken(PW, Date.now() - 2 * 86400 * 1000), { NODE_ENV: 'production', DEMO_PASSWORD: PW })) === 'redirected')
check('valid cookie: allowed', (await attempt(issueAccessToken(PW), { NODE_ENV: 'production', DEMO_PASSWORD: PW })) === 'allowed')
check('production without DEMO_PASSWORD: redirected even with a well-formed cookie', (await attempt(live, { NODE_ENV: 'production', DEMO_PASSWORD: '' })) === 'redirected')

console.log('\nEvery action that can reach OpenRouter checks access first')
const root = path.join(import.meta.dirname, '..')
const guarded = [
  ['app/member/actions.ts', 'requestMyRecommendations'],
  ['app/recommendation-test/actions.ts', 'requestRecommendations'],
  ['app/manager/actions.ts', 'runAiReview'],
]
for (const [file, fn] of guarded) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const body = src.slice(src.indexOf(`export async function ${fn}(`)).split('{').slice(1).join('{').trimStart()
  check(`${file}: ${fn}() begins with await requireDemoAccess()`, body.startsWith('await requireDemoAccess()'), body.slice(0, 80))
}
// No other file may call a model: if one is added, it must be added to the list above.
const callers = []
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (['node_modules', '.next', 'scripts', '.git'].includes(e.name)) continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(e.name) && /getRecommendations\(|runScheduleReview\(/.test(fs.readFileSync(p, 'utf8'))) callers.push(path.relative(root, p).replaceAll('\\', '/')) } }
walk(path.join(root, 'app'))
check('the only app files that start a model call are the three guarded action files', callers.sort().join(',') === guarded.map(([f]) => f).sort().join(','), callers.join(','))

console.log(failed ? `\n${failed} FAILED` : '\nAll demo access tests passed')
process.exit(failed ? 1 : 0)
