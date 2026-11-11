// Gathered: OFFLINE tests for the ranking output contract (rank-v2, 1 to 3 groups).
// No database, no network, no model calls.
//
//   npm run test:eval   (runs this after the label/metric tests)
import { SYSTEM_PROMPT, PROMPT_VERSION, OutputSchema, parseRanking, validateSemantics, scoreOrderFallback } from "../lib/ranking/rank-v2.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m ?? "assertion failed"); }
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const rejects = (fn, m) => { let threw = false; try { fn(); } catch { threw = true; } assert(threw, m ?? "expected an error"); };

const ids = ["a1a1a1a1-0000-4000-8000-000000000001", "a1a1a1a1-0000-4000-8000-000000000002", "a1a1a1a1-0000-4000-8000-000000000003",
  "a1a1a1a1-0000-4000-8000-000000000004", "a1a1a1a1-0000-4000-8000-000000000005", "a1a1a1a1-0000-4000-8000-000000000006"];
const shortlist = new Set(ids);
const raw = (items, extra = {}) => JSON.stringify({ ranked: items.map((g, i) => ({ group_id: g, rank: i + 1 })), internal_rationale: "r", confidence: "medium", ...extra });

console.log("Prompt (rank-v2, 1 to 3 groups)");
test("the prompt version is unchanged (rank-v2); the contract was modified in place", () => eq(PROMPT_VERSION, "rank-v2"));
test("the prompt no longer demands exactly three, and forbids padding", () => {
  assert(!/exactly 3|never fewer than 3|always include a third/i.test(SYSTEM_PROMPT), "old fill-to-three wording is still present");
  assert(/between 1 and 3/i.test(SYSTEM_PROMPT), "1 to 3 not stated");
  assert(/positively support/i.test(SYSTEM_PROMPT), "positive-support rule missing");
  assert(/do not add a group just to reach three/i.test(SYSTEM_PROMPT), "no-fill rule missing");
  assert(/at least the single best-supported group/i.test(SYSTEM_PROMPT), "minimum of one missing");
});
test("the rest of the prompt intent is preserved (shortlist-only, no inference about the member, internal rationale, JSON only)", () => {
  assert(/Use only group_ids from the shortlist/.test(SYSTEM_PROMPT));
  assert(/Do not infer or mention anything about the member's spiritual state/.test(SYSTEM_PROMPT));
  assert(/internal audit note for the groups pastor/.test(SYSTEM_PROMPT));
  assert(/single JSON object only/.test(SYSTEM_PROMPT));
});

console.log("\nValidation");
test("1, 2 and 3 groups are all valid when the maximum is 3 (order is by rank)", () => {
  for (const k of [1, 2, 3]) eq(parseRanking(raw(ids.slice(0, k)), shortlist, 3).orderedIds, ids.slice(0, k), `${k} groups`);
});
test("ranks are returned in rank order even if listed out of order", () => {
  const out = JSON.stringify({ ranked: [{ group_id: ids[2], rank: 2 }, { group_id: ids[0], rank: 1 }], internal_rationale: "r", confidence: "high" });
  eq(parseRanking(out, shortlist, 3).orderedIds, [ids[0], ids[2]]);
});
test("the maximum follows the shortlist: a 2-group shortlist allows 1 or 2, not 3", () => {
  const two = new Set(ids.slice(0, 2));
  eq(parseRanking(raw([ids[0]]), two, 2).orderedIds, [ids[0]]);
  eq(parseRanking(raw(ids.slice(0, 2)), two, 2).orderedIds.length, 2);
  rejects(() => parseRanking(raw(ids.slice(0, 3)), two, 2), "3 from a 2-group shortlist");
});
test("a 1-group shortlist allows exactly that one", () => eq(parseRanking(raw([ids[0]]), new Set([ids[0]]), 1).orderedIds, [ids[0]]));
test("zero groups is rejected (the minimum is one)", () => {
  rejects(() => parseRanking(raw([]), shortlist, 3), "empty ranked list");
  rejects(() => OutputSchema.parse(JSON.parse(raw([]))), "schema accepts empty list");
});
test("more than three is rejected", () => rejects(() => parseRanking(raw(ids.slice(0, 4)), shortlist, 3), "4 groups"));
test("a group that is not on the shortlist is rejected", () => rejects(() => parseRanking(raw([ids[0], "a1a1a1a1-0000-4000-8000-0000000000ff"]), shortlist, 3)));
test("duplicates are rejected", () => rejects(() => parseRanking(raw([ids[0], ids[0]]), shortlist, 3)));
test("ranks must be 1..n with no gaps: [1] ok, [2] alone and [1,3] rejected", () => {
  const mk = (ranks) => JSON.stringify({ ranked: ranks.map((r, i) => ({ group_id: ids[i], rank: r })), internal_rationale: "r", confidence: "low" });
  parseRanking(mk([1]), shortlist, 3);
  rejects(() => parseRanking(mk([2]), shortlist, 3), "rank 2 alone");
  rejects(() => parseRanking(mk([1, 3]), shortlist, 3), "gap in ranks");
  rejects(() => parseRanking(mk([1, 1]), shortlist, 3), "repeated rank");
});
test("malformed output is rejected: not JSON, missing rationale, bad confidence, code fences are tolerated", () => {
  rejects(() => parseRanking("not json", shortlist, 3));
  rejects(() => parseRanking(JSON.stringify({ ranked: [{ group_id: ids[0], rank: 1 }], confidence: "high" }), shortlist, 3));
  rejects(() => parseRanking(raw([ids[0]], { confidence: "certain" }), shortlist, 3));
  eq(parseRanking("```json\n" + raw([ids[0], ids[1]]) + "\n```", shortlist, 3).orderedIds, [ids[0], ids[1]]);
});
test("validateSemantics reports the 1..max range in its message", () => {
  try { validateSemantics({ ranked: [] }, shortlist, 3); assert(false, "no throw"); } catch (e) { assert(/between 1 and 3/.test(e.message), e.message); }
});

console.log("\nFallback");
test("the score fallback is still the top min(3, n) by score order (deterministic, not a judgement of fit)", () => {
  eq(scoreOrderFallback(ids, 3), ids.slice(0, 3));
  eq(scoreOrderFallback(ids.slice(0, 2), 2), ids.slice(0, 2));
  eq(scoreOrderFallback(ids.slice(0, 1), 1), ids.slice(0, 1));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
