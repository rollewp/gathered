// Gathered: Manager schedule-conflict review tests (Marcus / Sunday Lunch D-Group).
// No external LLM calls: the review model is an injected stub and a fetch spy proves nothing
// reaches the network.
//
//   npm run test:schedule
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_schedule_review.mjs
//
// Two-connection pattern: the code under test uses gathered_app (RLS applies); the owner
// connection is used ONLY to read expected values and to remove the join request, escalations,
// runs and audit rows these tests create (the seed has no Marcus request: he makes it through the
// real "Ask to join" path, requestToJoin).
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { REVIEW_PROMPT_VERSION } from "../lib/review/schedule-conflict.mjs";
import { requestToJoin } from "../lib/member.ts";
import { runScheduleReview, listInsights, ReviewForbiddenError, ReviewUnavailableError } from "../lib/review/schedule-review.ts";

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
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
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
const MARCUS = "member_marcus", ALAN = "manager";
const SL = (await q("select group_id from app.grp where name = 'Sunday Lunch D-Group'"))[0].group_id;
const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);

async function cleanup() {
  await own.query("delete from app.escalation where source = 'ai'");
  await own.query("delete from app.join_request where person_id = $1", [P[MARCUS].person_id]);
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
const ids = async () => q("select escalation_id from app.escalation where source = 'ai'");
const attempts = async () => q("select detail from app.audit_log where id > $1 and action = 'llm_review_attempt' order by id", [startAuditId]);
const requestRow = async () => (await q("select request_id, person_id, group_id, status, member_note, requested_at, decided_at, rec_id, xmin::text x from app.join_request where person_id = $1 and group_id = $2", [P[MARCUS].person_id, SL]))[0];

const GOOD = (over = {}) => JSON.stringify({
  raise: true, kind: "schedule_conflict", severity: "medium",
  summary: "Marcus requested Sunday Lunch D-Group, which meets right after second service. He serves in the preschool room at second service, so he may routinely arrive late.",
  evidence: ["Pending request: Marcus to Sunday Lunch D-Group", "Serving: scheduled at the Sunday second service (11:00), kids area", "Group: meets right after second service"], ...over,
});
const NO = JSON.stringify({ raise: false, kind: "schedule_conflict", severity: "low", summary: "No conflict is shown by the supplied facts.", evidence: [] });
function stub(replies) {
  const s = { calls: [], fn: async (facts, attempt) => {
    s.calls.push({ facts, attempt });
    const r = typeof replies === "function" ? replies(attempt, facts) : replies[Math.min(s.calls.length - 1, replies.length - 1)];
    if (r instanceof Error) throw r;
    return { raw: r, usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.001 }, latencyMs: 5, model: "stub-review-model" };
  } };
  return s;
}

await cleanup();
// Marcus asks to join through the real member path; he also has a saved recommendation run, which must survive the review.
await as(MARCUS, async (db) => {
  const sl = (await db.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((g) => g.group_id);
  await db.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], 'llm', 'medium', 'test', 'stub-model', $3, '{}'::jsonb)", [sl, sl.slice(0, 2), PROMPT_VERSION]);
});
eq(await requestToJoin(MARCUS, SL, null), { ok: true });
const before = {
  request: await requestRow(),
  memberships: (await q("select count(*)::int c from app.group_membership"))[0].c,
  runs: await q("select run_id, is_current, invalidated_at from app.recommendation_run order by run_id"),
};
const expectedCandidates = (await q(`
  select jr.request_id from app.join_request jr join app.person_features pf using (person_id) join app.grp g using (group_id)
  where jr.status = 'requested' and exists (select 1 from unnest(coalesce(pf.busy_slots, '{}')) b where split_part(b, '_', 1) = split_part(g.meeting_slot, '_', 1))`)).length;
const auditBase = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);

console.log("Who can run the review");
await test("only the Manager can run it: members and leaders are refused before anything is read or sent", async () => {
  const s = stub([GOOD()]);
  for (const k of [MARCUS, "member_dana", "leader_tom"]) {
    let err; try { await runScheduleReview(k, { callModel: s.fn }); } catch (e) { err = e; }
    assert(err instanceof ReviewForbiddenError, `${k} was not refused: ${err}`);
  }
  let err; try { await runScheduleReview("nobody", { callModel: s.fn }); } catch (e) { err = e; }
  assert(err instanceof ReviewForbiddenError, "unknown persona refused");
  eq(s.calls.length, 0, "no model call");
  eq((await ids()).length, 0, "no escalation");
  eq((await attempts()).length, 0, "no audit rows");
});
await test("a non-Manager cannot even read the inputs: join requests of others, profiles and person_features are hidden by row-level security", async () => {
  const leader = await as("leader_tom", async (db) => ({
    profiles: (await db.query("select 1 from app.member_profile where person_id = $1", [P[MARCUS].person_id])).rowCount,
    features: (await db.query("select 1 from app.person_features where person_id = $1", [P[MARCUS].person_id])).rowCount,
    requests: (await db.query("select 1 from app.join_request where person_id = $1", [P[MARCUS].person_id])).rowCount,
  }));
  eq(leader, { profiles: 0, features: 0, requests: 0 });
  const member = await as("member_dana", async (db) => ({
    profiles: (await db.query("select 1 from app.member_profile where person_id = $1", [P[MARCUS].person_id])).rowCount,
    features: (await db.query("select 1 from app.person_features where person_id = $1", [P[MARCUS].person_id])).rowCount,
  }));
  eq(member, { profiles: 0, features: 0 });
});

console.log("\nReview input");
const s1 = stub([GOOD()]);
let run1;
await test("the review reads the real pending request, group description and schedule, and serving facts", async () => {
  networkCalls = 0;
  run1 = await runScheduleReview(ALAN, { callModel: s1.fn });
  assert(s1.calls.length >= 1, "model was asked");
  const f = s1.calls.find((c) => c.facts.request.requester_first_name === "Marcus").facts;
  const grp = (await q("select name, description, meeting_slot from app.grp where group_id = $1", [SL]))[0];
  eq(f.group.name, grp.name); eq(f.group.description, grp.description); eq(f.group.meeting_slot, grp.meeting_slot);
  const pf = (await q("select busy_slots, serving_areas from app.person_features where person_id = $1", [P[MARCUS].person_id]))[0];
  eq(f.requester_schedule.serving_slots.map((s) => s.slot), pf.busy_slots);
  eq(f.requester_schedule.serving_areas, pf.serving_areas);
  eq(f.requester_schedule.about_me, (await q("select about_me from app.member_profile where person_id = $1", [P[MARCUS].person_id]))[0].about_me);
  assert(f.requester_schedule.about_me.includes("preschool room"), "his own words about the preschool room");
});
await test("exactly the eligible candidates are sent (same-day serving overlap), one model question each", async () => {
  eq(run1.candidates, expectedCandidates);
  eq(s1.calls.length, expectedCandidates);
});
await test("the input excludes unrelated people and data: other requesters, ids, last name, attendance, scores, rationale, life stage, interests", async () => {
  const sent = JSON.stringify(s1.calls.map((c) => c.facts));
  for (const bad of ["Hale", "Leo", "Joanna", "Sam ", "Ryan", P[MARCUS].person_id, "attendance", "consistency", "signal", "tenure", "kids_age", "life_stage", "interests", "score", "rationale", "shortlist", "recommendation"])
    assert(!sent.includes(bad), `the model input contains "${bad}"`);
  for (const c of s1.calls) eq(Object.keys(c.facts).sort(), ["group", "request", "requester_schedule", "task"]);
});

console.log("\nA raised review");
let escId;
await test("a validated raise persists exactly one schedule-conflict escalation, open, linked to Marcus and the group", async () => {
  eq(run1.raised, 1);
  const rows = await q("select * from app.escalation where source = 'ai'");
  eq(rows.length, 1);
  const e = rows[0]; escId = e.escalation_id;
  eq([e.source, e.kind, e.severity, e.status, e.person_id, e.group_id], ["ai", "schedule_conflict", "medium", "open", P[MARCUS].person_id, SL]);
  assert(e.summary.includes("Sunday Lunch D-Group"), "summary kept");
});
await test("the stored evidence is the supplied facts plus the model's evidence, with model and prompt provenance", async () => {
  const e = (await q("select evidence from app.escalation where escalation_id = $1", [escId]))[0].evidence;
  eq(canon(e.supplied_facts), canon(s1.calls.find((c) => c.facts.request.requester_first_name === "Marcus").facts), "facts stored exactly as sent (jsonb does not keep key order)");
  eq(e.model_evidence, JSON.parse(GOOD()).evidence);
  eq([e.model, e.prompt_version, e.request_id], ["stub-review-model", REVIEW_PROMPT_VERSION, before.request.request_id]);
});
await test("the Manager can read the insight (names, group, evidence, request still pending)", async () => {
  const rows = await listInsights(ALAN);
  eq(rows.length, 1);
  eq([rows[0].first_name, rows[0].group_name, rows[0].status, rows[0].request_status], ["Marcus", "Sunday Lunch D-Group", "open", "requested"]);
  eq(rows[0].evidence.model_evidence.length, 3);
});
await test("members and leaders cannot read the escalation or its evidence", async () => {
  for (const k of [MARCUS, "member_dana", "leader_tom", "leader_grace"]) {
    eq((await as(k, (db) => db.query("select * from app.escalation"))).rows, [], `${k} sees escalations`);
  }
});
// Migration 0008: AI escalations are Manager-only; rule escalations keep their original access.
const slLeader = (await q("select person_id from app.group_leader where group_id = $1", [SL]))[0].person_id;
const tryInsert = (role, personId, source, status = "open") => asPerson(role, personId, (db) => db.query(
  `insert into app.escalation (escalation_id, source, kind, severity, group_id, person_id, summary, evidence, status)
   values (gen_random_uuid(), $1, 'schedule_conflict', 'low', $2, $3, 'x', '{}'::jsonb, $4)`, [source, SL, P[MARCUS].person_id, status]));
await test("the group's OWN leader cannot read the AI insight about their group", async () => {
  eq((await asPerson("leader", slLeader, (db) => db.query("select * from app.escalation"))).rows, []);
  eq((await asPerson("leader", slLeader, (db) => db.query("select * from app.escalation where group_id = $1", [SL]))).rows, []);
});
await test("members, leaders and a missing role cannot insert an AI escalation", async () => {
  for (const [role, id] of [["member", P[MARCUS].person_id], ["member", P.member_dana.person_id], ["leader", slLeader], ["leader", P.leader_tom.person_id], ["", ""]]) {
    let denied = false;
    try { await tryInsert(role, id, "ai"); } catch (e) { denied = /row-level security/i.test(e.message); }
    assert(denied, `${role || "no role"} inserted an AI escalation`);
  }
  eq((await ids()).length, 1, "no extra AI row");
});
await test("the Manager can still insert an AI escalation, and it must start open", async () => {
  await tryInsert("manager", P.manager.person_id, "ai");
  eq((await ids()).length, 2);
  let denied = false;
  try { await tryInsert("manager", P.manager.person_id, "ai", "resolved"); } catch (e) { denied = /row-level security/i.test(e.message); }
  assert(denied, "AI escalation inserted as already resolved");
  await own.query("delete from app.escalation where source = 'ai' and summary = 'x'");
  eq((await ids()).length, 1);
});
await test("rule escalations are unchanged: any role may insert an open one, the group's leader reads it, a non-leader member does not, and a non-manager still cannot update it", async () => {
  await tryInsert("member", P[MARCUS].person_id, "rule");
  eq((await asPerson("leader", slLeader, (db) => db.query("select * from app.escalation where source = 'rule'"))).rows.length, 1, "own leader reads rule row");
  eq((await asPerson("leader", P.leader_tom.person_id, (db) => db.query("select * from app.escalation where source = 'rule' and group_id = $1", [SL]))).rows.length, slLeader === P.leader_tom.person_id ? 1 : 0);
  eq((await as("member_dana", (db) => db.query("select * from app.escalation where source = 'rule'"))).rows.length, 0);
  eq((await asPerson("leader", slLeader, (db) => db.query("update app.escalation set status = 'resolved' where source = 'rule'"))).rowCount, 0, "leader cannot update");
  eq((await as(ALAN, (db) => db.query("select * from app.escalation where source = 'rule'"))).rows.length, 1, "manager reads rule row");
  await own.query("delete from app.escalation where source = 'rule'");
});
await test("a second run with unchanged data makes no model call and creates no duplicate", async () => {
  const s = stub([GOOD()]);
  const again = await runScheduleReview(ALAN, { callModel: s.fn });
  eq(s.calls.length, 0, "no model call for an already-raised candidate");
  eq(again.alreadyRaised >= 1 && again.raised === 0, true);
  eq((await ids()).length, 1);
});
await test("two reviews at the same moment still create exactly one insight (serialised per person and group)", async () => {
  await own.query("delete from app.escalation where source = 'ai'");
  const sa = stub([GOOD()]), sb = stub([GOOD()]);
  await Promise.all([runScheduleReview(ALAN, { callModel: sa.fn }), runScheduleReview(ALAN, { callModel: sb.fn })]);
  eq((await ids()).length, 1);
});
await test("an acknowledged insight is not raised again either", async () => {
  await own.query("update app.escalation set status = 'acknowledged' where source = 'ai'");
  const s = stub([GOOD()]);
  await runScheduleReview(ALAN, { callModel: s.fn });
  eq(s.calls.length, 0);
  eq((await ids()).length, 1);
  await own.query("update app.escalation set status = 'open' where source = 'ai'");
});

console.log("\nNot raised, invalid and unavailable");
await test("raise:false stores nothing", async () => {
  await own.query("delete from app.escalation where source = 'ai'");
  const s = stub([NO]);
  const r = await runScheduleReview(ALAN, { callModel: s.fn });
  eq([r.raised, r.notRaised >= 1, (await ids()).length], [0, true, 0]);
});
await test("invalid output is retried once and then dropped: two attempts, nothing stored", async () => {
  const s = stub(["Marcus might be late.", "{ nope"]);
  const r = await runScheduleReview(ALAN, { callModel: s.fn });
  eq(s.calls.length, 2 * expectedCandidates, "two attempts per candidate");
  eq([r.invalid, r.raised, (await ids()).length], [expectedCandidates, 0, 0]);
});
await test("a wrong kind, an unsupported severity and an invented time are each rejected as invalid", async () => {
  for (const bad of [GOOD({ kind: "needs_care" }), GOOD({ severity: "critical" }), GOOD({ summary: "He may arrive 30-40 minutes late." }), GOOD({ evidence: [] })]) {
    const s = stub([bad, bad]);
    await runScheduleReview(ALAN, { callModel: s.fn });
    eq((await ids()).length, 0, `stored something for ${bad.slice(0, 60)}`);
  }
});
await test("an invalid first reply followed by a valid second reply is accepted (the established single retry)", async () => {
  const s = stub(["not json", GOOD()]);
  const r = await runScheduleReview(ALAN, { callModel: s.fn });
  eq([r.raised, (await ids()).length], [1, 1]);
  await own.query("delete from app.escalation where source = 'ai'");
});
await test("model unavailable: the run fails with no partial escalation, after the limited two attempts", async () => {
  const s = stub([new Error("network down")]);
  let err; try { await runScheduleReview(ALAN, { callModel: s.fn }); } catch (e) { err = e; }
  assert(err instanceof ReviewUnavailableError, `expected unavailable, got ${err}`);
  eq(s.calls.length, 2);
  eq((await ids()).length, 0);
});

console.log("\nAudit");
await test("every model attempt is audited with purpose, model, prompt version, attempt and outcome; no prompt, facts or about_me", async () => {
  const rows = await attempts();
  assert(rows.length > 0, "attempt rows exist");
  const outcomes = new Set(rows.map((r) => r.detail.outcome));
  for (const o of ["ok", "invalid_output", "error"]) assert(outcomes.has(o), `outcome ${o} recorded`);
  for (const r of rows) {
    eq(r.detail.purpose, "schedule_conflict_review"); eq(r.detail.prompt_version, REVIEW_PROMPT_VERSION);
    assert([1, 2].includes(r.detail.attempt), "attempt number");
  }
  const text = JSON.stringify(rows);
  assert(!/preschool|Sunday Lunch|about_me|supplied_facts|system|Marcus/i.test(text), "audit rows leak review content");
  assert(rows.some((r) => r.detail.model === "stub-review-model" && r.detail.total_tokens === 140 && r.detail.latency_ms === 5), "model, tokens and latency recorded");
});
await test("the number of audit rows equals the number of model attempts made in the earlier runs", async () => {
  // run1 + duplicate-run(0) + 2 concurrent + acknowledged(0) + not-raised + invalid (2 each) + 4 bad kinds (2 each) + retry(2) + unavailable(2)
  const n = expectedCandidates;
  const expected = n /*run1*/ + 2 * n /*concurrent*/ + n /*no*/ + 2 * n /*invalid*/ + 4 * 2 * n /*bad shapes*/ + 2 * n /*retry*/ + 2 /*unavailable stops at the first candidate*/;
  eq((await attempts()).length, expected);
});
await test("a created escalation writes one escalation_created audit row naming provenance, not content", async () => {
  const rows = await q("select * from app.audit_log where id > $1 and action = 'escalation_created'", [startAuditId]);
  assert(rows.length >= 1 && rows.every((r) => r.actor_user_id && r.entity === "escalation"), "rows with actor");
  assert(!/preschool|about_me|summary/i.test(JSON.stringify(rows.map((r) => r.detail))), "no content in audit detail");
});

console.log("\nNo side effects");
await test("Marcus's join request is unchanged (same row version, still pending)", async () => {
  eq(await requestRow(), before.request);
});
await test("group membership is unchanged", async () => eq((await q("select count(*)::int c from app.group_membership"))[0].c, before.memberships));
await test("recommendation runs are not invalidated or created by the review", async () => {
  eq(await q("select run_id, is_current, invalidated_at from app.recommendation_run order by run_id"), before.runs);
});
await test("no network call and no recommendation or escalation row other than the AI insight", async () => {
  eq(networkCalls, 0);
  eq((await q("select count(*)::int c from app.escalation where source <> 'ai'"))[0].c, 0);
});

await cleanup();
await test("the database ends as it began: no Marcus request, no escalations, no runs, no audit rows added", async () => {
  eq((await q("select count(*)::int c from app.join_request where person_id = $1", [P[MARCUS].person_id]))[0].c, 0);
  eq((await q("select count(*)::int c from app.escalation"))[0].c, 0);
  eq((await q("select count(*)::int c from app.recommendation_run"))[0].c, 0);
  eq((await q("select count(*)::int c from app.audit_log where id > $1", [startAuditId]))[0].c, 0);
});
void auditBase;

await own.end(); await appPool.end();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
