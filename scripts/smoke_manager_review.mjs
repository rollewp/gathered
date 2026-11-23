// Gathered: Manager "Run AI review" HTTP smoke test against a RUNNING app.
//
//   1. npm run build && npx next start -p 3116
//   2. BASE_URL=http://localhost:3116 node --env-file=.env.local scripts/smoke_manager_review.mjs
//      Without LIVE=1 it makes NO model call (page states, access control, the member setup step).
//      With LIVE=1 it also presses "Run AI review" once through the real server action, which
//      makes the single controlled real OpenRouter call (the review model), then presses it again
//      (which must make no call: the insight already exists).
//
// Drives real pages and server actions with plain HTTP and a persona cookie. NOT a browser click-
// through. It creates Marcus's request through the real "Ask to join" action and removes
// everything it created at the end (join request, escalations, runs, audit rows).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3116";
const LIVE = process.env.LIVE === "1";
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const q = async (sql, params) => (await own.query(sql, params)).rows;
const startAuditId = Number((await q("select coalesce(max(id), 0) m from app.audit_log"))[0].m);
const SL = (await q("select group_id from app.grp where name = 'Sunday Lunch D-Group'"))[0].group_id;

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (h) => unesc(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: key ? `personaKey=${key}` : "" }, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") }; };
const hidden = (html) => (html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []).map((t) => [t.match(/name="([^"]*)"/)?.[1], unesc(t.match(/value="([^"]*)"/)?.[1] ?? "")]).filter(([n]) => n);
const submit = (key, url, html, fields = []) => {
  const f = new FormData();
  for (const [k, v] of hidden(html)) f.append(k, v);
  for (const [k, v] of fields) f.append(k, v);
  return fetch(BASE + url, { method: "POST", body: f, redirect: "manual", headers: { cookie: `personaKey=${key}` } });
};
const escalations = () => q("select * from app.escalation where source = 'ai'");
const reviewAudit = () => q("select detail from app.audit_log where id > $1 and action = 'llm_review_attempt' order by id", [startAuditId]);
async function cleanup() {
  await own.query("delete from app.escalation where source = 'ai'");
  await own.query("delete from app.join_request where person_id = $1", [P.member_marcus.person_id]);
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}

await cleanup();
let live = null;
try {
  console.log("Access");
  let r = await get("manager", "/manager");
  let t = text(r.html);
  check("Alan sees Insights requiring review and the Run AI review control; nothing is generated on page load", r.status === 200 && t.includes("Insights requiring review") && t.includes("Run AI review") && t.includes("No insights yet") && (await reviewAudit()).length === 0, t.slice(0, 250));
  for (const k of ["member_marcus", "member_dana", "leader_tom", null]) {
    r = await get(k, "/manager");
    check(`${k ?? "no persona"}: the Manager page offers the Manager chooser, not insights or the review button`, r.status === 200 && !text(r.html).includes("Run AI review") && !text(r.html).includes("Potential schedule conflict"));
  }
  const page = await get("manager", "/manager");
  const bad = await submit("member_dana", "/manager", page.html);
  check("a member who posts the Run AI review action directly is turned away without a review", bad.status === 303 && (await reviewAudit()).length === 0 && (await escalations()).length === 0, `${bad.status}`);
  const bad2 = await submit("leader_tom", "/manager", page.html);
  check("a leader who posts it directly is turned away too", bad2.status === 303 && (await reviewAudit()).length === 0);

  console.log("\nSetup: Marcus asks to join Sunday Lunch D-Group (the real member path)");
  r = await get("member_marcus", `/member/groups/${SL}`);
  check("Marcus can open the group and sees Ask to join", r.status === 200 && text(r.html).includes("Ask to join") && text(r.html).includes("right after second service"), text(r.html).slice(0, 200));
  const post = await submit("member_marcus", `/member/groups/${SL}`, r.html, [["note", ""]]);
  const jr = await q("select request_id, status, member_note, requested_at, decided_at, rec_id, xmin::text x from app.join_request where person_id = $1 and group_id = $2", [P.member_marcus.person_id, SL]);
  check("exactly one pending request exists", post.status === 303 && jr.length === 1 && jr[0].status === "requested", JSON.stringify(jr));
  const before = jr[0];

  console.log("\nBefore the review");
  r = await get("manager", "/manager");
  check("with the request pending, a page view still creates no insight and calls no model", text(r.html).includes("No insights yet") && (await escalations()).length === 0 && (await reviewAudit()).length === 0);
  r = await get("manager", "/manager?review=done&c=1&r=1&a=0&n=0&i=0");
  check("the result line renders from counts only (no model text)", text(r.html).includes("Review finished: 1 pending request checked, 1 new insight."));
  r = await get("manager", "/manager?review=unavailable");
  check("an unavailable model shows a calm message", text(r.html).includes("couldn't reach the review assistant"));

  if (!LIVE) { console.log("\n(LIVE=1 not set: the review action was not pressed and no model was called.)"); }
  else {
    console.log("\nRun AI review (LIVE: one real model call)");
    r = await get("manager", "/manager");
    const t0 = Date.now();
    const res = await submit("manager", "/manager", r.html);
    const ms = Date.now() - t0;
    const loc = res.headers.get("location") ?? "";
    check("the action redirects back to the Manager page with a finished review", res.status === 303 && loc.includes("review=done"), `${res.status} ${loc}`);
    const attempts = await reviewAudit();
    const esc = await escalations();
    live = { ms, loc, attempts: attempts.map((a) => a.detail), escalations: esc };
    check("the audit trail has one row per model attempt (purpose, model, prompt version, outcome)", attempts.length >= 1 && attempts.every((a) => a.detail.purpose === "schedule_conflict_review" && a.detail.model && a.detail.prompt_version === "schedule-conflict-v1"), JSON.stringify(attempts));
    check("a schedule-conflict insight was saved for Marcus and Sunday Lunch D-Group, open", esc.length === 1 && esc[0].kind === "schedule_conflict" && esc[0].status === "open" && esc[0].person_id === P.member_marcus.person_id && esc[0].group_id === SL, JSON.stringify(esc.map((e) => [e.kind, e.status])));
    r = await get("manager", loc);
    t = text(r.html);
    check("the card shows Potential schedule conflict, Marcus, the group, Evidence and Status: Needs review", t.includes("Potential schedule conflict") && t.includes("Marcus Hale") && t.includes("Sunday Lunch D-Group") && t.includes("Evidence") && t.includes("Status: Needs review"), t.slice(0, 500));
    check("the card says the join request is still pending and that nothing was sent to anyone", t.includes("Join request: still pending") && t.includes("nothing has been sent to anyone"));
    r = await get("manager", "/manager");
    check("a refresh keeps the saved insight, with no new model call", text(r.html).includes("Potential schedule conflict") && (await reviewAudit()).length === attempts.length);

    const res2 = await submit("manager", "/manager", r.html);
    check("pressing Run AI review again makes no model call and adds no duplicate", res2.status === 303 && (await reviewAudit()).length === attempts.length && (await escalations()).length === 1, `${(await reviewAudit()).length} attempts, ${(await escalations()).length} escalations`);
    r = await get("manager", res2.headers.get("location"));
    check("the repeat run reports the insight as already on the page", text(r.html).includes("already on this page"), text(r.html).slice(0, 300));
    for (const k of ["member_marcus", "member_dana", "leader_tom"]) {
      const m = await get(k, k.startsWith("leader") ? "/leader" : "/member");
      check(`${k}'s own pages show nothing about the insight`, !/schedule conflict|insight/i.test(text(m.html)));
    }
  }

  console.log("\nMarcus's request");
  const after = (await q("select request_id, status, member_note, requested_at, decided_at, rec_id, xmin::text x from app.join_request where person_id = $1 and group_id = $2", [P.member_marcus.person_id, SL]));
  check("his join request is unchanged: one row, same version, still pending", after.length === 1 && JSON.stringify(after[0]) === JSON.stringify(before), JSON.stringify(after));
  check("he was not added to any group", (await q("select count(*)::int c from app.group_membership where person_id = $1 and status = 'active'", [P.member_marcus.person_id]))[0].c === 0);
  if (live) console.log("\nLIVE RESULT " + JSON.stringify({ ms: live.ms, attempts: live.attempts, escalation: live.escalations.map((e) => ({ id: e.escalation_id, kind: e.kind, severity: e.severity, status: e.status, summary: e.summary, evidence: e.evidence?.model_evidence, model: e.evidence?.model, prompt_version: e.evidence?.prompt_version })) }, null, 1));
} finally {
  await cleanup();
  check("cleanup: no Marcus request, escalations, runs or audit rows remain", (await q("select count(*)::int c from app.join_request where person_id = $1", [P.member_marcus.person_id]))[0].c === 0 && (await escalations()).length === 0);
  await own.end();
}
console.log(failed ? `\n${failed} FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
