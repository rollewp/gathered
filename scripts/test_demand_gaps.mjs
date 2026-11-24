// Gathered: demand-gap serving table, Manager read path and the scoped refresh role (migration 0009).
// No Databricks and no model calls. Fixture rows are written with the owner connection and the table
// is restored to whatever the real refresh put there when the tests finish.
//
//   npm run test:demand
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_demand_gaps.mjs
//
// The refresh-role section needs DATABASE_REFRESH_URL (see databricks/setup_refresh_secrets.mjs). If it
// is not set those tests are reported as SKIPPED, loudly.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { getDemandGaps } from "../lib/analytics/demand-gaps.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 4 });
const refresh = process.env.DATABASE_REFRESH_URL ? new pg.Client({ connectionString: process.env.DATABASE_REFRESH_URL, ssl }) : null;
if (refresh) await refresh.connect();

let networkCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { networkCalls++; return realFetch(...a); };

let passed = 0, failed = 0, skipped = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  PASS  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
async function testRefresh(name, fn) {
  if (!refresh) { skipped++; console.log(`  SKIP  ${name}  (DATABASE_REFRESH_URL not set)`); return; }
  await test(name, fn);
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
const denied = async (fn) => { try { await fn(); return false; } catch (e) { return /permission denied|row-level security/i.test(e.message); } };
const DANA = "member_dana";

// ---- snapshot, so the tests leave the database as they found it
const snapshot = await q("select * from app.demand_gap");
const danaBefore = (await q("select * from app.person_features where person_id = $1", [P[DANA].person_id]))[0];
// runs that already exist (e.g. a demo recommendation run) are never touched: only runs this file creates are removed
const preRuns = (await q("select run_id from app.recommendation_run")).map((r) => r.run_id);
const startAudit = Number((await q("select coalesce(max(id), 0) m from app.audit_log"))[0].m);
const COLS = ["life_stage", "available_slot", "opted_in_ungrouped_count", "serving_group_count", "available_seat_count", "people_per_open_seat",
  "people_without_group_in_catalog", "people_without_reachable_group", "gap_classification", "gap_rank", "as_of_date", "computed_at"];
const insertSql = `insert into app.demand_gap (${COLS.join(",")}) values (${COLS.map((_, i) => `$${i + 1}`).join(",")})`;
async function put(rows) {
  await own.query("delete from app.demand_gap");
  for (const r of rows) await own.query(insertSql, COLS.map((c) => r[c]));
}
const fixture = (stage, slot, n, groups, seats, reach, cls, rank) => ({
  life_stage: stage, available_slot: slot, opted_in_ungrouped_count: n, serving_group_count: groups, available_seat_count: seats,
  people_per_open_seat: seats ? Math.round((n / seats) * 100) / 100 : null, people_without_group_in_catalog: groups ? 0 : n,
  people_without_reachable_group: reach, gap_classification: cls, gap_rank: rank, as_of_date: "2026-11-01", computed_at: new Date().toISOString(),
});
const FIX = [
  fixture("retired", "wed_am", 38, 1, 8, 34, "High demand", 1),
  fixture("empty_nest", "thu_am", 34, 0, 0, 34, "No current group", 2),
  fixture("young_kids", "tue_am", 27, 2, 10, 22, "Limited reach", 3),
  fixture("retired", "thu_am", 31, 0, 0, 31, "No current group", 4),
  fixture("empty_nest", "wed_am", 31, 0, 0, 31, "No current group", 5),
  fixture("teens", "tue_am", 12, 1, 6, 9, "Limited reach", 6),
  fixture("single", "wed_eve", 122, 8, 44, 0, "Served", null),
];

try {
  console.log("Serving table");
  await put(FIX);
  await test("the table holds aggregates only: no person id, name or free text columns", async () => {
    const cols = (await q("select column_name from information_schema.columns where table_schema = 'app' and table_name = 'demand_gap' order by ordinal_position")).map((r) => r.column_name);
    eq(cols, COLS);
  });
  await test("the Manager reads the cohorts; members and leaders (and no role) read nothing", async () => {
    eq((await as("manager", (db) => db.query("select * from app.demand_gap"))).rows.length, FIX.length);
    for (const k of [DANA, "member_marcus", "leader_tom", "leader_grace"]) eq((await as(k, (db) => db.query("select * from app.demand_gap"))).rows.length, 0, `${k} can read`);
    eq((await asPerson("", "", (db) => db.query("select * from app.demand_gap"))).rows.length, 0, "no role can read");
  });
  await test("gathered_app (every persona, the Manager included) cannot insert, update or delete", async () => {
    for (const k of ["manager", DANA, "leader_tom"]) {
      assert(await denied(() => as(k, (db) => db.query("insert into app.demand_gap (life_stage, available_slot, opted_in_ungrouped_count, serving_group_count, available_seat_count, people_without_group_in_catalog, people_without_reachable_group, gap_classification, computed_at) values ('single','sun_9',1,1,1,0,0,'Served',now())"))), `${k} insert`);
      assert(await denied(() => as(k, (db) => db.query("update app.demand_gap set gap_rank = 99"))), `${k} update`);
      assert(await denied(() => as(k, (db) => db.query("delete from app.demand_gap"))), `${k} delete`);
    }
    eq((await q("select count(*)::int c from app.demand_gap"))[0].c, FIX.length);
  });
  await test("the Manager read path returns the top 5 gaps in rank order, with totals, and never the Served cohorts", async () => {
    const d = await getDemandGaps("manager");
    eq(d.gaps.map((g) => `${g.life_stage}/${g.available_slot}`), ["retired/wed_am", "empty_nest/thu_am", "young_kids/tue_am", "retired/thu_am", "empty_nest/wed_am"]);
    eq([d.totalGapCohorts, d.cohortsAnalyzed], [6, 7]);
    assert(d.gaps.every((g) => g.gap_classification !== "Served"));
    eq(Object.keys(d.gaps[0]).sort(), ["available_seat_count", "available_slot", "gap_classification", "gap_rank", "life_stage", "opted_in_ungrouped_count", "people_per_open_seat", "people_without_reachable_group", "serving_group_count"]);
  });
  await test("for a member or leader the read path returns an empty summary (row-level security), not the data", async () => {
    for (const k of [DANA, "leader_tom"]) { const d = await getDemandGaps(k); eq([d.gaps.length, d.cohortsAnalyzed], [0, 0], k); }
  });
  await test("an empty table is a valid state", async () => {
    await put([]);
    const d = await getDemandGaps("manager");
    eq([d.gaps, d.cohortsAnalyzed, d.totalGapCohorts], [[], 0, 0]);
    await put(FIX);
  });
  await test("reading the analysis makes no network call", () => eq(networkCalls, 0));

  console.log("\nScoped refresh role (gathered_refresh)");
  await testRefresh("it connects as gathered_refresh with no superuser, BYPASSRLS or role-creation rights", async () => {
    const r = (await refresh.query("select current_user u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb from pg_roles r where r.rolname = current_user")).rows[0];
    eq([r.u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb], ["gathered_refresh", false, false, false, false]);
  });
  await testRefresh("it can read and write person_features and demand_gap and nothing else", async () => {
    for (const t of ["person_features", "demand_gap"]) await refresh.query(`select count(*) from app.${t}`);
    for (const t of ["person", "household", "member_profile", "group_membership", "grp", "join_request", "recommendation_run", "recommendation", "escalation", "audit_log", "portal_user"]) {
      assert(await denied(() => refresh.query(`select 1 from app.${t} limit 1`)), `select ${t}`);
    }
    assert(await denied(() => refresh.query("insert into app.audit_log (action) values ('x')")), "audit insert");
    assert(await denied(() => refresh.query("delete from app.person_features")), "person_features delete");
    assert(await denied(() => refresh.query("create table app.x (a int)")), "create table");
  });

  const featureRows = async () => (await refresh.query("select * from app.person_features order by person_id")).rows;
  const FC = ["person_id", "observed_weeks_12w", "attendance_rate_12w", "signal_sources", "signal_confidence", "online_share_12w", "consistency_score", "busy_slots", "serving_areas", "kids_age_bands", "tenure_months", "last_attended_on"];
  const upsert = async (rows) => {
    const nonKey = FC.filter((c) => c !== "person_id");
    const changed = nonKey.map((c) => `app.person_features.${c} is distinct from excluded.${c}`).join(" or ");
    const types = { signal_sources: "text[]", busy_slots: "text[]", serving_areas: "text[]", kids_age_bands: "text[]", person_id: "uuid" };
    let ins = 0, upd = 0, same = 0;
    await refresh.query("begin");
    for (const r of rows) {
      const res = await refresh.query(`insert into app.person_features (${FC.join(",")}, computed_at) values (${FC.map((c, i) => `$${i + 1}${types[c] ? "::" + types[c] : ""}`).join(",")}, now())
        on conflict (person_id) do update set ${nonKey.map((c) => `${c} = excluded.${c}`).join(", ")}, computed_at = excluded.computed_at where ${changed} returning (xmax = 0) as inserted`, FC.map((c) => r[c]));
      if (res.rowCount === 0) same++; else if (res.rows[0].inserted) ins++; else upd++;
    }
    await refresh.query("commit");
    return { ins, upd, same };
  };
  const stubRun = (key) => as(key, async (db) => {
    const ids = (await db.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((g) => g.group_id);
    const r = await db.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], 'llm', 'medium', 'test', 'stub-model', $3, '{}'::jsonb) as run_id", [ids, ids.slice(0, Math.min(3, ids.length)), PROMPT_VERSION]);
    return r.rows[0].run_id;
  });

  let danaRun;
  await testRefresh("rewriting the features it just read changes nothing and invalidates no recommendation run (second unchanged refresh)", async () => {
    danaRun = await stubRun(DANA);
    const rows = await featureRows();
    const r1 = await upsert(rows);
    eq([r1.ins, r1.upd], [0, 0], "first rewrite of identical values");
    const r2 = await upsert(rows);
    eq([r2.ins, r2.upd, r2.same], [0, 0, rows.length], "second rewrite");
    assert((await q("select is_current from app.recommendation_run where run_id = $1", [danaRun]))[0].is_current, "the run is still current");
  });
  await testRefresh("an equal rewrite leaves computed_at alone; a material change invalidates the affected person's run", async () => {
    const rows = await featureRows();
    const stamp = rows.find((r) => r.person_id === P[DANA].person_id).computed_at.toISOString();
    await upsert(rows);
    eq((await featureRows()).find((r) => r.person_id === P[DANA].person_id).computed_at.toISOString(), stamp, "computed_at unchanged by an equal rewrite");
    const r = await upsert(rows.map((x) => x.person_id === P[DANA].person_id ? { ...x, busy_slots: [...x.busy_slots, "tue_am"] } : x));
    eq([r.ins, r.upd], [0, 1]);
    const inv = (await q("select is_current, invalidation_reason from app.recommendation_run where run_id = $1", [danaRun]))[0];
    assert(!inv.is_current && inv.invalidation_reason === "person_features_changed", JSON.stringify(inv));
  });
  await testRefresh("the refresh role can replace the demand_gap aggregate (update, then drop cohorts that vanished)", async () => {
    await refresh.query("begin");
    await refresh.query("delete from app.demand_gap where (life_stage, available_slot) not in (('retired','wed_am'))");
    await refresh.query("update app.demand_gap set opted_in_ungrouped_count = 39 where life_stage = 'retired' and available_slot = 'wed_am'");
    await refresh.query("commit");
    eq(await q("select life_stage, opted_in_ungrouped_count from app.demand_gap"), [{ life_stage: "retired", opted_in_ungrouped_count: 39 }]);
  });
} finally {
  // restore: Dana's features exactly as before, the real demand_gap rows, no runs or audit rows left behind
  await own.query("update app.person_features set busy_slots = $2, computed_at = $3 where person_id = $1", [P[DANA].person_id, danaBefore.busy_slots, danaBefore.computed_at]);
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t} where run_id <> all($1::uuid[])`, [preRuns]);
  await own.query("delete from app.audit_log where id > $1", [startAudit]);
  await put(snapshot);
}

await test("the database ends as it began: Dana's features, the demand_gap rows, no runs or audit rows added", async () => {
  const d = (await q("select busy_slots, computed_at from app.person_features where person_id = $1", [P[DANA].person_id]))[0];
  eq([d.busy_slots, d.computed_at.toISOString()], [danaBefore.busy_slots, danaBefore.computed_at.toISOString()]);
  eq((await q("select run_id from app.recommendation_run order by run_id")).map((r) => r.run_id), [...preRuns].sort(), "only the runs that existed before");
  eq((await q("select count(*)::int c from app.audit_log where id > $1", [startAudit]))[0].c, 0);
  eq((await q("select count(*)::int c from app.demand_gap"))[0].c, snapshot.length);
});
if (refresh) await refresh.end();
await own.end();
await appPool.end();
console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} SKIPPED (set DATABASE_REFRESH_URL to run them)` : ""}`);
process.exit(failed ? 1 : 0);
