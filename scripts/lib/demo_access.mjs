// Shared by the HTTP smoke tests: pass the demo access gate of a RUNNING app the way a visitor does
// (open /access, submit the password form), and return the cookie prefix to put in front of the
// persona cookie, e.g. "gatheredDemoAccess=...; ". Returns "" when the app is not enforcing the
// gate (`npm run dev` with no DEMO_PASSWORD). The password comes from the DEMO_PASSWORD environment
// variable (the same value the app was started with); it is never printed.
export const hiddenFields = (html) => (html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? [])
  .map((t) => [t.match(/name="([^"]*)"/)?.[1], (t.match(/value="([^"]*)"/)?.[1] ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"')])
  .filter(([n]) => n);

export async function submitPassword(base, password, extraCookie = "") {
  const page = await fetch(base + "/access", { redirect: "manual", headers: extraCookie ? { cookie: extraCookie } : {} });
  const html = await page.text();
  const f = new FormData();
  for (const [k, v] of hiddenFields(html)) f.append(k, v);
  f.set("password", password);
  return fetch(base + "/access", { method: "POST", body: f, redirect: "manual", headers: extraCookie ? { cookie: extraCookie } : {} });
}

export async function accessCookie(base) {
  const first = await fetch(base + "/access", { redirect: "manual" });
  if (first.status >= 300 && first.status < 400) return ""; // open (development, no DEMO_PASSWORD)
  const html = await first.text();
  if (!html.includes('name="password"')) throw new Error("The app is not accepting demo passwords (is DEMO_PASSWORD set where it was started?)");
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error("Set DEMO_PASSWORD to the same value the app was started with");
  const res = await submitPassword(base, password);
  const m = (res.headers.get("set-cookie") ?? "").match(/gatheredDemoAccess=[^;]+/);
  if (!m) throw new Error("The demo password was not accepted by the app");
  return m[0] + "; ";
}
