// Gathered: member profile / preferences page tests (existing confirmed profile: read, edit, confirm).
// No external LLM calls: the ranking model is an injected stub and a fetch spy proves nothing
// reaches the network. The Journey 2 AI extraction step is not built and not tested here.
//
//   npm run test:profile
//     = node --import tsx --conditions=react-server --env-file=.env.local scripts/test_profile.mjs
//
// Two-connection pattern: the application code under test uses gathered_app (RLS applies); the
// owner connection is used ONLY to read expected values, to snapshot and restore the profiles the
// tests change, and to remove the runs and audit rows they create.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { getMyPreferences, saveMyProfile } from "../lib/member.ts";
import { getRecommendations, peekRecommendations } from "../lib/recommendations.ts";
import { parseProfile, parseProfileForm, changedFields, normalizeAboutMe, ABOUT_ME_MAX, SLOTS, INTERESTS } from "../lib/profile-schema.ts";

const ssl = { rejectUnauthorized: false };
for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL"]) if (!process.env[k]) { console.error(`${k} is not set`); process.exit(1); }
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 4 });

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
const EDITABLE = ["life_stage", "available_slots", "group_pref", "interests", "about_me"];
const DANA = "member_dana", PRIYA = "member_priya", TOM = "leader_tom";
const PEOPLE = [DANA, PRIYA, TOM].map((k) => P[k].person_id);
const startAuditId = Number((await q("select coalesce(max(id), 0) as m from app.audit_log"))[0].m);
const stored = (key) => q("select * from app.member_profile where person_id = $1", [P[key].person_id]).then((r) => r[0]);
const xmin = async (key) => (await q("select xmin::text x from app.member_profile where person_id = $1", [P[key].person_id]))[0].x;
const asFields = (row) => ({ life_stage: row.life_stage, available_slots: row.available_slots ?? [], group_pref: row.group_pref, interests: row.interests ?? [], about_me: row.about_me });

// snapshot, so the demo database ends as it began
const snapshot = Object.fromEntries(await Promise.all([DANA, PRIYA, TOM].map(async (k) => [k, await stored(k)])));
async function restore() {
  for (const k of [DANA, PRIYA, TOM]) {
    const s = snapshot[k];
    if (!s) continue;
    await own.query("update app.member_profile set life_stage=$2, available_slots=$3, group_pref=$4, interests=$5, about_me=$6 where person_id=$1",
      [s.person_id, s.life_stage, s.available_slots, s.group_pref, s.interests, s.about_me]);
  }
}
async function cleanup() {
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
async function stubRun(key) {
  return as(key, async (db) => {
    const ids = (await db.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((g) => g.group_id);
    const n = Math.min(3, ids.length);
    const r = await db.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], 'llm', 'medium', 'test', 'stub-model', $3, '{}'::jsonb) as run_id", [ids, ids.slice(0, n), PROMPT_VERSION]);
    return r.rows[0].run_id;
  });
}
function stubModel() {
  const calls = { n: 0 };
  const fn = async (payload) => {
    calls.n++;
    const uniq = [...new Set([...JSON.stringify(payload).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].map((m) => m[0]))];
    return { raw: JSON.stringify({ ranked: uniq.slice(0, 2).map((g, i) => ({ group_id: g, rank: i + 1 })), internal_rationale: "stub rationale", confidence: "high" }), usage: { total_tokens: 1 }, latencyMs: 1, model: "stub-model" };
  };
  return { fn, calls };
}
const form = (o) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) for (const x of Array.isArray(v) ? v : [v]) if (x != null) f.append(k, x);
  return f;
};
const danaFields = () => asFields(snapshot[DANA]);

await restore(); await cleanup();

console.log("Summary and form data come from the database");
await test("Dana's preferences are read from member_profile, not hard-coded (and match the owner's view of the row)", async () => {
  const prefs = await getMyPreferences(DANA);
  const row = await stored(DANA);
  eq(prefs, { life_stage: row.life_stage, available_slots: row.available_slots, group_pref: row.group_pref, interests: row.interests, about_me: row.about_me });
  assert(prefs.about_me.includes("Moved here for work"), "about_me exactly as stored");
});
await test("another profile-bearing member gets their own values (Priya differs from Dana)", async () => {
  const dana = await getMyPreferences(DANA), priya = await getMyPreferences(PRIYA);
  eq(priya, asFields(await stored(PRIYA)), "Priya's row");
  assert(JSON.stringify(dana) !== JSON.stringify(priya), "different people, different data");
});
await test("the member payload has exactly the five editable fields: no features, scores, attendance, busy slots or model data", async () => {
  const prefs = await getMyPreferences(DANA);
  eq(Object.keys(prefs).sort(), [...EDITABLE].sort());
  assert(!/score|busy|attendance|confidence|rationale|shortlist|model|prompt/i.test(JSON.stringify(prefs)), "no internal fields");
});
await test("a member with no profile gets null (the intake route keeps its Journey 2 shell)", async () => {
  eq(await getMyPreferences("member_jordan"), null);
});
await test("opening the form and leaving (cancel) writes nothing: the row is untouched", async () => {
  const before = await xmin(DANA);
  await getMyPreferences(DANA);
  eq(await xmin(DANA), before, "row version unchanged");
  eq((await q("select count(*)::int c from app.audit_log where id > $1", [startAuditId]))[0].c, 0);
});

console.log("\nValidation (offline)");
await test("valid input parses; slots and interests come back in canonical order without duplicates", () => {
  const r = parseProfileForm(form({ life_stage: "young_kids", available_slots: ["thu_eve", "tue_am", "thu_eve"], group_pref: "women", interests: ["prayer", "bible_reading"], about_me: "Hello" }));
  assert(r.ok, JSON.stringify(r));
  eq(r.value.available_slots, ["tue_am", "thu_eve"]);
  eq(r.value.interests, ["bible_reading", "prayer"]);
});
await test("empty life stage and group preference are allowed (stored as null); an empty about_me is null", () => {
  const r = parseProfileForm(form({ life_stage: "", available_slots: ["tue_am"], group_pref: "", about_me: "   " }));
  assert(r.ok);
  eq([r.value.life_stage, r.value.group_pref, r.value.about_me, r.value.interests], [null, null, null, []]);
});
await test("invalid enum, slot and interest values are rejected", () => {
  for (const bad of [
    { life_stage: "astronaut", available_slots: ["tue_am"] },
    { available_slots: ["tue_am", "fri_midnight"] },
    { available_slots: ["tue_am"], group_pref: "aliens" },
    { available_slots: ["tue_am"], interests: ["prayer", "zz_test"] },
    { available_slots: ["tue_am"], interests: ["'; drop table app.member_profile; --"] },
  ]) assert(!parseProfileForm(form(bad)).ok, `accepted ${JSON.stringify(bad)}`);
});
await test("at least one meeting time is required", () => {
  const r = parseProfileForm(form({ life_stage: "single", about_me: "x" }));
  assert(!r.ok && r.errors.available_slots, "slots error");
});
await test("about_me length: 1000 characters pass, 1001 fail; line endings are normalised and words are kept", () => {
  assert(parseProfileForm(form({ available_slots: ["tue_am"], about_me: "a".repeat(ABOUT_ME_MAX) })).ok);
  const r = parseProfileForm(form({ available_slots: ["tue_am"], about_me: "a".repeat(ABOUT_ME_MAX + 1) }));
  assert(!r.ok && r.errors.about_me, "too long rejected");
  eq(normalizeAboutMe("one\r\ntwo \r\n"), "one\ntwo");
});
await test("a crafted person_id (or any extra field) in the form is ignored: the parsed value has only the five fields", () => {
  const r = parseProfileForm(form({ person_id: P[PRIYA].person_id, role: "manager", available_slots: ["tue_am"], consent_version: "x", profile_source: "hacked" }));
  assert(r.ok);
  eq(Object.keys(r.value).sort(), [...EDITABLE].sort());
});
await test("changedFields treats slot and interest order as unchanged", () => {
  const a = danaFields();
  eq(changedFields(a, { ...a, available_slots: [...a.available_slots].reverse(), interests: [...a.interests].reverse() }), []);
  eq(changedFields(a, { ...a, group_pref: "women" }), ["group_pref"]);
});
await test("the vocabulary matches what the database holds (every stored slot and interest is selectable)", async () => {
  const rows = await q("select distinct unnest(available_slots) v from app.member_profile");
  for (const r of rows) assert(SLOTS.includes(r.v), `slot ${r.v} missing from the form`);
  const ints = await q("select distinct unnest(interests) v from app.member_profile");
  for (const r of ints) assert(INTERESTS.includes(r.v), `interest ${r.v} missing from the form`);
});

console.log("\nSaving a material change");
let runBefore;
await test("a valid change persists; consent, source, distance, opt-in and confirmation are untouched", async () => {
  runBefore = await stubRun(DANA);
  const before = await stored(DANA);
  const next = { ...danaFields(), interests: [...danaFields().interests, "outdoors"] };
  const parsed = parseProfile(next);
  assert(parsed.ok);
  networkCalls = 0;
  const res = await saveMyProfile(DANA, parsed.value);
  eq(res, { ok: true, changed: ["interests"] });
  const after = await stored(DANA);
  assert(after.interests.includes("outdoors"), "interest saved");
  for (const k of ["opted_in_at", "consent_version", "max_distance_mi", "profile_source", "confirmed_at", "person_id"]) eq(after[k], before[k], k);
  for (const k of ["life_stage", "available_slots", "group_pref", "about_me"]) eq(after[k], before[k], k);
});
await test("it marks the member's current run out of date with reason profile_changed, and only theirs", async () => {
  const r = (await q("select * from app.recommendation_run where run_id = $1", [runBefore]))[0];
  assert(!r.is_current && r.invalidated_at, "old run no longer current");
  eq(r.invalidation_reason, "profile_changed");
  eq(r.invalidation_detail.person_id, P[DANA].person_id);
  eq((await peekRecommendations(DANA)).status, "none", "peek offers a new request, not the old run");
});
await test("the old run stays in the database for the Manager audit (run, candidates and ranked groups)", async () => {
  eq((await q("select count(*)::int c from app.recommendation_run_candidate where run_id = $1", [runBefore]))[0].c > 0, true);
  eq((await q("select count(*)::int c from app.recommendation where run_id = $1", [runBefore]))[0].c > 0, true);
  const m = await as("manager", (db) => db.query("select * from app.manager_recommendation_audit($1, null)", [P[DANA].person_id]));
  const old = m.rows.find((r) => r.run_id === runBefore);
  assert(old && !old.is_current && old.invalidation_reason === "profile_changed", "the Manager audit still lists the outdated run, with its reason");
  const member = await as(DANA, (db) => db.query("select * from app.manager_recommendation_audit($1, null)", [P[DANA].person_id]).then(() => "allowed", (e) => e.message));
  assert(/manager only|permission denied/i.test(member), "a member cannot call the Manager audit: " + member);
});
await test("saving made zero network calls and wrote no model audit row", async () => {
  eq(networkCalls, 0);
  eq((await q("select count(*)::int c from app.audit_log where id > $1 and action like 'llm%'", [startAuditId]))[0].c, 0);
});
await test("exactly one audit row is written: member_profile_updated, naming the field but no values, no about_me, no prompt", async () => {
  const rows = await q("select * from app.audit_log where id > $1 and action = 'member_profile_updated'", [startAuditId]);
  eq(rows.length, 1);
  eq([rows[0].entity, rows[0].entity_id], ["member_profile", P[DANA].person_id]);
  assert(rows[0].actor_user_id, "actor recorded");
  eq(rows[0].detail, { changed_fields: ["interests"] });
});
await test("the next explicit request generates a replacement run (one stubbed call) and does not reuse the old one", async () => {
  const stub = stubModel();
  const r = await getRecommendations(DANA, { callModel: stub.fn });
  assert(r.status === "ok" && r.source === "generated" && r.runId !== runBefore, "a new run");
  eq(stub.calls.n, 1);
  eq((await q("select count(*)::int c from app.recommendation_run where person_id = $1 and is_current", [P[DANA].person_id]))[0].c, 1, "one current run");
  const again = await getRecommendations(DANA, { callModel: stub.fn });
  assert(again.source === "reused" && stub.calls.n === 1, "then reused");
  eq(networkCalls, 0, "still no network");
});
await test("editing about_me alone is material, and its text never reaches the audit log", async () => {
  const text = "A very particular sentence zebra-quokka-4471 about my week.";
  const res = await saveMyProfile(DANA, { ...asFields(await stored(DANA)), about_me: text });
  eq(res, { ok: true, changed: ["about_me"] });
  eq((await stored(DANA)).about_me, text, "stored word for word");
  const audit = JSON.stringify(await q("select detail, action, entity from app.audit_log where id > $1 and action = 'member_profile_updated'", [startAuditId]));
  assert(audit.includes("changed_fields"), "the profile audit rows exist");
  assert(!audit.includes("zebra-quokka"), "about_me text in the audit log");
  assert(!/prompt/i.test(audit), "prompt content in the audit log");
  eq((await peekRecommendations(DANA)).status, "none", "the replacement run was also invalidated");
});

console.log("\nSaving an identical confirmation");
await test("an identical save changes nothing: no update, no audit row, the saved run stays current and reusable", async () => {
  await restore(); await cleanup();
  const runId = await stubRun(DANA);
  const xBefore = await xmin(DANA);
  const res = await saveMyProfile(DANA, danaFields());
  eq(res, { ok: true, changed: [] });
  eq(await xmin(DANA), xBefore, "row not rewritten");
  eq((await q("select count(*)::int c from app.audit_log where id > $1", [startAuditId]))[0].c, 0, "no audit noise");
  const run = (await q("select is_current from app.recommendation_run where run_id = $1", [runId]))[0];
  assert(run.is_current, "still current");
  const stub = stubModel();
  const r = await getRecommendations(DANA, { callModel: stub.fn });
  assert(r.source === "reused" && r.runId === runId && stub.calls.n === 0, "reused with zero calls");
});
await test("ticking the same boxes in a different order, or a browser's CRLF line endings, is not a change", async () => {
  const f = danaFields();
  const noisy = parseProfileForm(form({ life_stage: f.life_stage, available_slots: [...f.available_slots].reverse(), group_pref: f.group_pref, interests: [...f.interests].reverse(), about_me: f.about_me.replace(/\n/g, "\r\n") + "  " }));
  assert(noisy.ok);
  eq(await saveMyProfile(DANA, noisy.value), { ok: true, changed: [] });
  assert((await peekRecommendations(DANA)).status === "ok", "run still valid");
});
await test("changing a value and then changing it back are two changes; each invalidates the run that was current", async () => {
  await cleanup();
  const run1 = await stubRun(DANA);
  eq((await saveMyProfile(DANA, { ...danaFields(), group_pref: "women" })).changed, ["group_pref"]);
  assert(!(await q("select is_current from app.recommendation_run where run_id = $1", [run1]))[0].is_current, "first run invalid");
  const run2 = await stubRun(DANA);
  eq((await saveMyProfile(DANA, danaFields())).changed, ["group_pref"]);
  assert(!(await q("select is_current from app.recommendation_run where run_id = $1", [run2]))[0].is_current, "second run invalid");
  eq((await stored(DANA)).group_pref, snapshot[DANA].group_pref, "original value back");
  eq((await q("select count(*)::int c from app.audit_log where id > $1 and action = 'member_profile_updated'", [startAuditId]))[0].c, 2, "two audit rows");
});

console.log("\nSecurity");
await test("a member cannot change another person's profile with crafted SQL: zero rows, nothing written", async () => {
  const before = JSON.stringify(await stored(PRIYA));
  const r = await as(DANA, (db) => db.query("update app.member_profile set about_me = 'defaced' where person_id = $1", [P[PRIYA].person_id]));
  eq(r.rowCount, 0);
  eq(JSON.stringify(await stored(PRIYA)), before);
});
await test("a member cannot read another member's profile", async () => {
  const r = await as(DANA, (db) => db.query("select * from app.member_profile where person_id = $1", [P[PRIYA].person_id]));
  eq(r.rows, []);
});
await test("a Leader cannot read or update Dana's profile", async () => {
  const sel = await as(TOM, (db) => db.query("select * from app.member_profile where person_id = $1", [P[DANA].person_id]));
  eq(sel.rows, []);
  const upd = await as(TOM, (db) => db.query("update app.member_profile set about_me = 'defaced' where person_id = $1", [P[DANA].person_id]));
  eq(upd.rowCount, 0);
  assert(!(await stored(DANA)).about_me.includes("defaced"));
});
await test("the save helper takes no person id: a Leader using it can only ever touch their own row", async () => {
  const dBefore = JSON.stringify(await stored(DANA));
  const tom = snapshot[TOM];
  if (tom) {
    const res = await saveMyProfile(TOM, { ...asFields(tom), about_me: "tom's own words" });
    assert(res.ok, "own row");
    eq(JSON.stringify(await stored(DANA)), dBefore, "Dana untouched");
  }
  assert(saveMyProfile.length === 2, "signature is (personKey, fields)");
});
await test("a persona with no profile gets no_profile, and a persona key that does not exist is refused", async () => {
  eq(await saveMyProfile("member_jordan", { ...danaFields() }), { ok: false, code: "no_profile" });
  eq((await saveMyProfile("not_a_persona", danaFields())).ok, false);
});
await test("the app role cannot touch fields it should not: it has no way to change opt-in or consent through this path", async () => {
  const before = await stored(DANA);
  await saveMyProfile(DANA, { ...danaFields(), group_pref: "couples" });
  const after = await stored(DANA);
  for (const k of ["opted_in_at", "consent_version", "max_distance_mi", "profile_source", "confirmed_at"]) eq(after[k], before[k], k);
});

await restore(); await cleanup();
// the restore above fired the invalidation trigger; remove any run it touched
await cleanup();
const final = await stored(DANA);
eq(JSON.stringify(asFields(final)), JSON.stringify(danaFields()), "Dana restored");
await test("the database ends as it began: profiles restored, no runs, no audit rows added", async () => {
  for (const k of [DANA, PRIYA, TOM]) if (snapshot[k]) eq(JSON.stringify(asFields(await stored(k))), JSON.stringify(asFields(snapshot[k])), k);
  eq((await q("select count(*)::int c from app.recommendation_run"))[0].c, 0);
  eq((await q("select count(*)::int c from app.audit_log where id > $1", [startAuditId]))[0].c, 0);
});

await own.end(); await appPool.end();
console.log(`\n${failed === 0 ? "ALL PASS" : "FAILURES"}: ${passed} passed, ${failed} failed`);
if (failed) { console.log("Failed:\n - " + failures.join("\n - ")); process.exit(1); }
