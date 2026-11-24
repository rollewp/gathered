// Gathered: OFFLINE tests of the demand-gap cohort rules (reference implementation).
// No database, no network, no Databricks. The Databricks output is reconciled with this same
// reference by `npm run dbx:verify` (explicit; it uses the workspace).
//
//   npm run test:eval
import { demandGapCohorts, classify, MIN_PEOPLE, PRESSURE_HIGH } from "../lib/analytics/demand-gaps-reference.mjs";
import { readCsv } from "../lib/seed/csv.mjs";
import { computePersonFeatures } from "../lib/features/person-features.mjs";

let passed = 0, failed = 0;
function test(name, fn) { try { fn(); passed++; console.log(`  PASS  ${name}`); } catch (e) { failed++; console.log(`  FAIL  ${name}\n        ${e.message}`); } }
function assert(c, m) { if (!c) throw new Error(m ?? "assertion failed"); }
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), `${m ?? "not equal"}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

// ---- a tiny world: one household location, everyone at the same place
const HH = { household_id: "h", lat_approx: "28.5", lng_approx: "-81.6" };
const person = (id, over = {}) => ({ person_id: id, household_id: "h", household_role: "adult", gender: "F", ...over });
const profile = (id, over = {}) => ({ person_id: id, opted_in_at: "2026-10-01T00:00:00", life_stage: "young_kids", available_slots: "{tue_am}", ...over });
const grp = (id, over = {}) => ({ group_id: id, meeting_slot: "tue_am", life_stage_focus: "", gender_focus: "mixed", status: "open", capacity_max: "8", is_online: "False", lat_approx: "28.5", lng_approx: "-81.6", ...over });
const world = (over = {}) => ({
  profiles: [], people: [], households: [HH], memberships: [], groups: [], busySlotsByPerson: {}, ...over,
});

console.log("Classification");
test("thresholds are the documented ones", () => eq([MIN_PEOPLE, PRESSURE_HIGH], [5, 4]));
test("below the minimum size is never a gap; no compatible group; high pressure; limited reach; otherwise served", () => {
  eq(classify({ people: 4, groups: 0, seats: 0, unreachable: 4 }), "Not a gap");
  eq(classify({ people: 5, groups: 0, seats: 0, unreachable: 5 }), "No current group");
  eq(classify({ people: 20, groups: 1, seats: 5, unreachable: 0 }), "High demand");
  eq(classify({ people: 20, groups: 1, seats: 6, unreachable: 12 }), "Limited reach");
  eq(classify({ people: 20, groups: 3, seats: 30, unreachable: 4 }), "Served");
});

console.log("\nPopulation and supply rules");
const many = (n, f) => Array.from({ length: n }, (_, i) => f(`p${i}`, i));
test("only opted-in adults without an active membership are counted; children, non-opted-in and grouped adults are not", () => {
  const ids = many(9, (id) => id);
  const people = ids.map((id, i) => person(id, i === 0 ? { household_role: "child" } : {}));
  const profiles = ids.map((id, i) => profile(id, i === 1 ? { opted_in_at: "" } : {}));
  const memberships = [{ group_id: "gX", person_id: "p2", status: "active" }, { group_id: "gX", person_id: "p3", status: "left" }];
  const r = demandGapCohorts(world({ people, profiles, memberships, groups: [grp("gX")] }));
  // p0 child, p1 not opted in, p2 grouped -> 6 remain (p3 left the group so is ungrouped)
  eq(r[0].opted_in_ungrouped_count, 6);
});
test("a person rostered to serve in a slot does not count in that slot", () => {
  const ids = many(6, (id) => id);
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i)), busySlotsByPerson: { p0: ["tue_am"], p1: ["tue_am"] } }));
  eq(r[0].opted_in_ungrouped_count, 4);
});
test("supply counts only open/forming groups with a seat, in the slot, with an empty or matching life stage", () => {
  const ids = many(6, (id) => id);
  const memberships = Array.from({ length: 8 }, (_, i) => ({ group_id: "gFull", person_id: `m${i}`, status: "active" }));
  const groups = [
    grp("gOpen", { capacity_max: "10" }),
    grp("gForming", { status: "forming", capacity_max: "4" }),
    grp("gFull"), // 8 of 8
    grp("gClosed", { status: "closed" }),
    grp("gWrongStage", { life_stage_focus: "retired" }),
    grp("gRightStage", { life_stage_focus: "young_kids", capacity_max: "3" }),
    grp("gOtherSlot", { meeting_slot: "wed_am" }),
  ];
  groups[2].group_id = "gFull";
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i)), memberships, groups }));
  eq(r[0].serving_group_count, 3, "open + forming + matching stage");
  eq(r[0].available_seat_count, 10 + 4 + 3);
});
test("distance and gender focus affect reach but not the catalog counts, and both are reported separately", () => {
  const ids = many(6, (id) => id);
  const far = grp("gFar", { lat_approx: "29.5" }); // about 69 miles away
  const men = grp("gMen", { gender_focus: "men" });
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i)), groups: [far, men] }))[0];
  eq(r.serving_group_count, 2);
  eq(r.people_without_group_in_catalog, 0);
  eq(r.people_without_reachable_group, 6, "women, far group and men's group: no reachable group");
});
test("an online group is reachable at any distance", () => {
  const ids = many(6, (id) => id);
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i)), groups: [grp("gOnline", { lat_approx: "29.5", is_online: "True" })] }))[0];
  eq(r.people_without_reachable_group, 0);
});
test("a person with several available slots appears once in each slot's cohort", () => {
  const ids = many(5, (id) => id);
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i, { available_slots: "{tue_am,wed_am}" })) }));
  eq(r.map((c) => [c.available_slot, c.opted_in_ungrouped_count]), [["tue_am", 5], ["wed_am", 5]]);
});
test("the output carries aggregates only: no person ids, names or other details", () => {
  const ids = many(5, (id) => id);
  const r = demandGapCohorts(world({ people: ids.map((i) => person(i)), profiles: ids.map((i) => profile(i)) }));
  eq(Object.keys(r[0]).sort(), ["available_seat_count", "available_slot", "gap_classification", "life_stage", "opted_in_ungrouped_count",
    "people_without_group_in_catalog", "people_without_reachable_group", "serving_group_count"]);
});

console.log("\nThe V2 seed");
const seedWorld = (() => {
  const { rows } = computePersonFeatures({ people: readCsv("person.csv"), servingAssignments: readCsv("serving_assignment.csv"), ministries: readCsv("ministry.csv"), services: readCsv("service.csv"), attendance: readCsv("attendance_event.csv") });
  return {
    profiles: readCsv("member_profile.csv"), people: readCsv("person.csv"), households: readCsv("household.csv"),
    memberships: readCsv("group_membership.csv"), groups: readCsv("grp.csv"),
    busySlotsByPerson: Object.fromEntries([...rows.values()].map((f) => [f.person_id, f.busy_slots])),
  };
})();
const seed = demandGapCohorts(seedWorld);
test("the seed yields cohorts, and every classification is one of the five", () => {
  assert(seed.length > 30);
  const ok = new Set(["No current group", "High demand", "Limited reach", "Served", "Not a gap"]);
  assert(seed.every((c) => ok.has(c.gap_classification)));
});
test("cohort demand reconciles to the source: the people in every cohort are the opted-in, ungrouped, available adults", () => {
  const personById = Object.fromEntries(seedWorld.people.map((p) => [p.person_id, p]));
  const grouped = new Set(seedWorld.memberships.filter((m) => m.status === "active").map((m) => m.person_id));
  let expected = 0;
  for (const pr of seedWorld.profiles) {
    const p = personById[pr.person_id];
    if (p?.household_role !== "adult" || grouped.has(pr.person_id) || !pr.life_stage) continue;
    const busy = new Set(seedWorld.busySlotsByPerson[pr.person_id] ?? []);
    expected += pr.available_slots.replace(/[{}"]/g, "").split(",").filter((s) => s && !busy.has(s)).length;
  }
  eq(seed.reduce((a, c) => a + c.opted_in_ungrouped_count, 0), expected);
});
test("the weekday-morning cohorts are the gaps in the seed (the designed unmet-demand story)", () => {
  const gaps = seed.filter((c) => ["No current group", "High demand", "Limited reach"].includes(c.gap_classification));
  assert(gaps.length >= 5 && gaps.every((c) => c.available_slot.endsWith("_am") || c.available_slot === "mon_eve"), JSON.stringify(gaps.map((g) => g.available_slot)));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
