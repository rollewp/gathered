// Gathered: Journey 1 HTTP smoke test against a RUNNING app (no LLM calls).
//
//   1. npm run build && npx next start -p 3113        (or `npm run dev`)
//   2. BASE_URL=http://localhost:3113 node --env-file=.env.local scripts/smoke_journey1.mjs
//
// Drives the real pages and server actions with plain HTTP (cookie persona, no JavaScript):
// member home states, ranked cards, the absence of hidden ranking data in the HTML, the group
// detail page, the Ask to join server action, and the pending states. Recommendation runs are
// created with a canned ranking so the model is never called. Cleans up after itself.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3113";
import { accessCookie } from "./lib/demo_access.mjs";
const AC = await accessCookie(BASE); // passes the demo access gate (needs DEMO_PASSWORD when the app enforces it)
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3 });
await own.connect();
const startAuditId = Number((await own.query("select coalesce(max(id), 0) m from app.audit_log")).rows[0].m);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const text = (h) => h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: AC + (key ? `personaKey=${key}` : "") }, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") }; };

async function persist(personKey, max = 3) {
  const c = await app.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [P[personKey].role, P[personKey].person_id]);
    const ids = (await c.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((r) => r.group_id);
    const n = Math.min(max, ids.length);
    await c.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'medium', 'smoke', 'stub-model', 'rank-v2', '{}'::jsonb)",
      [ids, ids.slice(0, n), n === 0 ? "no_candidates" : "llm"]);
    await c.query("commit");
    return ids.slice(0, n);
  } finally { c.release(); }
}
async function cleanup() {
  await own.query("delete from app.join_request where person_id = any($1::uuid[])", [["member_dana", "member_priya"].map((k) => P[k].person_id)]);
  await own.query("update app.join_request set rec_id = null where rec_id is not null"); // kept (withdrawn/declined) requests reference recommendations
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
await cleanup();
const names = Object.fromEntries((await own.query("select group_id, name from app.grp")).rows.map((g) => [g.group_id, g.name]));
const HIDDEN = /rationale|score_breakdown|shortlist|prompt_version|rank-v|stub-model|confidence|internal_rationale|"score"/i;

try {
  console.log("Browse Groups (catalog)");
  const total = (await own.query("select count(*)::int n from app.grp")).rows[0].n;
  const cards = (html) => (html.match(/href="\/member\/groups\/[0-9a-f-]{36}"/g) ?? []).length;
  let r = await get("member_dana", "/member");
  const b = text(r.html);
  check("no saved result: Browse Groups with the database total, the explicit request control, and no recommendation made",
    r.status === 200 && r.html.includes('aria-label="Browse groups"') && b.includes(`${total} groups meet`) && b.includes("Find my best matches") && !b.includes("selected for you"), b.slice(0, 300));
  check(`first page shows 12 cards of ${total}, not all of them`, cards(r.html) === 12 && b.includes(`Showing 1\u201312 of ${total} groups`), `${cards(r.html)} cards`);
  check("renders the persona name in the header", b.includes("Dana Ruiz"));
  check("no ranking data in the catalog HTML", !HIDDEN.test(r.html), (r.html.match(HIDDEN) ?? [])[0]);
  check("no address or coordinates in the catalog HTML", !/lat_approx|lng_approx|latitude|longitude|street/i.test(r.html));
  check("filters are labelled form controls (search, day, time, format, life stage, childcare, open)",
    ["catalog-q", "catalog-day", "catalog-time", "catalog-format", "catalog-stage"].every((id) => r.html.includes(`for="${id}"`) && r.html.includes(`id="${id}"`)) && r.html.includes('name="childcare"') && r.html.includes('name="open"'));
  check("the result count is a polite live region", /role="status"[^>]*aria-live="polite"|aria-live="polite"[^>]*role="status"/.test(r.html));
  const p2 = await get("member_dana", "/member?page=2");
  check("page 2 shows the next 12 and links back", cards(p2.html) === 12 && text(p2.html).includes(`Showing 13\u201324 of ${total}`) && p2.html.includes("Previous"));
  const f = await get("member_dana", "/member?day=thu&childcare=1");
  const fn = (await own.query("select count(*)::int n from app.grp where meeting_slot like 'thu\\_%' and childcare")).rows[0].n;
  check("two filters narrow the list and show the matching count", text(f.html).includes(`of ${fn} matching group`) && cards(f.html) === Math.min(12, fn) && text(f.html).includes("Clear all"), text(f.html).match(/Showing[^.]*/)?.[0]);
  const none = await get("member_dana", "/member?q=zzzz-nothing");
  check("no matches: friendly empty state, no cards", text(none.html).includes("No groups match those filters") && cards(none.html) === 0);
  const bad = await get("member_dana", "/member?day=funday&page=-2&size=9999&childcare=maybe");
  check("invalid parameters are ignored with a note (page size clamped to 24), never an error", bad.status === 200 && text(bad.html).includes("weren't recognised") && cards(bad.html) === 24);
  const noRuns = (await own.query("select count(*)::int n from app.recommendation_run")).rows[0].n;
  check("browsing, paging and filtering created no recommendation run and no audit row", noRuns === 0 && (await own.query("select count(*)::int n from app.audit_log where id > $1", [startAuditId])).rows[0].n === 0);
  const noSaved = await get("member_dana", "/member?view=recommendations");
  check("asking to view recommendations with none saved falls back to Browse (never generates)", noSaved.html.includes('aria-label="Browse groups"') && (await own.query("select count(*)::int n from app.recommendation_run")).rows[0].n === 0);

  console.log("\nRecommendations");
  const dana = await persist("member_dana");
  r = await get("member_dana", "/member");
  check("with a saved run, Browse offers 'View my best matches' (a link, not a regeneration)", text(r.html).includes("View my best matches") && !text(r.html).includes("Find my best matches"));
  r = await get("member_dana", "/member?view=recommendations");
  const t = text(r.html);
  const order = dana.map((id) => t.indexOf(names[id]));
  check("saved result: heading and group cards render in ranked order", t.includes("Three groups selected for you") && t.includes("Explore these options and decide what feels right") && order.every((i) => i > 0) && order.join() === [...order].sort((a, b) => a - b).join(), JSON.stringify(order));
  check("at most three recommendation cards", cards(r.html) === 3, `${cards(r.html)} cards`);
  for (const [k, heading] of [[1, "One group selected for you"], [2, "Two groups selected for you"]]) {
    await persist("member_dana", k);
    const rk = await get("member_dana", "/member?view=recommendations");
    check(`a run with ${k} group${k > 1 ? "s" : ""} renders "${heading}" with ${k} card${k > 1 ? "s" : ""}, nothing padded`, text(rk.html).includes(heading) && cards(rk.html) === k && !HIDDEN.test(rk.html), `${cards(rk.html)} cards`);
  }
  await persist("member_dana", 3);
  check("'Browse all groups' returns to the catalog", t.includes("Browse all groups") && r.html.includes('href="/member"'));
  check("no ranking data appears in the page or its payload", !HIDDEN.test(r.html), (r.html.match(HIDDEN) ?? [])[0]);
  check("no 'why this fits' explanation", !/why (this|it|you)|because you|fits you because|ai chose|compatib|match score/i.test(t));
  const again = await get("member_dana", "/member?view=recommendations");
  check("a second visit renders the same result", text(again.html).includes(names[dana[0]]));
  const browse = await get("member_dana", "/member?page=3");
  const stillOne = (await own.query("select count(*)::int n, bool_and(is_current) c from app.recommendation_run where person_id = $1 and is_current", [P.member_dana.person_id])).rows[0];
  check("browsing the catalog afterwards leaves the saved run in place", browse.status === 200 && stillOne.n === 1 && stillOne.c === true);
  const cat = await get("member_dana", `/member?q=${encodeURIComponent(names[dana[0]])}`);
  const recHtml = (await get("member_dana", "/member?view=recommendations")).html;
  const cardOf = (html, name) => text(html.split(/<h3/).slice(1).find((c) => c.includes(name)) ?? "").split(/View (?:group|request)/)[0].replace(/Request sent · pending/, "").trim();
  check("the recommended card and the catalog card for the same group show the same content", cardOf(cat.html, names[dana[0]]).length > 50 && cardOf(cat.html, names[dana[0]]) === cardOf(recHtml, names[dana[0]]));

  console.log("\nGroup detail and Ask to join");
  const gid = dana[0];
  r = await get("member_dana", `/member/groups/${gid}`);
  check("group detail shows the group and the join form", r.status === 200 && text(r.html).includes(names[gid]) && text(r.html).includes("Ask to join"));
  check("detail page has no ranking data", !HIDDEN.test(r.html));
  check("unknown group id gives 404", (await get("member_dana", "/member/groups/00000000-0000-4000-8000-000000000000")).status === 404);
  check("malformed group id gives 404", (await get("member_dana", "/member/groups/not-a-uuid")).status === 404);

  const fields = {};
  for (const tag of r.html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
    const name = tag.match(/name="([^"]*)"/)?.[1]; const value = tag.match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) fields[name] = value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.set("note", "Hi, I'm looking for a warm group.");
  const post = await fetch(`${BASE}/member/groups/${gid}`, { method: "POST", body: form, redirect: "manual", headers: { cookie: AC + "personaKey=member_dana" } });
  check("Ask to join action redirects back to the group", post.status === 303 && (post.headers.get("location") ?? "").endsWith(`/member/groups/${gid}`), `${post.status} ${post.headers.get("location")}`);
  const jr = (await own.query("select status, member_note, rec_id from app.join_request where person_id = $1 and group_id = $2", [P.member_dana.person_id, gid])).rows;
  check("exactly one pending request was stored, linked to the recommendation", jr.length === 1 && jr[0].status === "requested" && jr[0].rec_id && jr[0].member_note === "Hi, I'm looking for a warm group.", JSON.stringify(jr));

  r = await get("member_dana", `/member/groups/${gid}`);
  check("detail now shows the confirmation (leader will reach out) and no form", /will reach out if it's a fit/.test(text(r.html)) && !text(r.html).includes("Ask to join"), text(r.html).slice(0, 200));
  r = await get("member_dana", "/member");
  check("home shows the request under Your requests, and the recommended card is marked pending", text(r.html).includes("Your requests") && text((await get("member_dana", "/member?view=recommendations")).html).includes("Request sent · pending"));

  const post2 = await fetch(`${BASE}/member/groups/${gid}`, { method: "POST", body: form, redirect: "manual", headers: { cookie: AC + "personaKey=member_dana" } });
  const count = (await own.query("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2", [P.member_dana.person_id, gid])).rows[0].c;
  check("re-posting the same request does not create a duplicate", count === 1, `status ${post2.status}, rows ${count}`);

  console.log("\nOther states");
  r = await get("member_priya", "/member");
  check("a member who has not asked yet sees the request control", text(r.html).includes("Find my best matches"));
  await persist("member_priya");
  r = await get("member_priya", "/member?view=recommendations");
  check("empty result is shown as the canonical empty state", text(r.html).includes("No group fits your mornings yet. We've let our groups pastor know."));
  r = await get("member_ruth", "/member");
  check("member already in a group: no recommendations", text(r.html).includes("You're part of a group") && !r.html.includes('aria-label="Browse groups"'));
  r = await get("member_jordan", "/member");
  check("member without a profile is pointed to intake", text(r.html).includes("Let's get to know you") && r.html.includes("/member/intake"));
  r = await get("leader_tom", "/member");
  check("a non-member persona gets the member chooser, not member data", text(r.html).includes("Continue as a member") && !r.html.includes('aria-label="Browse groups"'));
  r = await get(null, "/member");
  check("no persona selected: member chooser", text(r.html).includes("Continue as a member"));
  r = await get("manager", "/member/groups/" + gid);
  check("the Manager cannot reach member group pages", text(r.html).includes("Continue as a member"));
} finally {
  await cleanup();
  await own.end(); await app.end();
}
console.log(failed === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${failed} FAILED`);
process.exit(failed ? 1 : 0);
