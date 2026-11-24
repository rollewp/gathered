// Gathered: tests for "member withdraws own pending request" and "Manager resolves an AI insight".
// No external LLM calls: the review model is an injected stub and a fetch spy proves nothing reaches
// the network during withdrawal or resolution.
//
//   npm run test:withdraw
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_withdraw_resolve.mjs
//
// Two-connection pattern: code under test uses gathered_app (RLS applies); the owner connection is
// used ONLY to read expected values and to remove exactly the rows THIS test creates. It never
// deletes by table, so a real demo state (a saved run, resolved history) is not touched. It refuses
// to start if Marcus already has a pending Sunday Lunch request (that is real demo state).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { requestToJoin } from "../lib/member.ts";
import { withdrawRequest } from "../lib/member.ts";
import { runScheduleReview, listInsights, resolveInsight } from "../lib/review/schedule-review.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 6 });

let networkCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { networkCalls++; return realFetch(...a); };

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
async function asPerson(role, personId, fn) {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [role, personId ?? ""]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const as = (key, fn) => asPerson(P[key].role, P[key].person_id, fn);
const q = async (sql, params) => (await own.query(sql, params)).rows;
// jsonb does not preserve key order, so compare with sorted keys
const canon = (v) => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
const MARCUS = "member_marcus", DANA = "member_dana", TOM = "leader_tom", ALAN = "manager";
const SL = (await q("select group_id from app.grp where name = 'Sunday Lunch D-Group'"))[0].group_id;

if ((await q("select 1 from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P[MARCUS].person_id, SL])).length) {
  console.error("Marcus already has a pending Sunday Lunch request (real demo state). Withdraw it first; this test will not touch it.");
  process.exit(2);
}

const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);
const startEsc = new Set((await q("select escalation_id from app.escalation")).map((r) => r.escalation_id));
const startReq = new Set((await q("select request_id from app.join_request where person_id = $1", [P[MARCUS].person_id])).map((r) => r.request_id));
const startRuns = new Set((await q("select run_id from app.recommendation_run")).map((r) => r.run_id));
let createdRun = null;

async function cleanup() {
  for (const r of await q("select request_id from app.join_request where person_id = $1", [P[MARCUS].person_id]))
    if (!startReq.has(r.request_id)) await own.query("delete from app.join_request where request_id = $1", [r.request_id]);
  for (const r of await q("select escalation_id from app.escalation")) if (!startEsc.has(r.escalation_id)) await own.query("delete from app.escalation where escalation_id = $1", [r.escalation_id]);
  for (const r of await q("select run_id from app.recommendation_run")) if (!startRuns.has(r.run_id)) {
    for (const t of ["recommendation", "recommendation_run_candidate"]) await own.query(`delete from app.${t} where run_id = $1`, [r.run_id]);
    await own.query("delete from app.recommendation_run where run_id = $1", [r.run_id]);
  }
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}

const GOOD = JSON.stringify({
  raise: true, kind: "schedule_conflict", severity: "medium",
  summary: "Marcus requested Sunday Lunch D-Group, which meets right after second service. He serves in the preschool room at second service, so he may routinely arrive late.",
  evidence: ["Pending request: Marcus to Sunday Lunch D-Group", "Serving: scheduled at the Sunday second service (11:00), kids area", "Group: meets right after second service"],
});
function stub(reply = GOOD) {
  const s = { calls: [], fn: async (facts, attempt) => { s.calls.push({ facts, attempt }); return { raw: reply, usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 }, latencyMs: 1, model: "stub-review-model" }; } };
  return s;
}
const reqRow = async (id) => (await q("select * from app.join_request where request_id = $1", [id]))[0];
const runsState = async () => q("select run_id, is_current, invalidated_at from app.recommendation_run where person_id = $1 order by run_id", [P[MARCUS].person_id]);
const profileJson = async () => (await q("select to_jsonb(m) j from app.member_profile m where person_id = $1", [P[MARCUS].person_id]))[0].j;
const audits = async (action, entityId) => q("select detail from app.audit_log where id > $1 and action = $2 and entity_id = $3 order by id", [startAuditId, action, entityId]);
const escForRequest = async (rid) => q("select * from app.escalation where source = 'ai' and (evidence->>'request_id') = $1", [rid]);
const memberships = async () => (await q("select count(*)::int c from app.group_membership"))[0].c;

try {
  // Marcus needs a saved recommendation run so we can prove withdrawal and resolution leave it alone.
  if (!(await runsState()).some((r) => r.is_current)) {
    await as(MARCUS, async (db) => {
      const sl = (await db.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((g) => g.group_id);
      await db.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], 'llm', 'medium', 'test', 'stub-model', $3, '{}'::jsonb)", [sl, sl.slice(0, 2), PROMPT_VERSION]);
    });
    createdRun = true;
  }
  const baseRuns = await runsState();
  assert(baseRuns.some((r) => r.is_current), "Marcus has a current run to protect");
  const baseProfile = await profileJson();
  const baseMembers = await memberships();

  console.log("Withdrawal");
  const NOTE = "SENSITIVE-NOTE-TEXT-do-not-audit";
  eq(await requestToJoin(MARCUS, SL, NOTE), { ok: true });
  const A = (await q("select request_id from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P[MARCUS].person_id, SL]))[0].request_id;
  const before = await reqRow(A);
  networkCalls = 0;
  let w1;
  await test("1. a member can withdraw their own pending request", async () => {
    w1 = await withdrawRequest(MARCUS, A);
    eq(w1, { ok: true, groupId: SL });
  });
  await test("2. the existing row becomes withdrawn and is kept; nothing else on it changes", async () => {
    const after = await reqRow(A);
    eq(after.status, "withdrawn");
    eq({ ...after, status: "x" }, { ...before, status: "x" }, "all other columns unchanged");
  });
  await test("3. withdrawal creates no membership", async () => {
    eq(await memberships(), baseMembers);
    eq((await q("select 1 from app.group_membership where person_id = $1 and group_id = $2", [P[MARCUS].person_id, SL])).length, 0);
  });
  await test("4. withdrawal does not invalidate or change recommendation runs, and does not touch the profile", async () => {
    eq(await runsState(), baseRuns);
    eq(await profileJson(), baseProfile);
  });
  await test("5. withdrawal makes zero model calls", async () => { eq(networkCalls, 0); });
  await test("10. the audit row carries only ids and statuses, never the note", async () => {
    const a = await audits("join_request_withdrawn", A);
    eq(a.length, 1);
    eq(Object.keys(a[0].detail).sort(), ["from_status", "group_id", "to_status"]);
    eq(canon(a[0].detail), canon({ group_id: SL, from_status: "requested", to_status: "withdrawn" }));
    const all = JSON.stringify(await q("select detail from app.audit_log where id > $1", [startAuditId]));
    assert(!all.includes(NOTE), "the note text appears in an audit row");
  });
  let B;
  await test("6. the member can ask to join the same group again afterwards (a new request)", async () => {
    eq(await requestToJoin(MARCUS, SL, null), { ok: true });
    B = (await q("select request_id from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P[MARCUS].person_id, SL]))[0].request_id;
    assert(B !== A, "a new request, not the old row revived");
    eq((await reqRow(A)).status, "withdrawn");
  });
  await test("7. another person cannot withdraw it: wrong member, leader and manager; a direct UPDATE finds nothing", async () => {
    eq(await withdrawRequest(DANA, B), { ok: false, code: "not_pending" });
    eq(await withdrawRequest(TOM, B), { ok: false, code: "not_allowed" });
    eq(await withdrawRequest(ALAN, B), { ok: false, code: "not_allowed" });
    const direct = await as(DANA, async (db) => (await db.query("update app.join_request set status = 'withdrawn' where request_id = $1", [B])).rowCount);
    eq(direct, 0, "RLS hides another member's request from a direct update");
    const memberDirect = await as(MARCUS, async (db) => {
      try { return (await db.query("update app.join_request set status = 'accepted' where request_id = $1", [B])).rowCount; } catch { return "denied"; }
    });
    assert(memberDirect === 0 || memberDirect === "denied", "a member cannot write their own status directly");
    eq((await reqRow(B)).status, "requested");
  });
  await test("8. a request that is not pending cannot be withdrawn (already withdrawn, declined)", async () => {
    eq(await withdrawRequest(MARCUS, A), { ok: false, code: "not_pending" });
    await own.query("update app.join_request set status = 'declined' where request_id = $1", [B]);
    eq(await withdrawRequest(MARCUS, B), { ok: false, code: "not_pending" });
    eq((await reqRow(B)).status, "declined");
    await own.query("update app.join_request set status = 'requested' where request_id = $1", [B]);
  });
  await test("9. a double submission withdraws once and rejects the other without corrupting state", async () => {
    const [x, y] = await Promise.all([withdrawRequest(MARCUS, B), withdrawRequest(MARCUS, B)]);
    eq([x.ok, y.ok].sort(), [false, true]);
    eq((await reqRow(B)).status, "withdrawn");
    eq((await audits("join_request_withdrawn", B)).length, 1, "one audit row");
    eq(await runsState(), baseRuns);
  });

  console.log("\nResolve");
  eq(await requestToJoin(MARCUS, SL, null), { ok: true });
  const C = (await q("select request_id from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P[MARCUS].person_id, SL]))[0].request_id;
  const s1 = stub();
  const r1 = await runScheduleReview(ALAN, { callModel: s1.fn });
  const E1 = (await escForRequest(C))[0]?.escalation_id;
  assert(E1 && r1.raised >= 1, "the review raised an insight for the pending request");
  const e1Before = (await q("select * from app.escalation where escalation_id = $1", [E1]))[0];

  await test("15. a member or leader cannot resolve it, and cannot change it with a direct UPDATE", async () => {
    for (const k of [MARCUS, DANA, TOM]) eq(await resolveInsight(k, E1), { ok: false, code: "forbidden" }, k);
    for (const k of [MARCUS, TOM]) {
      eq(await as(k, async (db) => (await db.query("select 1 from app.escalation where escalation_id = $1", [E1])).rowCount), 0, `${k} cannot read it`);
      eq(await as(k, async (db) => (await db.query("update app.escalation set status = 'resolved' where escalation_id = $1", [E1])).rowCount), 0, `${k} cannot update it`);
    }
    eq((await q("select status from app.escalation where escalation_id = $1", [E1]))[0].status, "open");
  });
  networkCalls = 0;
  const callsBeforeResolve = s1.calls.length;
  await test("11. the Manager can resolve an open AI schedule-conflict insight", async () => {
    eq(await resolveInsight(ALAN, E1), { ok: true });
    const e = (await q("select status, resolved_by from app.escalation where escalation_id = $1", [E1]))[0];
    eq(e.status, "resolved");
    eq(e.resolved_by, (await q("select user_id from app.portal_user where person_id = $1", [P[ALAN].person_id]))[0].user_id);
  });
  await test("12. resolving keeps the escalation row and its evidence", async () => {
    const e = (await q("select * from app.escalation where escalation_id = $1", [E1]))[0];
    eq({ ...e, status: "x", resolved_by: null }, { ...e1Before, status: "x", resolved_by: null });
  });
  await test("13. the resolved insight is gone from the default open-insights list", async () => {
    assert(!(await listInsights(ALAN)).some((i) => i.escalation_id === E1));
  });
  await test("14. resolving writes an escalation_resolved audit row with ids and statuses only", async () => {
    const a = await audits("escalation_resolved", E1);
    eq(a.length, 1);
    eq(Object.keys(a[0].detail).sort(), ["from_status", "group_id", "kind", "person_id", "request_id", "source", "to_status"]);
    eq([a[0].detail.from_status, a[0].detail.to_status, a[0].detail.request_id], ["open", "resolved", C]);
    const text = JSON.stringify(a[0].detail);
    assert(!text.includes("preschool") && !text.includes("Marcus"), "no insight text or name in the audit row");
  });
  await test("16. resolving makes zero model calls", async () => { eq(networkCalls, 0); eq(s1.calls.length, callsBeforeResolve); });
  await test("the resolved insight changed nothing else: request still pending, run, profile and memberships as before", async () => {
    eq((await reqRow(C)).status, "requested");
    eq(await runsState(), baseRuns); eq(await profileJson(), baseProfile); eq(await memberships(), baseMembers);
  });
  await test("17. running the review again while the same request is pending does not recreate the resolved insight", async () => {
    const s2 = stub();
    const r2 = await runScheduleReview(ALAN, { callModel: s2.fn });
    assert(!s2.calls.some((c) => c.facts.request.requester_first_name === "Marcus"), "no model question about Marcus's reviewed request");
    eq((await escForRequest(C)).length, 1, "still exactly one insight for that request");
    eq((await escForRequest(C))[0].status, "resolved");
    assert(r2.alreadyRaised >= 1, "counted as already reviewed");
  });
  await test("20. resolving again is rejected without a second audit row; concurrent resolves resolve once", async () => {
    eq(await resolveInsight(ALAN, E1), { ok: false, code: "not_found" });
    eq((await audits("escalation_resolved", E1)).length, 1);
  });
  await test("18. withdrawing the original request removes it from review eligibility", async () => {
    eq(await withdrawRequest(MARCUS, C), { ok: true, groupId: SL });
    const s3 = stub();
    await runScheduleReview(ALAN, { callModel: s3.fn });
    assert(!s3.calls.some((c) => c.facts.request.requester_first_name === "Marcus"), "a withdrawn request is not reviewed");
    eq((await escForRequest(C)).length, 1, "history kept");
  });
  let E2, D;
  await test("19. a later new request for the same person and group is reviewed and may produce a new insight", async () => {
    eq(await requestToJoin(MARCUS, SL, null), { ok: true });
    D = (await q("select request_id from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P[MARCUS].person_id, SL]))[0].request_id;
    const s4 = stub();
    await runScheduleReview(ALAN, { callModel: s4.fn });
    eq(s4.calls.filter((c) => c.facts.request.requester_first_name === "Marcus").length, 1, "one model question for the new request");
    const rows = await escForRequest(D);
    eq(rows.length, 1); E2 = rows[0].escalation_id;
    assert(E2 !== E1);
    eq((await listInsights(ALAN)).filter((i) => i.first_name === "Marcus").map((i) => i.escalation_id), [E2], "only the new one is open");
  });
  await test("20b. two simultaneous resolves of the new insight resolve it once", async () => {
    const [x, y] = await Promise.all([resolveInsight(ALAN, E2), resolveInsight(ALAN, E2)]);
    eq([x.ok, y.ok].sort(), [false, true]);
    eq((await audits("escalation_resolved", E2)).length, 1);
  });
  await test("the double-click protection on the review itself still holds (two simultaneous reviews, one insight per request)", async () => {
    await own.query("update app.escalation set status = 'open', resolved_by = null where escalation_id = $1", [E2]);
    const s5 = stub();
    await Promise.all([runScheduleReview(ALAN, { callModel: s5.fn }), runScheduleReview(ALAN, { callModel: s5.fn })]);
    eq((await escForRequest(D)).length, 1);
    await resolveInsight(ALAN, E2);
  });
  await withdrawRequest(MARCUS, D);
  await test("end of loop: Marcus's run, profile and memberships are unchanged; no pending request or open insight remains", async () => {
    eq(await runsState(), baseRuns); eq(await profileJson(), baseProfile); eq(await memberships(), baseMembers);
    eq((await q("select 1 from app.join_request where person_id = $1 and status = 'requested'", [P[MARCUS].person_id])).length, 0);
    eq((await listInsights(ALAN)).filter((i) => i.first_name === "Marcus").length, 0);
  });
} finally {
  await cleanup();
  const left = {
    requests: (await q("select request_id from app.join_request where person_id = $1", [P[MARCUS].person_id])).filter((r) => !startReq.has(r.request_id)).length,
    escalations: (await q("select escalation_id from app.escalation")).filter((r) => !startEsc.has(r.escalation_id)).length,
    runs: (await q("select run_id from app.recommendation_run")).filter((r) => !startRuns.has(r.run_id)).length,
    audit: (await q("select count(*)::int c from app.audit_log where id > $1", [startAuditId]))[0].c,
  };
  await test("the database ends as it began: nothing this test created remains", async () => { eq(left, { requests: 0, escalations: 0, runs: 0, audit: 0 }); });
  await own.end(); await appPool.end();
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
