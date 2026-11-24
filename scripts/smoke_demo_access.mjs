// Gathered: demo access gate HTTP smoke test against a RUNNING production build.
//
//   1. npm run build
//   2. DEMO_PASSWORD=<a throwaway value> OPENROUTER_API_KEY= npx next start -p 3119
//        (blank key: nothing here can reach a model)
//   3. DEMO_PASSWORD=<the same value> BASE_URL=http://localhost:3119 node --env-file=.env.local scripts/smoke_demo_access.mjs
//
// Plain HTTP, NOT a browser click-through. Walks a visitor through the gate, then replays real
// server-action forms WITHOUT the access cookie. Makes no model call and changes no data: it only
// selects personas (a cookie) and reads row counts through the owner connection.
import pg from "pg";
import { hiddenFields, submitPassword } from "./lib/demo_access.mjs";

const BASE = process.env.BASE_URL ?? "http://localhost:3119";
const PASSWORD = process.env.DEMO_PASSWORD;
if (!PASSWORD) { console.error("Set DEMO_PASSWORD to the value the app was started with."); process.exit(2); }
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl: { rejectUnauthorized: false } });
await own.connect();

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const text = (h) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const get = async (cookie, url) => { const r = await fetch(BASE + url, { headers: cookie ? { cookie } : {}, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") ?? "", setCookie: r.headers.get("set-cookie") ?? "" }; };
const loc = (r) => { try { return new URL(r.loc, BASE); } catch { return new URL("http://none/"); } };
const counts = async () => (await own.query(`select (select coalesce(max(id),0) from app.audit_log)::int audit, (select count(*) from app.audit_log)::int audits,
  (select count(*) from app.audit_log where action like 'llm%')::int llm, (select count(*) from app.recommendation_run)::int runs, (select count(*) from app.recommendation)::int recs,
  (select count(*) from app.join_request)::int reqs, (select count(*) from app.escalation)::int esc, (select count(*) from app.group_membership)::int members`)).rows[0];
const formFor = (html, buttonText) => { const forms = html.match(/<form[\s\S]*?<\/form>/g) ?? []; const f = forms.find((x) => x.includes(buttonText)); return f ? hiddenFields(f) : null; };
const post = (cookie, url, fields) => { const f = new FormData(); for (const [k, v] of fields) f.append(k, v); return fetch(BASE + url, { method: "POST", body: f, redirect: "manual", headers: cookie ? { cookie } : {} }); };
const noMarker = (s) => !s.includes(PASSWORD);

console.log("1. Without the cookie");
for (const p of ["/", "/member", "/manager", "/leader", "/recommendation-test", "/member/groups/00000000-0000-0000-0000-000000000000"]) {
  const r = await get("", p);
  check(`GET ${p} redirects to /access`, r.status === 303 && loc(r).pathname === "/access", `${r.status} ${r.loc}`);
}
let r = await get("", "/access");
check("/access is reachable and asks for the password", r.status === 200 && text(r.html).includes("This demo is password protected.") && text(r.html).includes("Enter demo"), r.status);
check("the page does not contain the configured password", noMarker(r.html));
check("a static asset is not gated", (await get("", "/icon.svg")).status === 200);

console.log("\n2. Wrong password");
let res = await submitPassword(BASE, PASSWORD + "-wrong");
check("redirected back to /access with an error flag, no cookie set", res.status === 303 && (res.headers.get("location") ?? "").includes("/access?error=1") && !(res.headers.get("set-cookie") ?? "").includes("gatheredDemoAccess"), `${res.status} ${res.headers.get("location")} ${res.headers.get("set-cookie")}`);
r = await get("", "/access?error=1");
check("the page says: That password isn't correct.", text(r.html).includes("That password isn't correct."));
check("access remains denied", (await get("", "/")).status === 303);
res = await submitPassword(BASE, "");
check("an empty password is refused too", !(res.headers.get("set-cookie") ?? "").includes("gatheredDemoAccess=") || /gatheredDemoAccess=;/.test(res.headers.get("set-cookie") ?? ""));

console.log("\n3. Correct password");
res = await submitPassword(BASE, PASSWORD);
const setCookie = res.headers.get("set-cookie") ?? "";
const m = setCookie.match(/gatheredDemoAccess=([^;]+)/);
check("redirected into the app and a cookie is set", res.status === 303 && !!m, `${res.status} ${setCookie.slice(0, 60)}`);
check("the cookie is HttpOnly, SameSite=Lax, Path=/, Secure (production build), 24h", /httponly/i.test(setCookie) && /samesite=lax/i.test(setCookie) && /path=\//i.test(setCookie) && /secure/i.test(setCookie) && /max-age=86400/i.test(setCookie), setCookie.replace(m?.[1] ?? "", "<token>"));
check("the cookie value does not contain the password", !!m && !decodeURIComponent(m[1]).includes(PASSWORD) && noMarker(setCookie));
const AC = m ? `gatheredDemoAccess=${m[1]}` : "";
r = await get(AC, "/");
check("/ now loads (persona picker)", r.status === 200 && text(r.html).includes("CHOOSE A PERSONA"), r.status);
check("/access with the cookie goes straight on (no password screen)", [302, 303, 307].includes((await get(AC, "/access")).status));
check("a forged and an expired-looking cookie do not work", (await get("gatheredDemoAccess=v1.9999999999.AAAA", "/")).status === 303 && (await get(`gatheredDemoAccess=v1.1.${m?.[1].split(".")[2]}`, "/")).status === 303);

console.log("\n4. Personas work exactly as before, behind the gate");
const sel = formFor(r.html, "Dana");
res = await post(AC, "/", [...sel, ["personaKey", "member_dana"]]);
check("selecting Dana sets the persona and goes to /member", res.status === 303 && (res.headers.get("set-cookie") ?? "").includes("personaKey=member_dana"));
const cookieFor = (k) => `${AC}; personaKey=${k}`;
r = await get(cookieFor("member_dana"), "/member");
check("Dana: Member home loads", r.status === 200 && !text(r.html).includes("Choose a persona") && text(r.html).includes("Dana"), r.status);
r = await get(cookieFor("member_marcus"), "/member");
check("Marcus: Member home loads", r.status === 200 && text(r.html).includes("Marcus"), r.status);
r = await get(cookieFor("manager"), "/manager");
check("Alan: Manager page loads with Run AI review", r.status === 200 && text(r.html).includes("Run AI review"), r.status);
r = await get(cookieFor("member_dana"), "/manager");
check("the demo password is not Manager authorization: Dana still cannot open Manager data", r.status === 200 && !text(r.html).includes("Run AI review") && !text(r.html).includes("Insights requiring review"), text(r.html).slice(0, 200));
r = await get(AC, "/manager");
check("the password alone (no persona) shows the persona chooser, not Manager data", !text(r.html).includes("Run AI review"));

console.log("\n5. Direct server-action calls WITHOUT the access cookie");
const forms = [
  ["Run AI review (Manager)", cookieFor("manager"), "/manager", "Run AI review", "personaKey=manager"],
  ["Recommendation test (Dana)", cookieFor("member_dana"), "/recommendation-test", "Request recommendations", "personaKey=member_dana"],
  ["Find my best matches (a member with no saved run)", cookieFor("member_priya"), "/member", "Find my best matches", "personaKey=member_priya"],
];
const before = await counts();
for (const [label, withCookie, url, button, personaOnly] of forms) {
  const fields = formFor((await get(withCookie, url)).html, button);
  if (!fields) { console.log(`  skip  ${label}: that form is not on the page in the current demo state`); continue; }
  const bare = await post(personaOnly, url, fields);
  check(`${label}: no cookie -> rejected (redirect to /access)`, bare.status === 303 && new URL(bare.headers.get("location") ?? "/", BASE).pathname === "/access", `${bare.status} ${bare.headers.get("location")}`);
  const forged = await post(`gatheredDemoAccess=v1.9999999999.AAAA; ${personaOnly}`, url, fields);
  check(`${label}: forged cookie -> rejected`, forged.status === 303 && new URL(forged.headers.get("location") ?? "/", BASE).pathname === "/access");
}
const after = await counts();
check("zero model attempts and no data change: audit log, runs, recommendations, requests, insights and memberships are exactly as before", JSON.stringify(before) === JSON.stringify(after), JSON.stringify({ before, after }));

console.log("\n6. Lock demo");
r = await get(cookieFor("member_dana"), "/member");
check("the page shows a Lock demo control", text(r.html).includes("Lock demo"));
res = await fetch(BASE + "/access/lock", { method: "POST", redirect: "manual", headers: { cookie: cookieFor("member_dana") } });
const lockCookie = res.headers.get("set-cookie") ?? "";
check("it returns to /access and clears the access and persona cookies", res.status === 303 && new URL(res.headers.get("location") ?? "/", BASE).pathname === "/access" && /gatheredDemoAccess=;/.test(lockCookie) && /personaKey=;/.test(lockCookie), `${res.status} ${lockCookie.slice(0, 120)}`);

check("the whole smoke run made no model call", (await counts()).llm === before.llm);
await own.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
