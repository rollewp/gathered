// Gathered: Journey 1 Browse Groups (public catalog) tests. No external LLM calls: the ranking model
// is replaced by an injected stub, and a fetch spy proves nothing reaches the network.
//
//   npm run test:catalog
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_catalog.mjs
//
// Same two-connection pattern as the other database tests: the app code under test uses
// gathered_app (RLS applies); the owner connection is used ONLY to compute expected values and to
// clean up the recommendation runs / audit rows this test creates.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { getCatalogPage } from "../lib/catalog.ts";
import { parseCatalogParams, catalogQuery, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, PAGE_SIZE_MIN } from "../lib/catalog-params.ts";
import { toGroupView } from "../lib/group-view.ts";
import { getRecommendations, peekRecommendations } from "../lib/recommendations.ts";
import { getGroupCard } from "../lib/member.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
const root = path.join(import.meta.dirname, "..");
const personas = JSON.parse(fs.readFileSync(path.join(root, "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 4 });

// Any network call at all during these tests is a failure: count them.
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
async function throws(fn, pattern, msg) {
  try { await fn(); } catch (e) { if (pattern && !pattern.test(e.message)) throw new Error(`${msg ?? "wrong error"}: ${e.message}`); return e; }
  throw new Error(`${msg ?? "expected an error"} but none was thrown`);
}
async function as(key, fn) {
  const c = await appPool.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [P[key].role, P[key].person_id]);
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
}
const q = async (sql, params) => (await own.query(sql, params)).rows;
const count = async (sql, params) => Number((await q(sql, params))[0].n);
const P0 = (over = {}) => parseCatalogParams(over);
const DENIED = /permission denied|manager only|row-level security|does not exist/i;
const DANA = "member_dana";
const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);

async function cleanup() {
  await own.query("update app.join_request set rec_id = null where rec_id is not null"); // kept (withdrawn/declined) requests reference recommendations
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
function stubModel() {
  const calls = { n: 0 };
  const fn = async (payload) => {
    calls.n++;
    const ids = [...JSON.stringify(payload).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]);
    const uniq = [...new Set(ids)];
    return { raw: JSON.stringify({ ranked: uniq.slice(0, 3).map((g, i) => ({ group_id: g, rank: i + 1 })), internal_rationale: "stub rationale", confidence: "high" }), usage: { total_tokens: 1 }, latencyMs: 1, model: "stub-model" };
  };
  return { fn, calls };
}
await cleanup();

console.log("URL parameters (offline)");
await test("defaults: page 1, page size 12, no filters, nothing ignored", () => {
  const p = P0({});
  eq([p.page, p.pageSize, p.q, p.day, p.time, p.format, p.stage, p.childcare, p.open, p.ignored], [1, PAGE_SIZE_DEFAULT, "", null, null, null, null, false, false, false]);
});
await test("page size is clamped to 6..24; page is at least 1; garbage is ignored and flagged", () => {
  eq(P0({ size: "1" }).pageSize, PAGE_SIZE_MIN);
  eq(P0({ size: "500" }).pageSize, PAGE_SIZE_MAX);
  eq(P0({ size: "abc" }).pageSize, PAGE_SIZE_DEFAULT);
  eq(P0({ page: "0" }).page, 1);
  eq(P0({ page: "-3" }).page, 1);
  assert(P0({ page: "-3" }).ignored && P0({ size: "500" }).ignored && P0({ day: "funday" }).ignored && P0({ childcare: "yes" }).ignored);
});
await test("unknown filter values are dropped, not passed to the database; the search term is bounded", () => {
  const p = P0({ day: "tue; drop table app.grp", format: "teleport", stage: "x", time: "noon", q: "x".repeat(500) });
  eq([p.day, p.format, p.stage, p.time], [null, null, null, null]);
  eq(p.q.length, 80);
});
await test("catalogQuery round-trips filters and omits defaults", () => {
  eq(catalogQuery(P0({})), "");
  const p = P0({ q: "bible", day: "tue", childcare: "1", page: "3" });
  const back = P0(Object.fromEntries(new URLSearchParams(catalogQuery(p))));
  eq([back.q, back.day, back.childcare, back.page], ["bible", "tue", true, 3]);
});

console.log("\nCatalog query (database)");
const total = await count("select count(*) n from app.grp");
await test("the total comes from the database, not a constant", async () => {
  const c = await getCatalogPage(DANA, P0({}));
  eq(c.total, total);
  eq(c.matching, total);
  assert(total > 100, `the V2 world has about 140 groups (found ${total})`);
});
await test("the default page returns the configured page size, in stable name order", async () => {
  const c = await getCatalogPage(DANA, P0({}));
  eq(c.groups.length, PAGE_SIZE_DEFAULT);
  eq(c.pageCount, Math.ceil(total / PAGE_SIZE_DEFAULT));
  const names = c.groups.map((g) => g.name.toLowerCase());
  eq(names, [...names].sort(), "alphabetical");
  eq((await getCatalogPage(DANA, P0({}))).groups.map((g) => g.group_id), c.groups.map((g) => g.group_id), "same order every time");
  eq((await getCatalogPage(DANA, P0({ size: "6" }))).groups.length, 6);
  eq((await getCatalogPage(DANA, P0({ size: "999" }))).groups.length, PAGE_SIZE_MAX);
});
await test("pages are distinct, ordered across the boundary, and together cover every group exactly once", async () => {
  const first = await getCatalogPage(DANA, P0({}));
  const seen = [];
  for (let p = 1; p <= first.pageCount; p++) seen.push(...(await getCatalogPage(DANA, P0({ page: String(p) }))).groups);
  eq(seen.length, total);
  eq(new Set(seen.map((g) => g.group_id)).size, total, "no duplicates");
  const names = seen.map((g) => g.name.toLowerCase());
  eq(names, [...names].sort(), "global order");
  eq(new Set((await q("select group_id from app.grp")).map((r) => r.group_id)), new Set(seen.map((g) => g.group_id)), "same set as the table");
});
await test("a page past the end shows the last page", async () => {
  const c = await getCatalogPage(DANA, P0({ page: "9999" }));
  eq(c.page, c.pageCount);
  assert(c.groups.length > 0);
});
await test("search matches the name or description, case-insensitively, and treats wildcards literally", async () => {
  const c = await getCatalogPage(DANA, P0({ q: "BIBLE", size: "24" }));
  const expected = await count("select count(*) n from app.grp where strpos(lower(name), 'bible') > 0 or strpos(lower(description), 'bible') > 0");
  eq(c.matching, expected);
  assert(c.matching > 0 && c.groups.every((g) => /bible/i.test(g.name + " " + g.description)));
  eq((await getCatalogPage(DANA, P0({ q: "%" }))).matching, await count("select count(*) n from app.grp where strpos(description, '%') > 0 or strpos(name, '%') > 0"), "percent is a literal");
  eq((await getCatalogPage(DANA, P0({ q: "'; drop table app.grp; --" }))).matching, 0, "SQL in the search box is just text");
  eq(await count("select count(*) n from app.grp"), total, "table intact");
});
await test("day and time-of-day filters match the meeting slot", async () => {
  const tue = await getCatalogPage(DANA, P0({ day: "tue" }));
  eq(tue.matching, await count("select count(*) n from app.grp where meeting_slot like 'tue\\_%'"));
  assert(tue.matching > 0 && tue.groups.every((g) => g.meeting_slot.startsWith("tue_")));
  const eve = await getCatalogPage(DANA, P0({ time: "eve" }));
  eq(eve.matching, await count("select count(*) n from app.grp where meeting_slot like '%\\_eve'"));
  const both = await getCatalogPage(DANA, P0({ day: "thu", time: "eve" }));
  eq(both.matching, await count("select count(*) n from app.grp where meeting_slot = 'thu_eve'"));
});
await test("format filter uses is_online: in person and online partition the catalog", async () => {
  const online = await getCatalogPage(DANA, P0({ format: "online", size: "24" }));
  const inPerson = await getCatalogPage(DANA, P0({ format: "in_person" }));
  eq(online.matching, await count("select count(*) n from app.grp where is_online"));
  assert(online.matching > 0 && online.groups.every((g) => g.is_online));
  eq(online.matching + inPerson.matching, total);
});
await test("childcare, life stage and open-to-new-members filters match the table", async () => {
  const cc = await getCatalogPage(DANA, P0({ childcare: "1", size: "24" }));
  eq(cc.matching, await count("select count(*) n from app.grp where childcare"));
  assert(cc.matching > 0 && cc.groups.every((g) => g.childcare));
  eq((await getCatalogPage(DANA, P0({ stage: "single" }))).matching, await count("select count(*) n from app.grp where life_stage_focus = 'single'"));
  const open = await getCatalogPage(DANA, P0({ open: "1" }));
  eq(open.matching, await count(`select count(*) n from app.grp g where g.status in ('open','forming')
    and g.capacity_max - (select count(*) from app.group_membership m where m.group_id = g.group_id and m.status = 'active') > 0`));
  assert(open.matching < total, "full/closed groups are excluded");
});
await test("filters combine (AND) and the count shrinks monotonically", async () => {
  const a = await getCatalogPage(DANA, P0({ day: "thu" }));
  const b = await getCatalogPage(DANA, P0({ day: "thu", open: "1" }));
  const c = await getCatalogPage(DANA, P0({ day: "thu", open: "1", q: "women" }));
  assert(a.matching >= b.matching && b.matching >= c.matching && c.matching > 0, `${a.matching} ${b.matching} ${c.matching}`);
});
await test("no filter matches: zero groups, one page, total still reported", async () => {
  const c = await getCatalogPage(DANA, P0({ q: "zzzz-no-such-group" }));
  eq([c.matching, c.groups.length, c.pageCount, c.total], [0, 0, 1, total]);
});

console.log("\nPublic card contract and security");
const PUBLIC = ["area_label", "childcare", "description", "group_id", "is_online", "meeting_slot", "name", "open_seats", "tags"];
await test("catalog rows carry exactly the public card fields: no address, coordinates, leader, status internals or ranking data", async () => {
  const c = await getCatalogPage(DANA, P0({}));
  for (const g of c.groups) eq(Object.keys(g).sort(), PUBLIC);
  assert(!JSON.stringify(c).match(/lat|lng|address|street|score|rationale|shortlist|prompt|model|attendance/i), "payload text");
});
await test("a catalog card and a recommended card are the same public card (identical view fields)", async () => {
  const stub = stubModel();
  const r = await getRecommendations(DANA, { callModel: stub.fn });
  assert(r.status === "ok" && r.groups.length >= 1 && r.groups.length <= 3, "at most three recommended groups");
  const recView = Object.keys(toGroupView(r.groups[0])).sort();
  const catView = Object.keys(toGroupView((await getCatalogPage(DANA, P0({}))).groups[0])).sort();
  eq(recView, catView);
  // the same group renders identically from both paths
  const g = r.groups[0];
  const fromCatalog = (await getCatalogPage(DANA, P0({ q: g.name, size: "24" }))).groups.find((x) => x.group_id === g.group_id);
  assert(fromCatalog, "recommended group is in the catalog");
  eq(toGroupView(fromCatalog), toGroupView(g), "identical card content");
});
await test("every catalog card and recommended card reaches the same canonical group page (getGroupCard)", async () => {
  const c = await getCatalogPage(DANA, P0({}));
  for (const g of c.groups.slice(0, 3)) assert((await getGroupCard(DANA, g.group_id))?.group_id === g.group_id);
  const rec = await peekRecommendations(DANA);
  for (const g of rec.groups) assert((await getGroupCard(DANA, g.group_id))?.group_id === g.group_id);
});
await test("members and leaders still cannot read scores, breakdowns, shortlist, model, prompt version or rationale", async () => {
  for (const k of ["member_dana", "leader_tom"]) {
    for (const sql of [
      "select score_breakdown from app.recommendation", "select score from app.recommendation_run_candidate",
      "select internal_rationale from app.recommendation_run", "select model, prompt_version from app.recommendation_run",
      "select * from app.manager_recommendation_audit()",
    ]) await throws(() => as(k, (c) => c.query(sql)), DENIED, `${k}: ${sql}`);
  }
});
await test("the catalog function runs as gathered_app and cannot be used to reach coordinates", async () => {
  await throws(() => as(DANA, (c) => c.query("select lat_approx from app.grp")), DENIED);
  const cols = (await as(DANA, (c) => c.query("select * from app.group_card() limit 1"))).fields.map((f) => f.name);
  assert(!cols.some((n) => /lat|lng|address|score/i.test(n)), cols.join());
});

console.log("\nBrowse never calls the model or touches saved recommendations");
await test("browsing, searching, filtering and paging make zero model calls and zero network calls", async () => {
  await cleanup();
  networkCalls = 0;
  const before = { audit: await count("select count(*) n from app.audit_log"), runs: await count("select count(*) n from app.recommendation_run") };
  for (const p of [{}, { page: "2" }, { q: "bible" }, { day: "tue" }, { format: "online" }, { childcare: "1" }, { open: "1", page: "2" }, { q: "none-here" }])
    await getCatalogPage(DANA, P0(p));
  eq(networkCalls, 0, "network calls");
  eq(await count("select count(*) n from app.audit_log"), before.audit, "no audit rows (every model attempt writes one)");
  eq(await count("select count(*) n from app.recommendation_run"), before.runs, "no runs created");
});
await test("the catalog and the member page code do not import the ranking model", () => {
  const src = fs.readFileSync(path.join(root, "lib", "catalog.ts"), "utf8");
  assert(!/ranking\/llm|openrouter|recommendations/i.test(src), "lib/catalog.ts must not reach the model or the orchestrator");
  const page = fs.readFileSync(path.join(root, "app", "member", "(home)", "page.tsx"), "utf8");
  assert(!/getRecommendations|rankShortlist/.test(page), "the member page only peeks; only the server action generates");
});
await test("'Find my best matches' goes through the existing orchestrator: generates once, persists, then reuses with zero calls", async () => {
  const action = fs.readFileSync(path.join(root, "app", "member", "actions.ts"), "utf8");
  assert(/requestMyRecommendations/.test(action) && /getRecommendations\(persona\.key\)/.test(action), "the action calls getRecommendations");
  await cleanup();
  const stub = stubModel();
  const first = await getRecommendations(DANA, { callModel: stub.fn });
  assert(first.status === "ok" && first.source === "generated" && first.groups.length <= 3 && stub.calls.n === 1, "generated with one stubbed call");
  eq(await count("select count(*) n from app.recommendation_run where person_id = $1 and is_current", [P[DANA].person_id]), 1);
  const again = await getRecommendations(DANA, { callModel: stub.fn });
  assert(again.source === "reused" && again.llmAttempts === 0 && stub.calls.n === 1, "reused, no further model call");
  eq(again.groups.map((g) => g.group_id), first.groups.map((g) => g.group_id), "same groups, same order");
});
await test("'Browse all groups' and further catalog browsing leave the saved run untouched", async () => {
  const run = (await q("select run_id, is_current from app.recommendation_run where person_id = $1", [P[DANA].person_id]));
  eq(run.length, 1); assert(run[0].is_current);
  for (const p of [{}, { page: "3" }, { day: "sat" }, { q: "first" }]) await getCatalogPage(DANA, P0(p));
  const after = await q("select run_id, is_current, invalidated_at from app.recommendation_run where person_id = $1", [P[DANA].person_id]);
  eq(after.length, 1, "no new run"); assert(after[0].is_current && after[0].run_id === run[0].run_id && !after[0].invalidated_at, "same run, still current");
  const peek = await peekRecommendations(DANA);
  eq([peek.status, peek.source, peek.llmAttempts], ["ok", "reused", 0]);
});
await test("the whole file made no network calls", () => eq(networkCalls, 0));

await cleanup();
await own.end(); await appPool.end();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
