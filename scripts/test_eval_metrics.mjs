// Gathered: OFFLINE tests for the evaluation label model and the ranking-evaluation metrics.
// No database, no network, no model calls (so they are safe to run before the Lakebase load).
//
//   npm run test:eval
import fs from "node:fs";
import path from "node:path";
import { readCsv } from "../lib/seed/csv.mjs";
import { parseLabels, partitionLabels, originalLabelMatcher, validateLabelSchema, OUTCOME_TYPES, EXPECTATIONS } from "../lib/seed/eval-labels.mjs";
import { emptyStats, recordRun, judgeRun, computeStability, passMark, rate } from "../lib/ranking/eval-metrics.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m ?? "assertion failed"); }
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

const rows = readCsv("eval_label.csv");
const labels = parseLabels(rows);
const { ranking, policy, policyByType } = partitionLabels(labels);
const { isOriginal, entries } = originalLabelMatcher();
const grp = new Set(readCsv("grp.csv").map((g) => g.group_id));
const people = new Set(readCsv("person.csv").map((p) => p.person_id));

console.log("Label model (seed/out/eval_label.csv)");
test("the real label file passes schema validation", () => eq(validateLabelSchema(labels, grp, people), []));
test("outcome_type uses only the controlled vocabulary, and every value in the vocabulary is exercised", () => {
  assert(labels.every((l) => OUTCOME_TYPES.includes(l.outcome_type)));
  for (const t of OUTCOME_TYPES) assert(labels.some((l) => l.outcome_type === t), `no scenario of type ${t}`);
});
test("ranking labels carry an expectation and an expected group; policy labels carry no expectation", () => {
  assert(ranking.every((l) => EXPECTATIONS.includes(l.expectation) && l.expected_group_id));
  assert(policy.every((l) => !l.expectation));
});
test("top1_or_alternates labels have alternates; the other expectations have none", () => {
  assert(ranking.filter((l) => l.expectation === "top1_or_alternates").every((l) => l.acceptable.length > 0));
  assert(ranking.filter((l) => l.expectation !== "top1_or_alternates").every((l) => l.acceptable.length === 0));
});
test("partition: ranking and policy are disjoint and cover every label", () => {
  eq(ranking.length + policy.length, labels.length);
  assert(!ranking.some((l) => policy.includes(l)));
  eq(Object.values(policyByType).flat().length, policy.length);
});
test("the 14 original labels are all present, ranking, and keep their expected group and alternates (stable_ids.json)", () => {
  eq(entries.length, 14);
  for (const e of entries) {
    const l = labels.find((x) => x.label_key === e.key && x.person_id === e.person_id);
    assert(l, `missing original label ${e.key}`);
    assert(l.outcome_type === "ranking" && l.expected_group_id === e.expected_group_id && l.acceptable_group_ids === e.acceptable_group_ids, `${e.key} changed`);
  }
  eq(labels.filter(isOriginal).length, 14);
});
test("policy scenarios are never part of the ranking set sent to the model", () => {
  const ids = new Set(ranking.map((l) => `${l.label_key}|${l.person_id}`));
  for (const l of policy) assert(!ids.has(`${l.label_key}|${l.person_id}`));
});
test("the schema validator rejects malformed labels", () => {
  const base = ranking.find((l) => l.expectation === "top1");
  const bad = (patch) => validateLabelSchema([{ ...base, ...patch }], grp, people).length > 0;
  assert(bad({ outcome_type: "top1" }), "old outcome_type accepted");
  assert(bad({ expectation: "" }), "ranking without expectation accepted");
  assert(bad({ expected_group_id: "" }), "ranking without expected group accepted");
  assert(bad({ expected_group_id: "00000000-0000-0000-0000-000000000000" }), "unknown group accepted");
  assert(bad({ outcome_type: "empty", expectation: "" }), "empty label naming a group accepted");
  assert(bad({ excluded: [base.expected_group_id] }), "expected group also excluded accepted");
  assert(bad({ acceptable: [base.expected_group_id] }), "alternates on a top1 label accepted");
});

console.log("\nMetrics (lib/ranking/eval-metrics.mjs)");
const L = (over) => ({ expected_group_id: "x", acceptable: [], acceptableOrExpected: ["x"], expectation: "top1", ...over });
test("judgeRun: top1 is strict and top3 accepts the expected group anywhere in the list", () => {
  const l = L({});
  eq(judgeRun(l, ["x", "a", "b"]), { top1Applies: true, top1: true, top1Accepted: true, top3: true });
  eq(judgeRun(l, ["a", "x", "b"]), { top1Applies: true, top1: false, top1Accepted: false, top3: true });
  eq(judgeRun(l, ["a", "b", "c"]), { top1Applies: true, top1: false, top1Accepted: false, top3: false });
});
test("judgeRun: an accepted alternate counts toward Top-1 (accepted) and Top-3 but not strict Top-1", () => {
  const l = L({ expectation: "top1_or_alternates", acceptable: ["y"], acceptableOrExpected: ["x", "y"] });
  eq(judgeRun(l, ["y", "a", "b"]), { top1Applies: true, top1: false, top1Accepted: true, top3: true });
});
test("judgeRun: a top3 label has no Top-1 expectation", () => {
  const j = judgeRun(L({ expectation: "top3" }), ["a", "x", "b"]);
  assert(!j.top1Applies && j.top3);
});
test("recordRun: Top-1 is counted only where it applies; fallbacks and tokens accumulate", () => {
  const s = emptyStats();
  recordRun(s, { ...judgeRun(L({}), ["x"]), fallback: false, latency: 100, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 } });
  recordRun(s, { ...judgeRun(L({ expectation: "top3" }), ["x"]), fallback: true, latency: 50 });
  eq([s.runs, s.top1Runs, s.top1, s.top3, s.fallback, s.totalTokens, s.latencyTotal], [2, 1, 1, 2, 1, 15, 150]);
  eq(rate(s.fallback, s.runs), 0.5);
});
test("stability: a label is stable when at least 2 of 3 runs agree on the first group", () => {
  const rec = (a, b, c) => ({ variants: { A: { runs: [a, b, c].map((x) => ({ ranked: [x] })) } } });
  eq(computeStability([rec("p", "p", "q"), rec("p", "q", "r")], "A"), { stable: 1, total: 2 });
});
test("pass mark reproduces the original rule for 14 labels: Top-1 >= 10, Top-3 >= 13, no fallbacks, all stable", () => {
  const mk = (top1, top3) => ({ ...emptyStats(), runs: 42, top1Runs: 42, top1: Math.round(top1 * 3), top3: Math.round(top3 * 3), fallback: 0 });
  const stable = { stable: 14, total: 14 };
  assert(passMark(mk(10, 13), stable).ok, "10/13 should pass");
  assert(!passMark(mk(9, 13), stable).ok, "9 top-1 should fail");
  assert(!passMark(mk(10, 12), stable).ok, "12 top-3 should fail");
  assert(!passMark({ ...mk(14, 14), fallback: 1 }, stable).ok, "a fallback should fail");
  assert(!passMark(mk(14, 14), { stable: 13, total: 14 }).ok, "an unstable label should fail");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
