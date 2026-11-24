// Gathered: build workspace.gathered.demand_gaps in Databricks and reconcile it with an
// independent JavaScript implementation computed from the seed CSVs.
//
//   node databricks/demand.mjs
//
// Thresholds (see databricks/sql/demand_gaps.sql and DEMAND_GAPS.md): MIN_PEOPLE 5, PRESSURE_HIGH 4.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readCsv } from "../lib/seed/csv.mjs";
import { computePersonFeatures } from "../lib/features/person-features.mjs";
import { demandGapCohorts, MIN_PEOPLE, PRESSURE_HIGH } from "../lib/analytics/demand-gaps-reference.mjs";
import { NS, query, sql } from "./dbx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const text = fs.readFileSync(path.join(HERE, "sql", "demand_gaps.sql"), "utf8")
  .replaceAll("{NS}", NS).replaceAll("{MIN_PEOPLE}", String(MIN_PEOPLE)).replaceAll("{PRESSURE_HIGH}", String(PRESSURE_HIGH));
await sql(text);

const dbx = await query(`select * from ${NS}.demand_gaps order by life_stage, available_slot`);
const { rows: feats } = computePersonFeatures({
  people: readCsv("person.csv"), servingAssignments: readCsv("serving_assignment.csv"),
  ministries: readCsv("ministry.csv"), services: readCsv("service.csv"), attendance: readCsv("attendance_event.csv"),
});
const busySlotsByPerson = Object.fromEntries([...feats.values()].map((f) => [f.person_id, f.busy_slots]));
const ref = demandGapCohorts({
  profiles: readCsv("member_profile.csv"), people: readCsv("person.csv"), households: readCsv("household.csv"),
  memberships: readCsv("group_membership.csv"), groups: readCsv("grp.csv"), busySlotsByPerson,
});

const FIELDS = ["opted_in_ungrouped_count", "serving_group_count", "available_seat_count", "people_without_group_in_catalog", "people_without_reachable_group"];
let diffs = 0;
if (dbx.length !== ref.length) { diffs++; console.log(`cohort count differs: databricks ${dbx.length}, reference ${ref.length}`); }
const refByKey = new Map(ref.map((r) => [`${r.life_stage}|${r.available_slot}`, r]));
for (const d of dbx) {
  const r = refByKey.get(`${d.life_stage}|${d.available_slot}`);
  if (!r) { diffs++; console.log("only in Databricks:", d.life_stage, d.available_slot); continue; }
  for (const f of FIELDS) if (Number(d[f]) !== r[f]) { diffs++; console.log(`DIFF ${d.life_stage}/${d.available_slot} ${f}: dbx=${d[f]} ref=${r[f]}`); }
  if (d.gap_classification !== r.gap_classification) { diffs++; console.log(`DIFF ${d.life_stage}/${d.available_slot} class: dbx=${d.gap_classification} ref=${r.gap_classification}`); }
}
console.log(`demand_gaps: ${dbx.length} cohorts in Databricks, ${ref.length} in the independent reference, ${diffs} differences`);
const gaps = dbx.filter((d) => d.gap_rank != null).sort((a, b) => Number(a.gap_rank) - Number(b.gap_rank));
console.log(`gap cohorts: ${gaps.length}`);
console.table(gaps.slice(0, 8).map((g) => ({ rank: g.gap_rank, life_stage: g.life_stage, slot: g.available_slot, people: g.opted_in_ungrouped_count, groups: g.serving_group_count, seats: g.available_seat_count, no_reach: g.people_without_reachable_group, class: g.gap_classification })));
process.exit(diffs ? 1 : 0);
