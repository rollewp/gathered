// Gathered: "Withdraw request" and "Resolve insight" HTTP smoke test against a RUNNING app.
//
//   1. npm run build
//   2. OPENROUTER_API_KEY= npx next start -p 3118      (blank key: a review can never reach a model)
//   3. BASE_URL=http://localhost:3118 node --env-file=.env.local scripts/smoke_withdraw_resolve.mjs
//
// Drives real pages and the real server actions with plain HTTP and a persona cookie. NOT a browser
// click-through. It starts from whatever demo state exists and ENDS in the clean demo state (no
// pending Marcus -> Sunday Lunch request, no open Marcus insight); historical withdrawn requests and
// resolved insights remain, as intended. It deletes nothing. It makes no model call.
//
// If Marcus already has a pending request and an open insight (the state Journey 4 leaves), those
// real rows are the ones resolved and withdrawn. If not, it creates the request through the real
// "Ask to join" action; the insight steps are then skipped (a new insight needs a model call, which
// the stubbed tests in test_withdraw_resolve.mjs cover).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3118";
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const q = async (sql, params) => (await own.query(sql, params)).rows;
const SL = (await q("select group_id from app.grp where name = 'Sunday Lunch D-Group'"))[0].group_id;
const startAuditId = Number((await q("select coalesce(max(id), 0) m from app.audit_log"))[0].m);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (h) => unesc(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: key ? `personaKey=${key}` : "" }, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") ?? "" }; };
const hidden = (html) => (html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []).map((t) => [t.match(/name="([^"]*)"/)?.[1], unesc(t.match(/value="([^"]*)"/)?.[1] ?? "")]).filter(([n]) => n);
// post the hidden fields of ONE form (the one whose aria-label matches) as another persona would
const formFields = (html, label) => { const m = html.match(new RegExp(`<form[^>]*aria-label="${label}"[\\s\\S]*?</form>`)); return m ? hidden(m[0]) : []; };
const post = (key, url, fields) => { const f = new FormData(); for (const [k, v] of fields) f.append(k, v); return fetch(BASE + url, { method: "POST", body: f, redirect: "manual", headers: { cookie: `personaKey=${key}` } }); };
const pending = () => q("select request_id, status, member_note, requested_at, decided_at, rec_id from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P.member_marcus.person_id, SL]);
const openInsights = () => q("select escalation_id, status, evidence from app.escalation where source = 'ai' and kind = 'schedule_conflict' and person_id = $1 and status in ('open','acknowledged')", [P.member_marcus.person_id]);
const runs = () => q("select run_id, is_current, invalidated_at from app.recommendation_run order by run_id");
const audit = (action) => q("select entity_id, detail from app.audit_log where id > $1 and action = $2 order by id", [startAuditId, action]);

const runsBefore = await runs();
const membersBefore = (await q("select count(*)::int c from app.group_membership"))[0].c;
const modelAttemptsBefore = (await q("select count(*)::int c from app.audit_log where action = 'llm_review_attempt'"))[0].c;
let r, t;

console.log("Start state");
let pend = await pending();
if (!pend.length) {
  r = await get("member_marcus", `/member/groups/${SL}`);
  check("no pending request: Marcus sees Ask to join", text(r.html).includes("Ask to join"));
  const res = await post("member_marcus", `/member/groups/${SL}`, hidden(r.html).concat([["note", ""]]));
  pend = await pending();
  check("he asks to join through the real action and one pending request exists", res.status === 303 && pend.length === 1);
}
const A = pend[0];
const insights = await openInsights();
const haveInsight = insights.length === 1 && insights[0].evidence?.request_id === A.request_id;
console.log(`  (pending request ${A.request_id.slice(0, 8)}…; open insight for it: ${haveInsight ? "yes" : "no"})`);

console.log("\nMember: pending state and Withdraw control");
r = await get("member_marcus", `/member/groups/${SL}`);
t = text(r.html);
check("Marcus sees Request sent · Pending and a Withdraw request control, and no Ask to join form", t.includes("Request sent · Pending") && t.includes("Withdraw request") && !t.includes("Introduce yourself"), t.slice(0, 300));
check("the withdrawal needs an explicit confirmation step (a separate confirm form, not a link)", t.includes("Yes, withdraw"));
const wfields = formFields(r.html, "Confirm withdrawing your request");
check("the confirm form carries only the request id and group id", wfields.map(([k]) => k).filter((k) => !k.startsWith("$ACTION")).sort().join(",") === "groupId,requestId", JSON.stringify(wfields.map(([k]) => k)));
for (const k of ["member_dana", "leader_tom", "manager"]) {
  r = await get(k, `/member/groups/${SL}`);
  check(`${k}: sees no Withdraw request control for Marcus's request`, !text(r.html).includes("Yes, withdraw"));
}

console.log("\nSecurity: another persona posting Marcus's withdraw form");
for (const k of ["member_dana", "leader_tom", "manager", null]) {
  const res = await post(k ?? "nobody", `/member/groups/${SL}`, wfields);
  const still = await pending();
  check(`${k ?? "no persona"}: cannot withdraw Marcus's request (still pending, no audit row)`, still.length === 1 && still[0].request_id === A.request_id && (await audit("join_request_withdrawn")).length === 0, `${res.status}`);
}

console.log("\nManager: Resolve insight");
if (!haveInsight) console.log("  (skipped: no open insight for this request; a new insight needs a model call)");
else {
  r = await get("manager", "/manager");
  t = text(r.html);
  check("Alan sees the open insight with a Resolve insight control and a confirmation form", t.includes("Potential schedule conflict") && t.includes("Resolve insight") && t.includes("Yes, resolve") && t.includes("Join request: still pending"), t.slice(0, 300));
  const rfields = formFields(r.html, "Confirm resolving this insight");
  check("the confirm form carries only the escalation id", rfields.map(([k]) => k).filter((k) => !k.startsWith("$ACTION")).join(",") === "escalationId");
  for (const k of ["member_marcus", "member_dana", "leader_tom"]) {
    await post(k, "/manager", rfields);
    check(`${k}: cannot resolve it by posting the form (still open, no audit row)`, (await openInsights()).length === 1 && (await audit("escalation_resolved")).length === 0);
  }
  const before = (await q("select summary, evidence, severity, person_id, group_id from app.escalation where escalation_id = $1", [insights[0].escalation_id]))[0];
  const res = await post("manager", "/manager", rfields);
  check("Alan resolves it: redirected back with a confirmation line", res.status === 303 && (res.headers.get("location") ?? "").includes("notice=resolved"), `${res.status} ${res.headers.get("location")}`);
  const row = (await q("select status, summary, evidence, severity, person_id, group_id, resolved_by from app.escalation where escalation_id = $1", [insights[0].escalation_id]))[0];
  check("the escalation is kept, resolved, with its evidence unchanged", row.status === "resolved" && JSON.stringify(row.evidence) === JSON.stringify(before.evidence) && row.summary === before.summary && !!row.resolved_by);
  r = await get("manager", "/manager?notice=resolved");
  t = text(r.html);
  check("it has left Insights requiring review and the page confirms", !t.includes("Potential schedule conflict") && t.includes("Insight resolved") && t.includes("No insights yet"), t.slice(0, 300));
  check("an escalation_resolved audit row exists (ids and statuses only)", (await audit("escalation_resolved")).length === 1 && !JSON.stringify((await audit("escalation_resolved"))[0].detail).includes("preschool"));
  check("the join request is unchanged (still pending)", (await pending()).length === 1);
  const again = await post("manager", "/manager", rfields);
  check("pressing Resolve again is rejected calmly: no second audit row", (again.headers.get("location") ?? "").includes("notice=resolve_stale") && (await audit("escalation_resolved")).length === 1);
  const rerun = await get("manager", "/manager");
  check("the page offers Run AI review again but nothing was run (no model attempts were logged)", text(rerun.html).includes("Run AI review") && (await q("select count(*)::int c from app.audit_log where action = 'llm_review_attempt'"))[0].c === modelAttemptsBefore);
}

console.log("\nMember: withdraw");
r = await get("member_marcus", `/member/groups/${SL}`);
const res1 = await post("member_marcus", `/member/groups/${SL}`, formFields(r.html, "Confirm withdrawing your request"));
check("Marcus confirms: redirected to the group with a withdrawn notice", res1.status === 303 && (res1.headers.get("location") ?? "").includes("notice=withdrawn"), `${res1.status} ${res1.headers.get("location")}`);
const row = (await q("select status, member_note, requested_at, decided_at, rec_id from app.join_request where request_id = $1", [A.request_id]))[0];
check("the request row is kept as withdrawn; nothing else on it changed", row?.status === "withdrawn" && row.member_note === A.member_note && String(row.requested_at) === String(A.requested_at) && row.decided_at === null && row.rec_id === A.rec_id);
r = await get("member_marcus", `/member/groups/${SL}?notice=withdrawn`);
t = text(r.html);
check("the group shows Request withdrawn and Ask to join is available again", t.includes("Request withdrawn") && t.includes("Ask to join") && !t.includes("Request sent · Pending"), t.slice(0, 300));
check("the audit row is ids and statuses only; no membership; runs and memberships unchanged", (await audit("join_request_withdrawn")).length === 1
  && Object.keys((await audit("join_request_withdrawn"))[0].detail).sort().join(",") === "from_status,group_id,to_status"
  && JSON.stringify(await runs()) === JSON.stringify(runsBefore) && (await q("select count(*)::int c from app.group_membership"))[0].c === membersBefore);
const rep = await post("member_marcus", `/member/groups/${SL}`, wfields);
check("withdrawing the same request again is rejected calmly (no second audit row)", (rep.headers.get("location") ?? "").includes("notice=withdraw_stale") && (await audit("join_request_withdrawn")).length === 1);

console.log("\nMember: ask again, then return to the clean demo state");
r = await get("member_marcus", `/member/groups/${SL}`);
const ask = await post("member_marcus", `/member/groups/${SL}`, hidden(r.html).concat([["note", ""]]));
const pend2 = await pending();
check("Marcus can ask to join Sunday Lunch D-Group again: a NEW pending request", ask.status === 303 && pend2.length === 1 && pend2[0].request_id !== A.request_id);
r = await get("member_marcus", `/member/groups/${SL}`);
check("it shows Request sent · Pending again", text(r.html).includes("Request sent · Pending"));
await post("member_marcus", `/member/groups/${SL}`, formFields(r.html, "Confirm withdrawing your request"));
check("withdrawing it returns the clean demo state: no pending request, no open Marcus insight", (await pending()).length === 0 && (await openInsights()).length === 0);
check("zero model attempts were logged by this smoke test", (await q("select count(*)::int c from app.audit_log where action = 'llm_review_attempt'"))[0].c === modelAttemptsBefore);

await own.end();
console.log(failed ? `\n${failed} FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
