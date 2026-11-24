import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { ACCESS_COOKIE, hasDemoAccess } from '@/lib/demo-access-token'

/**
 * Call first in any server action that can cause a model call. The proxy already keeps visitors
 * without the demo-access cookie off every page and action; this makes the action refuse on its
 * own too, before anything is read, written or sent to OpenRouter.
 * `readCookie` exists so the check can be tested without a request.
 */
export async function requireDemoAccess(readCookie: () => Promise<string | undefined> = async () => (await cookies()).get(ACCESS_COOKIE)?.value): Promise<void> {
  if (!hasDemoAccess(await readCookie())) redirect('/access')
}
