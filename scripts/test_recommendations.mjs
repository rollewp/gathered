// Gathered: Slice 1 stubbed regression/integration tests. NO external LLM calls: the ranking
// model is replaced by an injected stub, so this is cheap and repeatable (never calls OpenRouter).
//
//   npm run test:recommendations
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_recommendations.mjs
//
// Covers: shortlist parity with the reference implementation, eligibility, persistence and its
// integrity checks, reuse with zero ranking calls, every invalidation trigger (including no-op
// writes that must NOT invalidate), the leader-accept path with Leader RLS unchanged, empty runs,
// prompt-version invalidation, visibility/permissions by direct query, audit access, retry and
// fallback behaviour, and concurrency.
//
// Two real connections: the app connection (DATABASE_URL, gathered_app, RLS applies) does
// everything the application does; the owner connection (DATABASE_OWNER_URL) is used ONLY for
// fixtures and cleanup. Fixture changes are committed and undone explicitly; runs, test audit
// rows and fixtures are cleaned up at the start and end. Reseed afterwards for a pristine state:
//   node --env-file=.env.local scripts/load_seed.mjs && node --env-file=.env.local scripts/compute_person_features.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { readCsv } from "../lib/seed/csv.mjs";
import { parseLabels, partitionLabels, originalLabelMatcher } from "../lib/seed/eval-labels.mjs";
import { buildContext, shortlistFor } from "../lib/ranking/reference-shortlist.mjs";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { getRecommendations, peekRecommendations } from "../lib/recommendations.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) {
  if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
}
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 6 });

// ---------------------------------------------------------------- harness

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? "assertion failed"); }
function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
async function throws(fn, pattern, msg) {
  try { await fn(); } catch (e) { if (pattern && !pattern.test(e.message)) throw new Error(`${msg ?? "wrong error"}: ${e.message}`); return e; }
  throw new Error(`${msg ?? "expected an error"} but none was thrown`);
}

/** One request as gathered_app with the persona context, exactly as withPersona does. */
async function asPerson(role, personId, fn) {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [role, personId ?? ""]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback"); throw e; }
  finally { c.release(); }
}
const as = (key, fn) => asPerson(P[key].role, P[key].person_id, fn);
const q = async (sql, params) => (await own.query(sql, params)).rows;
const DENIED = /permission denied|manager only|row-level security|does not exist/i;

const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);
async function llmAuditRows() { return Number((await q("select count(*) from app.audit_log where action = 'llm_rank_attempt' and id > $1", [startAuditId]))[0].count); }
async function resetRuns() { await own.query("update app.join_request set rec_id = null where rec_id is not null"); for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`); }
async function cleanup() { await resetRuns(); await own.query("delete from app.audit_log where id > $1", [startAuditId]); }
const currentRuns = async (personKey) => q("select * from app.recommendation_run where person_id = $1 and is_current", [P[personKey].person_id]);
const allRuns = async (personKey) => q("select * from app.recommendation_run where person_id = $1 order by generated_at", [P[personKey].person_id]);

/** Persist a run the way the app does but with a canned ranking (no LLM). */
async function stubRun(personKey, { promptVersion = PROMPT_VERSION, outcome = "llm" } = {}) {
  return as(personKey, async (db) => {
    const sl = (await db.query("select * from app.recommendation_shortlist()")).rows;
    const ids = sl.map((g) => g.group_id);
    const n = Math.min(3, ids.length);
    const empty = n === 0;
    const r = await db.query(
      "select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'medium', 'test rationale', 'stub-model', $4, '{}'::jsonb) as run_id",
      [ids, ids.slice(0, n), empty ? "no_candidates" : outcome, promptVersion]);
    return { runId: r.rows[0].run_id, ids };
  });
}

console.log("Preconditions");
assert(Number((await q("select count(*) from app.person_features"))[0].count) > 0, "app.person_features is empty: run scripts/compute_person_features.mjs first");
await cleanup();

// ---------------------------------------------------------------- 1. deterministic stage parity

console.log("\n1. Deterministic shortlist (database function vs reference implementation)");
const qq = async (sql) => (await own.query(sql)).rows;
const ctx = buildContext({
  persons: await qq("select * from app.person"), households: await qq("select * from app.household"),
  profiles: await qq("select * from app.member_profile"), groups: await qq("select * from app.grp"),
  tags: await qq("select * from app.group_tag"), leaders: await qq("select * from app.group_leader"),
  activeMemberships: await qq("select * from app.group_membership where status = 'active'"),
  features: await qq("select * from app.person_features"),
});
// The label set is read from the file (no fixed count). outcome_type decides which tests apply; the original
// 14 labels are accounted for explicitly by identity (seed/stable_ids.json), not by position or count.
const labels = parseLabels(readCsv("eval_label.csv"));
const { ranking: rankingLabels, policyByType } = partitionLabels(labels);
const { entries: originalEntries, isOriginal } = originalLabelMatcher();
const dbShortlist = (personId) => asPerson("member", personId, async (c) => (await c.query("select * from app.recommendation_shortlist()")).rows);
async function assertParity(l) {
  const ref = shortlistFor(ctx, l.person_id);
  const db = await dbShortlist(l.person_id);
  eq(db.map((r) => r.group_id), ref.map((g) => g.group_id), `${l.label_key} shortlist order`);
  db.forEach((r, i) => {
    assert(Math.abs(Number(r.score) - ref[i].total) < 1e-3, `${l.label_key} score ${r.score} vs ${ref[i].total}`);
    for (const [k, v] of Object.entries(ref[i].breakdown)) assert(Math.abs(Number(r.score_breakdown[k]) - v) < 1e-3, `${l.label_key} breakdown.${k}`);
  });
  assert(db.length <= 6, "shortlist larger than 6");
  return db.map((r) => r.group_id);
}
await test("the label file is consistent with the V2 model and accounts for all 14 original labels", async () => {
  assert(labels.length > 0, "no labels");
  eq(originalEntries.length, 14, "stable_ids.json records 14 original labels");
  for (const e of originalEntries) {
    const hits = labels.filter((l) => l.label_key === e.key && l.person_id === e.person_id);
    eq(hits.length, 1, `original label ${e.key} appears exactly once`);
    assert(hits[0].outcome_type === "ranking" && hits[0].expected_group_id === e.expected_group_id && hits[0].acceptable_group_ids === e.acceptable_group_ids, `original label ${e.key} changed`);
  }
  assert(labels.filter(isOriginal).length === 14, "original labels not recognized");
});
await test("shortlist matches the reference implementation for every ranking evaluation label (ids, order, score, breakdown)", async () => {
  assert(rankingLabels.length >= 14, `expected at least the 14 original ranking labels, got ${rankingLabels.length}`);
  for (const l of rankingLabels) await assertParity(l);
});
await test("Shortlist Recall@6 in the database: the expected group is on every ranking label's shortlist; excluded groups never are", async () => {
  for (const l of rankingLabels) {
    const ids = await dbShortlist(l.person_id);
    const shortIds = ids.map((r) => r.group_id);
    assert(shortIds.includes(l.expected_group_id), `${l.label_key}: expected group missing from the shortlist`);
    for (const x of l.excluded) assert(!shortIds.includes(x), `${l.label_key}: excluded group ${x} is on the shortlist`);
  }
});
await test("policy labels: empty scenarios have no shortlist; excluded scenarios omit their groups; duplicate-pending and active-member facts hold in the database", async () => {
  for (const l of policyByType.empty ?? []) eq(await assertParity(l), [], `${l.label_key} (empty) shortlist`);
  for (const l of policyByType.excluded ?? []) {
    const ids = await assertParity(l);
    assert(ids.length > 0, `${l.label_key}: an excluded scenario should still have other candidates`);
    for (const x of l.excluded) assert(!ids.includes(x), `${l.label_key}: excluded group ${x} is on the shortlist`);
  }
  for (const l of policyByType.duplicate_pending ?? []) {
    const n = (await q("select count(*)::int c from app.join_request where person_id = $1 and group_id = $2 and status = 'requested'", [l.person_id, l.expected_group_id]))[0].c;
    eq(n, 1, `${l.label_key}: exactly one pending request`);
  }
  for (const l of policyByType.active_member ?? []) {
    const n = (await q("select count(*)::int c from app.group_membership where person_id = $1 and status = 'active'", [l.person_id]))[0].c;
    assert(n >= 1, `${l.label_key}: expected an active membership`);
  }
});
await test("shortlist rows carry status and open_seats for rank-v2", async () => {
  const rows = await as("member_dana", async (c) => (await c.query("select * from app.recommendation_shortlist()")).rows);
  assert(rows.length > 0 && rows.every((r) => ["forming", "open"].includes(r.status) && Number.isInteger(r.open_seats) && r.open_seats > 0), "status/open_seats missing or invalid");
});

console.log("\n2. Eligibility");
await test("member in an active group (Ruth): no shortlist, state in_group, no run can be written", async () => {
  eq(await as("member_ruth", async (c) => (await c.query("select * from app.recommendation_shortlist()")).rows), [], "shortlist");
  const st = await as("member_ruth", async (c) => (await c.query("select * from app.current_recommendation_run($1)", [PROMPT_VERSION])).rows[0]);
  eq(st.out_state, "in_group");
  await throws(() => as("member_ruth", (c) => c.query("select app.persist_recommendation_run('{}', '{}', 'no_candidates', null, null, null, null, null)")), /not_eligible/);
});
await test("member without a profile (Jordan) and the Manager: state no_profile", async () => {
  for (const k of ["member_jordan", "manager"]) {
    const st = await as(k, async (c) => (await c.query("select * from app.current_recommendation_run($1)", [PROMPT_VERSION])).rows[0]);
    eq(st.out_state, "no_profile", k);
  }
});

console.log("\n3. Persistence and integrity (persist_recommendation_run)");
await resetRuns();
await test("persisting stores the run, the full shortlist and the ordered rows; one current run", async () => {
  const { runId, ids } = await stubRun("member_dana");
  const run = (await q("select * from app.recommendation_run where run_id = $1", [runId]))[0];
  assert(run.is_current && run.outcome === "llm" && run.prompt_version === PROMPT_VERSION && run.model === "stub-model", "run provenance");
  eq((await q("select group_id from app.recommendation_run_candidate where run_id = $1 order by shortlist_position", [runId])).map((r) => r.group_id), ids, "shortlist retained in full and in order");
  eq((await q("select group_id from app.recommendation where run_id = $1 order by rank", [runId])).map((r) => r.group_id), ids.slice(0, 3), "ordered rows");
  assert((await q("select count(*)::int c from app.recommendation_run_candidate where run_id = $1 and score is not null and score_breakdown is not null", [runId]))[0].c === ids.length, "scores stored");
});
await test("a second run supersedes the first: old kept as invalid 'superseded', exactly one current", async () => {
  await stubRun("member_dana");
  const runs = await allRuns("member_dana");
  eq(runs.length, 2); eq(runs.filter((r) => r.is_current).length, 1);
  const old = runs.find((r) => !r.is_current);
  assert(old.invalidation_reason === "superseded" && old.invalidated_at, "old run not marked superseded");
});
await test("persist rejects: group off the shortlist, duplicates, wrong count, stale shortlist, bad fallback order", async () => {
  const { ids } = await as("member_dana", async (c) => ({ ids: (await c.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((r) => r.group_id) }));
  const outside = (await q("select group_id from app.grp where group_id <> all($1::uuid[]) limit 1", [ids]))[0].group_id;
  const call = (ranked, outcome = "llm", shortlist = ids) => as("member_dana", (c) =>
    c.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'low', 'x', 'm', $4, '{}')", [shortlist, ranked, outcome, PROMPT_VERSION]));
  await throws(() => call([ids[0], ids[1], outside]), /not on the shortlist/, "off-shortlist group");
  await throws(() => call([ids[0], ids[0], ids[1]]), /duplicate/, "duplicates");
  await throws(() => call([]), /expected 1 to 3 ranked/, "an llm ranking of zero groups");
  await throws(() => call(ids.slice(0, 4)), /expected 1 to 3 ranked/, "an llm ranking of four groups");
  await throws(() => call(ids.slice(0, 2), "score_fallback"), /score order/, "a score fallback must be the full top 3, not fewer");
  await throws(() => call(ids.slice(0, 3), "llm", ids.slice(1)), /shortlist_changed/, "stale shortlist");
  await throws(() => call([ids[1], ids[0], ids[2]], "score_fallback"), /score order/, "fallback not in score order");
  await throws(() => call([], "no_candidates"), /empty shortlist|no_candidates/, "empty outcome on non-empty shortlist");
  eq((await currentRuns("member_dana")).length, 1, "rejected writes must not disturb the current run");
});
await test("database constraint: a recommendation must reference a shortlisted candidate of its own run", async () => {
  const run = (await currentRuns("member_dana"))[0];
  const outside = (await q("select g.group_id from app.grp g where not exists (select 1 from app.recommendation_run_candidate c where c.run_id = $1 and c.group_id = g.group_id) limit 1", [run.run_id]))[0].group_id;
  await throws(() => own.query("insert into app.recommendation (run_id, person_id, group_id, rank) values ($1, $2, $3, 3)", [run.run_id, run.person_id, outside]), /foreign key|violates/);
});

console.log("\n4. Empty runs");
await resetRuns();
await test("no eligible group (Priya): valid empty run (outcome no_candidates, no candidates, no rows)", async () => {
  const { runId } = await stubRun("member_priya");
  const run = (await q("select * from app.recommendation_run where run_id = $1", [runId]))[0];
  assert(run.is_current && run.outcome === "no_candidates" && run.model === null && run.prompt_version === null, "empty run shape");
  eq((await q("select count(*)::int c from app.recommendation_run_candidate where run_id = $1", [runId]))[0].c, 0);
  eq((await q("select count(*)::int c from app.recommendation where run_id = $1", [runId]))[0].c, 0);
});
await test("an LLM outcome cannot be recorded for an empty shortlist", async () => {
  await throws(() => as("member_priya", (c) => c.query("select app.persist_recommendation_run('{}', '{}', 'llm', 'low', 'x', 'm', $1, '{}')", [PROMPT_VERSION])), /invalid_ranking/);
});

console.log("\n5. Visibility and permissions (direct queries as gathered_app)");
await resetRuns();
await stubRun("member_dana"); await stubRun("member_marcus");
await test("member reads only ordered groups of their own current run", async () => {
  const rows = await as("member_dana", async (c) => (await c.query("select * from app.recommendation order by rank")).rows);
  assert(rows.length === 3 && rows.every((r) => r.person_id === P.member_dana.person_id), "own rows only");
  eq(Object.keys(rows[0]).sort(), ["group_id", "person_id", "rank", "rec_id", "run_id"], "recommendation exposes ids and rank only");
  const run = await as("member_dana", async (c) => (await c.query("select run_id, is_current, generated_at from app.recommendation_run")).rows);
  eq(run.length, 1, "own current run only");
});
await test("member cannot read score, breakdown, shortlist, rationale, model or prompt version", async () => {
  for (const sql of [
    "select * from app.recommendation_run_candidate", "select score from app.recommendation_run_candidate",
    "select internal_rationale from app.recommendation_run", "select model, prompt_version from app.recommendation_run",
    "select confidence from app.recommendation_run", "select * from app.recommendation_run",
    "select invalidation_reason from app.recommendation_run", "select score_breakdown from app.recommendation",
  ]) await throws(() => as("member_dana", (c) => c.query(sql)), DENIED, sql);
});
await test("member cannot see another member's recommendations", async () => {
  eq(await as("member_dana", async (c) => (await c.query("select 1 from app.recommendation where person_id = $1", [P.member_marcus.person_id])).rows), []);
});
await test("no persona can write or invalidate run tables directly", async () => {
  for (const k of ["member_dana", "leader_tom", "manager"]) {
    for (const sql of [
      "update app.recommendation_run set is_current = true", "delete from app.recommendation_run",
      "insert into app.recommendation_run (person_id, outcome) values (app._person(), 'llm')",
      "insert into app.recommendation (run_id, person_id, group_id, rank) select run_id, person_id, group_id, 1 from app.recommendation limit 1",
      "delete from app.recommendation", "select app._invalidate_runs('superseded', '{}', null, null, true)",
    ]) await throws(() => as(k, (c) => c.query(sql)), DENIED, `${k}: ${sql}`);
  }
});
await test("leader cannot use the Manager audit; member cannot; Manager can", async () => {
  await throws(() => as("leader_tom", (c) => c.query("select * from app.manager_recommendation_audit()")), /manager only/);
  await throws(() => as("member_dana", (c) => c.query("select * from app.manager_recommendation_audit()")), /manager only/);
  const rows = await as("manager", async (c) => (await c.query("select * from app.manager_recommendation_audit($1)", [P.member_dana.person_id])).rows);
  assert(rows.length > 0 && rows[0].internal_rationale === "test rationale" && rows[0].score !== null && rows[0].score_breakdown, "audit rows lack hidden fields");
  assert(rows.some((r) => r.rank === 1) && rows.some((r) => r.rank === null), "audit should show both recommended and shortlisted-only groups");
});
await test("even the Manager cannot read hidden columns from the base tables", async () => {
  await throws(() => as("manager", (c) => c.query("select internal_rationale from app.recommendation_run")), DENIED);
  await throws(() => as("manager", (c) => c.query("select * from app.recommendation_run_candidate")), DENIED);
});

console.log("\n6. Invalidation triggers (committed fixtures, explicit undo)");
const DANA = P.member_dana.person_id, MARCUS = P.member_marcus.person_id;
async function shortlistGroups(personKey) {
  return (await q("select c.group_id from app.recommendation_run_candidate c join app.recommendation_run r on r.run_id = c.run_id where r.person_id = $1 and r.is_current", [P[personKey].person_id])).map((r) => r.group_id);
}
async function invalidationCase(name, { setup, doIt, undo, invalid = ["member_dana"], stay = [], reason }) {
  await test(name, async () => {
    await resetRuns();
    await stubRun("member_dana"); await stubRun("member_marcus");
    const ctxv = setup ? await setup() : {};
    const auditBefore = await llmAuditRows();
    try {
      await doIt(ctxv);
      // assert before undoing: the undo is itself a change and may invalidate more runs
      for (const k of invalid) {
        const runs = await allRuns(k);
        const first = runs[0];
        assert(!first.is_current && first.invalidated_at, `${k} run should be invalid`);
        if (reason) eq(first.invalidation_reason, reason, `${k} reason`);
        eq((await currentRuns(k)).length, 0, `${k} must have no current run (lazy: nothing regenerated)`);
        eq(runs.length, 1, `${k} must not be regenerated by invalidation`);
      }
      for (const k of stay) assert((await currentRuns(k)).length === 1, `${k} run should be unaffected`);
    } finally { if (undo) await undo(ctxv); }
    eq(await llmAuditRows(), auditBefore, "invalidation must make no LLM call");
  });
}
const onlyDana = async () => {
  const d = new Set(await shortlistGroups("member_dana")), m = new Set(await shortlistGroups("member_marcus"));
  const g = [...d].find((id) => !m.has(id));
  assert(g, "fixture needs a group on Dana's shortlist but not Marcus's");
  return { g };
};

await invalidationCase("profile change invalidates only that member's run (profile_changed)", {
  doIt: () => own.query("update app.member_profile set interests = array_append(coalesce(interests, '{}'), 'zz_test') where person_id = $1", [DANA]),
  undo: () => own.query("update app.member_profile set interests = array_remove(interests, 'zz_test') where person_id = $1", [DANA]),
  stay: ["member_marcus"], reason: "profile_changed",
});
await invalidationCase("NO-OP writes do not invalidate (same profile text, person_features recompute with identical values)", {
  doIt: async () => {
    await own.query("update app.member_profile set about_me = about_me, interests = interests where person_id = $1", [DANA]);
    await own.query("update app.person_features set computed_at = now() where person_id = $1", [DANA]);
    await own.query("update app.grp set name = name, status = status");
  },
  invalid: [], stay: ["member_dana", "member_marcus"],
});
await invalidationCase("shortlisted group's description changes: only runs that shortlisted it are invalid (group_changed)", {
  setup: onlyDana,
  doIt: ({ g }) => own.query("update app.grp set description = description || ' (edited)' where group_id = $1", [g]),
  undo: ({ g }) => own.query("update app.grp set description = replace(description, ' (edited)', '') where group_id = $1", [g]),
  stay: ["member_marcus"], reason: "group_changed",
});
await invalidationCase("shortlisted group becomes full: runs that shortlisted it are invalid", {
  setup: async () => { const { g } = await onlyDana(); return { g, orig: (await q("select status from app.grp where group_id = $1", [g]))[0].status }; },
  doIt: ({ g }) => own.query("update app.grp set status = 'full' where group_id = $1", [g]),
  undo: ({ g, orig }) => own.query("update app.grp set status = $2 where group_id = $1", [g, orig]),
  stay: ["member_marcus"], reason: "group_changed",
});
await invalidationCase("capacity increase can admit the group for anyone: ALL current runs invalid", {
  doIt: () => own.query("update app.grp set capacity_max = capacity_max + 1 where group_id = (select group_id from app.grp order by group_id limit 1)"),
  undo: () => own.query("update app.grp set capacity_max = capacity_max - 1 where group_id = (select group_id from app.grp order by group_id limit 1)"),
  invalid: ["member_dana", "member_marcus"], reason: "group_changed",
});
await invalidationCase("a new group invalidates ALL current runs (group_added)", {
  doIt: () => own.query("insert into app.grp (group_id, name, description, status, meeting_slot, is_online) values ('00000000-0000-4000-8000-0000000000aa', 'Zz Test Group', 'test', 'closed', 'sun_pm', true)"),
  undo: () => own.query("delete from app.grp where group_id = '00000000-0000-4000-8000-0000000000aa'"),
  invalid: ["member_dana", "member_marcus"], reason: "group_added",
});
await invalidationCase("tag added to a shortlisted group (group_tags_changed)", {
  setup: onlyDana,
  doIt: ({ g }) => own.query("insert into app.group_tag (group_id, tag) values ($1, 'zz_test_tag')", [g]),
  undo: ({ g }) => own.query("delete from app.group_tag where group_id = $1 and tag = 'zz_test_tag'", [g]),
  stay: ["member_marcus"], reason: "group_tags_changed",
});
await invalidationCase("matching-relevant person_features change invalidates that person's run (person_features_changed)", {
  doIt: () => own.query("update app.person_features set busy_slots = array_append(busy_slots, 'zz_slot') where person_id = $1", [DANA]),
  undo: () => own.query("update app.person_features set busy_slots = array_remove(busy_slots, 'zz_slot') where person_id = $1", [DANA]),
  stay: ["member_marcus"], reason: "person_features_changed",
});
await invalidationCase("household location change invalidates the residents' run (location_changed)", {
  doIt: () => own.query("update app.household set lat_approx = lat_approx + 0.001 where household_id = (select household_id from app.person where person_id = $1)", [DANA]),
  undo: () => own.query("update app.household set lat_approx = lat_approx - 0.001 where household_id = (select household_id from app.person where person_id = $1)", [DANA]),
  stay: ["member_marcus"], reason: "location_changed",
});
await invalidationCase("group leader change invalidates ALL current runs (group_leader_changed)", {
  doIt: () => own.query("update app.group_leader set start_on = coalesce(start_on, date '2020-01-01') + 1 where (group_id, person_id) = (select group_id, person_id from app.group_leader order by group_id limit 1)"),
  undo: () => own.query("update app.group_leader set start_on = start_on - 1 where (group_id, person_id) = (select group_id, person_id from app.group_leader order by group_id limit 1)"),
  invalid: ["member_dana", "member_marcus"], reason: "group_leader_changed",
});
await invalidationCase("the member joining a group invalidates their own run and makes them ineligible (membership_changed)", {
  setup: onlyDana,
  doIt: ({ g }) => own.query("insert into app.group_membership (group_id, person_id, status, joined_at) values ($1, $2, 'active', now())", [g, DANA]),
  undo: ({ g }) => own.query("delete from app.group_membership where group_id = $1 and person_id = $2", [g, DANA]),
  stay: ["member_marcus"], reason: "membership_changed",
});

await test("LEADER ACCEPT: a leader (gathered_app, normal RLS) admitting a member invalidates other members' runs", async () => {
  await resetRuns();
  await stubRun("member_dana"); await stubRun("member_marcus");
  // find a persona leader whose group is on a persona member's shortlist
  let pick;
  for (const lk of ["leader_tom", "leader_grace", "leader_chris"]) {
    const gid = (await q("select group_id from app.group_leader where person_id = $1", [P[lk].person_id]))[0]?.group_id;
    for (const mk of ["member_dana", "member_marcus"]) {
      if ((await shortlistGroups(mk)).includes(gid)) { pick = { lk, gid, mk, other: mk === "member_dana" ? "member_marcus" : "member_dana" }; break; }
    }
    if (pick) break;
  }
  assert(pick, "fixture: no persona leader's group is on Dana's or Marcus's shortlist");
  const newcomer = P.member_priya.person_id; // opted in, not in a group, neither Dana nor Marcus
  try {
    await as(pick.lk, (c) => c.query("insert into app.group_membership (group_id, person_id, status, joined_at) values ($1, $2, 'active', now())", [pick.gid, newcomer]));
    const runs = await allRuns(pick.mk);
    assert(!runs[0].is_current && runs[0].invalidation_reason === "membership_changed", "the other member's run should be invalidated by the leader's accept");
    eq(runs[0].invalidation_detail.group_id, pick.gid, "detail names the group");
    // and the leader still has NO direct access to runs or candidates
    await throws(() => as(pick.lk, (c) => c.query("update app.recommendation_run set is_current = true")), DENIED);
    await throws(() => as(pick.lk, (c) => c.query("select * from app.recommendation_run_candidate")), DENIED);
    eq(await as(pick.lk, async (c) => (await c.query("select 1 from app.recommendation")).rows), [], "leader sees no recommendation rows of others");
  } finally {
    await own.query("delete from app.group_membership where group_id = $1 and person_id = $2", [pick.gid, newcomer]);
  }
});

console.log("\n7. Prompt-version invalidation (lazy, no LLM)");
await test("a run made under rank-v1 is invalidated (prompt_version_changed) at lookup under rank-v2, with zero LLM calls", async () => {
  await resetRuns();
  await stubRun("member_dana", { promptVersion: "rank-v1" });
  const before = await llmAuditRows();
  const st = await as("member_dana", async (c) => (await c.query("select * from app.current_recommendation_run($1)", ["rank-v2"])).rows[0]);
  eq(st.out_state, "none");
  const runs = await allRuns("member_dana");
  eq(runs.length, 1, "not regenerated eagerly");
  assert(!runs[0].is_current && runs[0].invalidation_reason === "prompt_version_changed", "reason");
  eq([runs[0].invalidation_detail.from, runs[0].invalidation_detail.to], ["rank-v1", "rank-v2"]);
  eq(await llmAuditRows(), before, "no LLM call");
});
await test("an empty run has no ranking prompt, so a prompt change does not invalidate it", async () => {
  await resetRuns();
  await stubRun("member_priya");
  const st = await as("member_priya", async (c) => (await c.query("select * from app.current_recommendation_run($1)", ["rank-v9"])).rows[0]);
  eq(st.out_state, "current");
});

// ---------------------------------------------------------------- 8. orchestrator with an injected model

console.log("\n8. Lifecycle through the application code (stubbed model, zero external calls)");
function stubModel(kind = "valid") {
  const s = { calls: 0 };
  s.fn = async (payload, attempt) => {
    s.calls++;
    if (kind === "error") throw new Error("simulated network failure");
    const ids = payload.shortlist.map((g) => g.group_id);
    const count = { one: 1, two: 2, zero: 0, four: 4 }[kind] ?? 3; // how many groups this stub "positively supports"
    const good = JSON.stringify({ ranked: ids.slice(0, count).map((g, i) => ({ group_id: g, rank: i + 1 })), internal_rationale: "stub rationale", confidence: "high" });
    const raw = kind === "invalid" || (kind === "invalid-then-valid" && attempt === 1) ? "not json at all" : good;
    return { raw, usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, latencyMs: 5, model: "stub-model" };
  };
  return s;
}
await resetRuns();
let danaFirstRun;
const stub = stubModel();
await test("first eligible request generates a run: Haiku-path ranking, shortlist retained, 3 groups, 1 audit row", async () => {
  const r = await getRecommendations("member_dana", { callModel: stub.fn });
  assert(r.status === "ok" && r.source === "generated" && r.groups.length === 3, "generated 3 groups");
  eq(r.groups.map((g) => g.rank), [1, 2, 3]);
  danaFirstRun = r.runId;
  const run = (await q("select * from app.recommendation_run where run_id = $1", [r.runId]))[0];
  assert(run.is_current && run.outcome === "llm" && run.prompt_version === PROMPT_VERSION && run.internal_rationale === "stub rationale", "run provenance");
  assert((await q("select count(*)::int c from app.recommendation_run_candidate where run_id = $1", [r.runId]))[0].c >= 3, "shortlist retained");
  eq(stub.calls, 1); eq(await llmAuditRows(), 1);
});
await test("audit row per attempt has purpose/model/prompt version/tokens/latency/attempt/outcome and no prompt or about_me", async () => {
  const d = (await q("select detail from app.audit_log where action = 'llm_rank_attempt' and id > $1", [startAuditId]))[0].detail;
  eq([d.purpose, d.model, d.prompt_version, d.attempt, d.outcome, d.total_tokens, d.latency_ms], ["recommendation_rank", "stub-model", PROMPT_VERSION, 1, "ok", 120, 5]);
  const text = JSON.stringify(d);
  const about = (await q("select about_me from app.member_profile where person_id = $1", [DANA]))[0].about_me;
  assert(!text.includes(about.slice(0, 25)) && !/system|shortlist/i.test(text), "audit detail must not contain the prompt or about_me");
});
await test("second visit and refresh reuse the run with ZERO ranking calls and no new audit rows", async () => {
  const r2 = await getRecommendations("member_dana", { callModel: stub.fn });
  const r3 = await getRecommendations("member_dana", { callModel: stub.fn });
  const peek = await peekRecommendations("member_dana");
  assert(r2.source === "reused" && r3.source === "reused" && r2.runId === danaFirstRun && r3.runId === danaFirstRun && peek.runId === danaFirstRun, "same run reused");
  eq(r2.llmAttempts + r3.llmAttempts, 0); eq(stub.calls, 1, "model not called again"); eq(await llmAuditRows(), 1, "no new audit rows");
});
await test("material change invalidates the run (no LLM call); the next request creates a replacement", async () => {
  try {
    await own.query("update app.member_profile set interests = array_append(coalesce(interests, '{}'), 'zz_test') where person_id = $1", [DANA]);
    eq((await currentRuns("member_dana")).length, 0, "invalidated, nothing regenerated");
    eq(stub.calls, 1, "invalidation made no LLM call");
    const peek = await peekRecommendations("member_dana");
    eq(peek.status, "none", "a page view sees no current run and does not generate");
    eq(stub.calls, 1, "viewing made no LLM call");
    const r = await getRecommendations("member_dana", { callModel: stub.fn });
    assert(r.source === "generated" && r.runId !== danaFirstRun, "replacement run");
    eq(stub.calls, 2); eq((await allRuns("member_dana")).length, 2, "old run kept for audit");
    const old = (await allRuns("member_dana")).find((x) => x.run_id === danaFirstRun);
    assert(!old.is_current && old.invalidation_reason === "profile_changed", "old run invalid with reason");
  } finally {
    await own.query("update app.member_profile set interests = array_remove(interests, 'zz_test') where person_id = $1", [DANA]);
  }
});
await test("empty run is created once and reused (Priya: zero model calls)", async () => {
  const s = stubModel();
  const a = await getRecommendations("member_priya", { callModel: s.fn });
  const b = await getRecommendations("member_priya", { callModel: s.fn });
  assert(a.status === "ok" && a.groups.length === 0 && a.source === "generated" && b.source === "reused" && a.runId === b.runId, "empty run reused");
  eq(s.calls, 0, "no model call for an empty shortlist");
});
await test("member in an active group (Ruth) is ineligible and gets no run; Jordan (no profile) neither", async () => {
  const s = stubModel();
  eq((await getRecommendations("member_ruth", { callModel: s.fn })).reason, "in_group");
  eq((await getRecommendations("member_jordan", { callModel: s.fn })).reason, "no_profile");
  eq(s.calls, 0);
  eq((await allRuns("member_ruth")).length + (await allRuns("member_jordan")).length, 0, "no runs created");
});
await test("retry: invalid first answer then valid -> outcome llm_after_retry, 2 audit rows", async () => {
  await resetRuns(); const before = await llmAuditRows();
  const s = stubModel("invalid-then-valid");
  const r = await getRecommendations("member_marcus", { callModel: s.fn });
  eq(s.calls, 2); eq(r.llmAttempts, 2);
  eq((await q("select outcome from app.recommendation_run where run_id = $1", [r.runId]))[0].outcome, "llm_after_retry");
  eq((await llmAuditRows()) - before, 2);
  eq((await q("select detail->>'outcome' o from app.audit_log where action = 'llm_rank_attempt' order by id desc limit 2")).map((x) => x.o).reverse(), ["invalid_output", "ok"]);
});
await test("fallback: two invalid answers -> deterministic score order, failed attempts stay in audit_log, run records score_fallback", async () => {
  await resetRuns(); const before = await llmAuditRows();
  const s = stubModel("invalid");
  const r = await getRecommendations("member_marcus", { callModel: s.fn });
  eq(s.calls, 2);
  const run = (await q("select * from app.recommendation_run where run_id = $1", [r.runId]))[0];
  eq(run.outcome, "score_fallback"); eq(run.confidence, "low");
  const sl = (await q("select group_id from app.recommendation_run_candidate where run_id = $1 order by shortlist_position", [r.runId])).map((x) => x.group_id);
  eq(r.groups.map((g) => g.group_id), sl.slice(0, 3), "score order");
  eq((await llmAuditRows()) - before, 2, "both failed attempts audited, none duplicated by the run");
});
await test("1 to 3 groups: a model that supports only one or two is persisted as returned, not padded; reused with zero calls", async () => {
  for (const [kind, k] of [["one", 1], ["two", 2], ["valid", 3]]) {
    await resetRuns();
    const s = stubModel(kind);
    const r = await getRecommendations("member_dana", { callModel: s.fn });
    assert(r.status === "ok" && r.source === "generated" && r.groups.length === k, `${kind}: ${r.groups.length} groups`);
    eq(r.groups.map((g) => g.rank), Array.from({ length: k }, (_, i) => i + 1), `${kind}: ranks`);
    const run = (await q("select * from app.recommendation_run where run_id = $1", [r.runId]))[0];
    assert(run.is_current && run.outcome === "llm", `${kind}: outcome ${run.outcome}`);
    eq((await q("select count(*)::int c from app.recommendation where run_id = $1", [r.runId]))[0].c, k, `${kind}: stored rows`);
    assert((await q("select count(*)::int c from app.recommendation_run_candidate where run_id = $1", [r.runId]))[0].c >= 3, `${kind}: the full shortlist is still kept`);
    eq(s.calls, 1);
    const again = await getRecommendations("member_dana", { callModel: s.fn });
    assert(again.source === "reused" && again.llmAttempts === 0 && again.groups.length === k && s.calls === 1, `${kind}: reused with zero calls`);
    const peek = await peekRecommendations("member_dana");
    eq(peek.groups.length, k, `${kind}: the member read path returns the same number`);
  }
});
await test("an answer with zero groups or more than three is invalid (retry, then the score fallback of three)", async () => {
  for (const kind of ["zero", "four"]) {
    await resetRuns(); const before = await llmAuditRows();
    const s = stubModel(kind);
    const r = await getRecommendations("member_dana", { callModel: s.fn });
    eq(s.calls, 2, `${kind}: retried once`);
    const run = (await q("select * from app.recommendation_run where run_id = $1", [r.runId]))[0];
    eq([run.outcome, run.confidence], ["score_fallback", "low"], `${kind}: fell back`);
    const sl = (await q("select group_id from app.recommendation_run_candidate where run_id = $1 order by shortlist_position", [r.runId])).map((x) => x.group_id);
    eq(r.groups.map((g) => g.group_id), sl.slice(0, 3), `${kind}: fallback is the top three by score`);
    eq((await llmAuditRows()) - before, 2, `${kind}: both attempts audited`);
    eq((await q("select detail->>'outcome' o from app.audit_log where action = 'llm_rank_attempt' order by id desc limit 2")).map((x) => x.o), ["invalid_output", "invalid_output"]);
  }
});
await test("persist accepts 1, 2 and 3 llm-ranked groups and rejects 0 and 4; a score fallback must still be the full top three", async () => {
  await resetRuns();
  const ids = await as("member_dana", async (c) => (await c.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((r) => r.group_id));
  const call = (ranked, outcome = "llm") => as("member_dana", (c) =>
    c.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], $3, 'low', 'x', 'm', $4, '{}') as run_id", [ids, ranked, outcome, PROMPT_VERSION]));
  for (const k of [1, 2, 3]) {
    const runId = (await call(ids.slice(0, k))).rows[0].run_id;
    eq((await q("select group_id from app.recommendation where run_id = $1 order by rank", [runId])).map((x) => x.group_id), ids.slice(0, k), `${k} groups stored in order`);
  }
  await throws(() => call([]), /expected 1 to 3/); await throws(() => call(ids.slice(0, 4)), /expected 1 to 3/);
  await throws(() => call(ids.slice(0, 1), "score_fallback"), /score order/);
  eq((await currentRuns("member_dana")).length, 1, "rejected writes leave exactly the last good run current");
});
await test("model unreachable on both attempts: nothing persisted (next request retries), attempts audited", async () => {
  await resetRuns(); const before = await llmAuditRows();
  const s = stubModel("error");
  const e = await throws(() => getRecommendations("member_marcus", { callModel: s.fn }));
  eq(e.name, "RankingUnavailableError", "error type");
  eq((await allRuns("member_marcus")).length, 0, "no run persisted"); eq((await llmAuditRows()) - before, 2);
});
await test("prompt-version change: an old rank-v1 run regenerates under rank-v2 on the next request", async () => {
  await resetRuns();
  await stubRun("member_dana", { promptVersion: "rank-v1" });
  const s = stubModel();
  const before = await llmAuditRows();
  const r = await getRecommendations("member_dana", { callModel: s.fn });
  assert(r.source === "generated", "regenerated");
  eq(s.calls, 1, "exactly one call, made only because the member asked");
  const runs = await allRuns("member_dana");
  eq(runs.length, 2); eq(runs[0].invalidation_reason, "prompt_version_changed"); eq(runs[1].prompt_version, PROMPT_VERSION);
  eq((await llmAuditRows()) - before, 1);
});

console.log("\n9. Concurrency");
await test("concurrent persists leave exactly one current run (and concurrent requests make at most 2 model calls)", async () => {
  await resetRuns();
  const s = stubModel();
  const results = await Promise.all([1, 2, 3, 4].map(() => getRecommendations("member_dana", { callModel: s.fn })));
  assert(results.every((r) => r.status === "ok" && r.groups.length === 3), "all requests succeeded");
  eq((await currentRuns("member_dana")).length, 1, "one current run");
  const runs = await allRuns("member_dana");
  eq(runs.filter((r) => r.is_current).length, 1);
  assert(runs.filter((r) => !r.is_current).every((r) => r.invalidation_reason === "superseded"), "others superseded");
  assert(s.calls <= 4, "bounded model calls");
});
await test("raw concurrent persist calls: serialised by the per-member lock", async () => {
  await resetRuns();
  const runs = await Promise.all([1, 2, 3, 4, 5].map(() => stubRun("member_marcus")));
  eq(new Set(runs.map((r) => r.runId)).size, 5);
  const all = await allRuns("member_marcus");
  eq(all.length, 5); eq(all.filter((r) => r.is_current).length, 1);
});

// ---------------------------------------------------------------- done

await cleanup();
await own.end(); await appPool.end();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
