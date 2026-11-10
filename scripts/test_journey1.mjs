// Gathered: Journey 1 regression tests (member join requests and member-side visibility).
// No external LLM calls: recommendation runs are created with a canned ranking.
//
//   npm run test:journey1
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_journey1.mjs
//
// Same two-connection pattern as test_recommendations.mjs: the app connection (gathered_app, RLS
// applies) does everything the application does; the owner connection is used ONLY for fixtures
// and cleanup. Created join requests, runs and audit rows are removed at the start and end.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { requestToJoin, getMyRequests } from "../lib/member.ts";
import { getRecommendations, peekRecommendations } from "../lib/recommendations.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 6 });

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
const assert = (c, m) => { if (!c) throw new Error(m ?? "assertion failed"); };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
async function throws(fn, pattern, msg) {
  try { await fn(); } catch (e) { if (pattern && !pattern.test(e.message)) throw new Error(`${msg ?? "wrong error"}: ${e.message}`); return e; }
  throw new Error(`${msg ?? "expected an error"} but none was thrown`);
}
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
const DENIED = /permission denied|row-level security|manager only/i;
const TEST_PEOPLE = ["member_dana", "member_marcus", "member_priya"].map((k) => P[k].person_id);
const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);

async function cleanup() {
  await own.query("delete from app.join_request where person_id = any($1::uuid[])", [TEST_PEOPLE]);
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
async function stubRun(personKey) {
  return as(personKey, async (db) => {
    const ids = (await db.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((g) => g.group_id);
    const n = Math.min(3, ids.length);
    const r = await db.query(
      "select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'medium', 'test', 'stub-model', $4, '{}'::jsonb) as run_id",
      [ids, ids.slice(0, n), n === 0 ? "no_candidates" : "llm", PROMPT_VERSION]);
    return { runId: r.rows[0].run_id, ids: ids.slice(0, n) };
  });
}
const join = (key, groupId, note = null) => as(key, (c) => c.query("select app.request_to_join($1, $2) as id", [groupId, note]));

await cleanup();

console.log("Join requests (app.request_to_join)");
const dana = await stubRun("member_dana");
const target = dana.ids[0];
let danaRequestId;

await test("a recommended group can be requested: status requested, linked to the recommendation row, with the note", async () => {
  danaRequestId = (await join("member_dana", target, "  Hi, I'd love to join.  ")).rows[0].id;
  const jr = (await q("select * from app.join_request where request_id = $1", [danaRequestId]))[0];
  eq([jr.status, jr.person_id, jr.group_id, jr.member_note], ["requested", P.member_dana.person_id, target, "Hi, I'd love to join."]);
  const rec = (await q("select rec_id from app.recommendation where run_id = $1 and group_id = $2", [dana.runId, target]))[0];
  eq(jr.rec_id, rec.rec_id, "rec_id links the recommendation row");
  assert(jr.requested_at && !jr.decided_at, "requested_at set, not decided");
});
await test("one audit_log row is written, without the note text", async () => {
  const rows = await q("select * from app.audit_log where action = 'join_request_created' and id > $1", [startAuditId]);
  eq(rows.length, 1);
  eq([rows[0].entity, rows[0].entity_id], ["join_request", danaRequestId]);
  assert(rows[0].actor_user_id, "actor recorded");
  assert(!JSON.stringify(rows[0].detail).includes("love to join"), "note text must not be in the audit row");
  eq(rows[0].detail.note_provided, true);
});
await test("creating a request does not invalidate the member's recommendation run (architecture §6.3)", async () => {
  eq((await q("select count(*)::int c from app.recommendation_run where person_id = $1 and is_current", [P.member_dana.person_id]))[0].c, 1);
});
await test("a second request for the same group is rejected (duplicate_request); only one open row", async () => {
  await throws(() => join("member_dana", target), /duplicate_request/);
  eq((await q("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [P.member_dana.person_id, target]))[0].c, 1);
});
await test("concurrent duplicate submissions create exactly one request", async () => {
  const g = dana.ids[1];
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => join("member_dana", g)));
  eq(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one succeeds");
  assert(results.filter((r) => r.status === "rejected").every((r) => /duplicate_request/.test(r.reason.message)), "the rest are duplicates");
  eq((await q("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2", [P.member_dana.person_id, g]))[0].c, 1);
});
await test("a group outside the member's recommendations may be requested, with rec_id left empty", async () => {
  const marcus = await stubRun("member_marcus");
  const other = (await q("select group_id from app.grp where status in ('open','forming') and gender_focus in ('men','mixed','couples') and group_id <> all($1::uuid[]) limit 1", [marcus.ids]))[0].group_id;
  const id = (await join("member_marcus", other)).rows[0].id;
  eq((await q("select rec_id from app.join_request where request_id = $1", [id]))[0].rec_id, null);
});

console.log("\nRejected requests");
await test("ineligible callers are rejected: member in a group (Ruth), no profile (Jordan), the Manager, a leader in their own group", async () => {
  for (const k of ["member_ruth", "member_jordan", "manager", "leader_tom"]) {
    await throws(() => join(k, target), /not_eligible/, k);
  }
});
await test("unknown, full/closed and gender-incompatible groups are rejected (group_unavailable)", async () => {
  await throws(() => join("member_priya", "00000000-0000-4000-8000-000000000000"), /group_unavailable/, "unknown group");
  const full = (await q("select group_id from app.grp where status = 'full' limit 1"))[0].group_id;
  await throws(() => join("member_priya", full), /group_unavailable/, "full group");
  const men = (await q("select group_id from app.grp where gender_focus = 'men' and status in ('open','forming') limit 1"))[0].group_id;
  await throws(() => join("member_dana", men), /group_unavailable/, "men's group for a woman");
});
await test("an active member cannot ask to join the group they are already in (Ruth)", async () => {
  const g = (await q("select group_id from app.group_membership where person_id = $1 and status = 'active' limit 1", [P.member_ruth.person_id]))[0].group_id;
  await throws(() => join("member_ruth", g), /not_eligible/);
  eq((await q("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2", [P.member_ruth.person_id, g]))[0].c, 0);
});
await test("a request is always made as the selected persona: the function takes no person id, and a forged one cannot be inserted", async () => {
  // Dana's session cannot create a request for Priya, either through the function (no such parameter) or directly.
  await throws(() => as("member_dana", (c) => c.query("select app.request_to_join($1, null, $2)", [target, P.member_priya.person_id])), /does not exist|function/i, "extra person argument");
  await throws(() => as("member_dana", (c) => c.query("insert into app.join_request (request_id, person_id, group_id, status, requested_at) values (gen_random_uuid(), $1, $2, 'requested', now())", [P.member_priya.person_id, target])), DENIED, "direct insert for another person");
  eq((await q("select count(*)::int c from app.join_request where person_id = $1", [P.member_priya.person_id]))[0].c, 0, "Priya has no requests");
});
await test("members and leaders cannot read the audit log directly or through the Manager audit function", async () => {
  for (const k of ["member_dana", "leader_tom"]) {
    // Row-level security filters the table to nothing for non-managers (no error), while rows exist.
    eq((await as(k, (c) => c.query("select id from app.audit_log"))).rowCount, 0, `${k} sees no audit rows`);
    await throws(() => as(k, (c) => c.query("select * from app.manager_recommendation_audit()")), /manager only|permission denied/i, `${k} manager audit`);
  }
  assert((await as("manager", (c) => c.query("select id from app.audit_log"))).rowCount > 0, "the Manager can read the audit rows that exist");
});
await test("note over 500 characters is rejected", async () => {
  await throws(() => join("member_priya", dana.ids[2] ?? target, "x".repeat(501)), /note_too_long/);
});
await test("members cannot write join_request directly or alter status", async () => {
  await throws(() => as("member_priya", (c) => c.query("insert into app.join_request (request_id, person_id, group_id, status, requested_at) values (gen_random_uuid(), app._person(), $1, 'accepted', now())", [target])), DENIED, "direct insert");
  const res = await as("member_dana", (c) => c.query("update app.join_request set status = 'accepted' where request_id = $1", [danaRequestId]));
  eq(res.rowCount, 0, "a member's update of their own request matches no rows");
  eq((await q("select status from app.join_request where request_id = $1", [danaRequestId]))[0].status, "requested");
});

console.log("\nVisibility");
await test("my_join_requests returns only the caller's requests, with the leader's first name", async () => {
  const mine = await as("member_dana", async (c) => (await c.query("select * from app.my_join_requests()")).rows);
  assert(mine.length >= 1 && mine.every((r) => r.status === "requested"), "rows");
  const row = mine.find((r) => r.request_id === danaRequestId);
  assert(row && typeof row.leader_first_name === "string" && row.leader_first_name.length > 0, "leader first name present");
  eq(await as("member_priya", async (c) => (await c.query("select * from app.my_join_requests()")).rows), [], "other members see none");
});
await test("a member cannot read other members' join requests", async () => {
  eq(await as("member_marcus", async (c) => (await c.query("select 1 from app.join_request where person_id = $1", [P.member_dana.person_id])).rows), []);
});
await test("the leader of the requested group sees the request (name and note); other leaders do not", async () => {
  const leaderOf = (await q("select person_id from app.group_leader where group_id = $1", [target]))[0].person_id;
  const seen = await asPerson("leader", leaderOf, async (c) => (await c.query("select request_id, member_note from app.join_request where request_id = $1", [danaRequestId])).rows);
  eq(seen.length, 1); eq(seen[0].member_note, "Hi, I'd love to join.");
  const otherLeader = (await q("select person_id from app.group_leader where group_id <> $1 and person_id <> $2 limit 1", [target, leaderOf]))[0].person_id;
  eq(await asPerson("leader", otherLeader, async (c) => (await c.query("select 1 from app.join_request where request_id = $1", [danaRequestId])).rows), []);
});
await test("the member read path exposes no score, shortlist, rationale or model fields", async () => {
  const requests = await getMyRequests("member_dana");
  assert(!JSON.stringify(requests).match(/score|rationale|prompt|model|shortlist/i), "my requests payload");
  const peek = await peekRecommendations("member_dana");
  eq(peek.status, "ok");
  eq(Object.keys(peek.groups[0]).sort(), ["area_label", "childcare", "description", "group_id", "is_online", "meeting_slot", "name", "open_seats", "rank", "tags"], "recommended group fields");
  eq(peek.groups.map((g) => g.rank), [1, 2, 3]);
});

console.log("\nApplication layer");
await test("requestToJoin (the server-side helper) maps database rules to codes", async () => {
  const ok = await requestToJoin("member_priya", (await q("select group_id from app.grp where status = 'open' and gender_focus in ('women','mixed') limit 1"))[0].group_id, null);
  eq(ok, { ok: true });
  const g = (await q("select group_id from app.join_request where person_id = $1", [P.member_priya.person_id]))[0].group_id;
  eq(await requestToJoin("member_priya", g, null), { ok: false, code: "duplicate_request" });
  eq(await requestToJoin("member_ruth", g, null), { ok: false, code: "not_eligible" });
  eq(await requestToJoin("member_priya", "00000000-0000-4000-8000-000000000000", null), { ok: false, code: "group_unavailable" });
});
await test("reuse: with a current run, requesting recommendations makes zero model calls", async () => {
  let calls = 0;
  const r = await getRecommendations("member_dana", { callModel: async () => { calls++; throw new Error("must not be called"); } });
  assert(r.status === "ok" && r.source === "reused" && r.llmAttempts === 0 && calls === 0, "reused, zero calls");
});

await cleanup();
await own.end(); await appPool.end();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
