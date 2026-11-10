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
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3 });
await own.connect();
const startAuditId = Number((await own.query("select coalesce(max(id), 0) m from app.audit_log")).rows[0].m);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const text = (h) => h.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: key ? `personaKey=${key}` : "" }, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") }; };

async function persist(personKey) {
  const c = await app.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [P[personKey].role, P[personKey].person_id]);
    const ids = (await c.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((r) => r.group_id);
    const n = Math.min(3, ids.length);
    await c.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'medium', 'smoke', 'stub-model', 'rank-v2', '{}'::jsonb)",
      [ids, ids.slice(0, n), n === 0 ? "no_candidates" : "llm"]);
    await c.query("commit");
    return ids.slice(0, n);
  } finally { c.release(); }
}
async function cleanup() {
  await own.query("delete from app.join_request where person_id = any($1::uuid[])", [["member_dana", "member_priya"].map((k) => P[k].person_id)]);
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
await cleanup();
const names = Object.fromEntries((await own.query("select group_id, name from app.grp")).rows.map((g) => [g.group_id, g.name]));
const HIDDEN = /rationale|score_breakdown|shortlist|prompt_version|rank-v|stub-model|confidence|internal_rationale|"score"/i;

try {
  console.log("Member home");
  let r = await get("member_dana", "/member");
  check("no saved result: shows the explicit request control and makes no recommendation", r.status === 200 && text(r.html).includes("Show me groups") && !text(r.html).includes("Recommended for you"));
  check("renders the persona name in the header", text(r.html).includes("Dana Ruiz"));

  const dana = await persist("member_dana");
  r = await get("member_dana", "/member");
  const t = text(r.html);
  const order = dana.map((id) => t.indexOf(names[id]));
  check("saved result: heading and three group cards render in ranked order", t.includes("Groups that might fit you") && order.every((i) => i > 0) && order.join() === [...order].sort((a, b) => a - b).join(), JSON.stringify(order));
  check("no ranking data appears in the page or its payload", !HIDDEN.test(r.html), (r.html.match(HIDDEN) ?? [])[0]);
  check("no 'why this fits' explanation", !/why (this|it|you)|because you|fits you because/i.test(t));
  const again = await get("member_dana", "/member");
  check("a second visit renders the same result", text(again.html).includes(names[dana[0]]));

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
  const post = await fetch(`${BASE}/member/groups/${gid}`, { method: "POST", body: form, redirect: "manual", headers: { cookie: "personaKey=member_dana" } });
  check("Ask to join action redirects back to the group", post.status === 303 && (post.headers.get("location") ?? "").endsWith(`/member/groups/${gid}`), `${post.status} ${post.headers.get("location")}`);
  const jr = (await own.query("select status, member_note, rec_id from app.join_request where person_id = $1 and group_id = $2", [P.member_dana.person_id, gid])).rows;
  check("exactly one pending request was stored, linked to the recommendation", jr.length === 1 && jr[0].status === "requested" && jr[0].rec_id && jr[0].member_note === "Hi, I'm looking for a warm group.", JSON.stringify(jr));

  r = await get("member_dana", `/member/groups/${gid}`);
  check("detail now shows the confirmation (leader will reach out) and no form", /will reach out if it's a fit/.test(text(r.html)) && !text(r.html).includes("Ask to join"), text(r.html).slice(0, 200));
  r = await get("member_dana", "/member");
  check("home shows the request as pending on the card and under Your requests", text(r.html).includes("Request sent · pending") && text(r.html).includes("Your requests"));

  const post2 = await fetch(`${BASE}/member/groups/${gid}`, { method: "POST", body: form, redirect: "manual", headers: { cookie: "personaKey=member_dana" } });
  const count = (await own.query("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2", [P.member_dana.person_id, gid])).rows[0].c;
  check("re-posting the same request does not create a duplicate", count === 1, `status ${post2.status}, rows ${count}`);

  console.log("\nOther states");
  r = await get("member_priya", "/member");
  check("a member who has not asked yet sees the request control", text(r.html).includes("Show me groups"));
  await persist("member_priya");
  r = await get("member_priya", "/member");
  check("empty result is shown as the canonical empty state", text(r.html).includes("No group fits your mornings yet. We've let our groups pastor know."));
  r = await get("member_ruth", "/member");
  check("member already in a group: no recommendations", text(r.html).includes("You're part of a group") && !text(r.html).includes("Recommended for you"));
  r = await get("member_jordan", "/member");
  check("member without a profile is pointed to intake", text(r.html).includes("Let's get to know you") && r.html.includes("/member/intake"));
  r = await get("leader_tom", "/member");
  check("a non-member persona gets the member chooser, not member data", text(r.html).includes("Continue as a member") && !text(r.html).includes("Groups that might fit you"));
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
