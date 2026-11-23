// Gathered: OFFLINE tests for the Manager schedule-conflict review contract (schedule-conflict-v1).
// No database, no network, no model calls.
//
//   npm run test:eval   (runs this after the other offline tests)
import { REVIEW_SYSTEM_PROMPT, REVIEW_PROMPT_VERSION, REVIEW_KIND, ReviewSchema, parseReview, reviewFacts, ungroundedNumbers, slotMeaning } from "../lib/review/schedule-conflict.mjs";

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m ?? "assertion failed"); }
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
const rejects = (fn, m) => { let threw = false; try { fn(); } catch { threw = true; } assert(threw, m ?? "expected an error"); };

const candidate = {
  first_name: "Marcus", member_note: null, group_name: "Sunday Lunch D-Group",
  group_description: "We meet right after second service over lunch.", meeting_slot: "sun_pm",
  busy_slots: ["sun_11"], serving_areas: ["kids"], about_me: "I help in the preschool room during second service most Sundays.",
};
const facts = reviewFacts(candidate);
const good = { raise: true, kind: "schedule_conflict", severity: "medium", summary: "Marcus may arrive late.", evidence: ["He serves at the Sunday second service (11:00).", "The group meets right after second service."] };
const raw = (o) => JSON.stringify(o);

console.log("Prompt");
test("prompt version and kind are the approved values", () => { eq(REVIEW_PROMPT_VERSION, "schedule-conflict-v1"); eq(REVIEW_KIND, "schedule_conflict"); });
test("the prompt demands supplied facts only, no invented times, no diagnosis, a preference for not raising, advisory wording and JSON only", () => {
  for (const re of [/Use only the supplied facts/, /Do not invent service times/, /Do not diagnose/, /Prefer raise false when unsure/, /Do not recommend accepting, declining/, /single JSON object only/])
    assert(re.test(REVIEW_SYSTEM_PROMPT), `missing ${re}`);
});

console.log("\nSupplied facts");
test("the facts hold only the request, the group's schedule and description, and the requester's serving schedule", () => {
  eq(Object.keys(facts).sort(), ["group", "request", "requester_schedule", "task"]);
  eq(Object.keys(facts.requester_schedule).sort(), ["about_me", "serving_areas", "serving_slots"]);
  eq(facts.requester_schedule.serving_slots, [{ slot: "sun_11", meaning: "Sunday second service (11:00)" }]);
  eq(facts.group.meeting_slot_meaning, "Sunday afternoon, after the services");
});
test("no person id, last name, score, attendance or profile field can appear in the facts", () => {
  const s = JSON.stringify(reviewFacts({ ...candidate, person_id: "x", last_name: "Hale", attendance_rate_12w: 1, life_stage: "young_kids" }));
  assert(!/person_id|Hale|attendance|life_stage|score|rationale/i.test(s), s);
});
test("slot meanings: known codes use the legend, others fall back to day and part of day", () => {
  eq(slotMeaning("tue_eve"), "Tuesday evening");
  eq(slotMeaning("weird"), "weird");
});

console.log("\nValidation");
test("a well-formed raised review parses", () => eq(parseReview(raw(good), facts).raise, true));
test("a well-formed not-raised review parses (low severity, no evidence)", () => {
  const r = parseReview(raw({ raise: false, kind: "schedule_conflict", severity: "low", summary: "No overlap found.", evidence: [] }), facts);
  eq([r.raise, r.evidence], [false, []]);
});
test("code fences are tolerated; prose and malformed JSON are not", () => {
  assert(parseReview("```json\n" + raw(good) + "\n```", facts).raise);
  rejects(() => parseReview("Marcus may arrive late.", facts));
  rejects(() => parseReview("{not json", facts));
});
test("raise must be a boolean; kind must be schedule_conflict; severity must be an allowed value", () => {
  rejects(() => parseReview(raw({ ...good, raise: "yes" }), facts), "string raise");
  rejects(() => parseReview(raw({ ...good, kind: "needs_care" }), facts), "other kind");
  rejects(() => parseReview(raw({ ...good, severity: "critical" }), facts), "bad severity");
  rejects(() => ReviewSchema.parse({ ...good, raise: undefined }), "missing raise");
});
test("summary and evidence are bounded", () => {
  rejects(() => parseReview(raw({ ...good, summary: "x".repeat(301) }), facts), "long summary");
  rejects(() => parseReview(raw({ ...good, summary: "" }), facts), "empty summary");
  rejects(() => parseReview(raw({ ...good, evidence: Array(5).fill("a fact") }), facts), "five evidence items");
  rejects(() => parseReview(raw({ ...good, evidence: ["x".repeat(241)] }), facts), "long evidence");
});
test("a raised review needs evidence; a review that is not raised must have none", () => {
  rejects(() => parseReview(raw({ ...good, evidence: [] }), facts), "raise without evidence");
  rejects(() => parseReview(raw({ ...good, raise: false }), facts), "evidence without raise");
});
test("numbers the facts never supplied are rejected (invented times and travel times)", () => {
  rejects(() => parseReview(raw({ ...good, summary: "Marcus may arrive 30-40 minutes late." }), facts), "30-40 minutes");
  rejects(() => parseReview(raw({ ...good, evidence: ["He serves until 12:15."] }), facts), "12:15");
  eq(ungroundedNumbers(["11:00 service"], facts), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
