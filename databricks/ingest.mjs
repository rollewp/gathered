// Gathered: load the V2 synthetic seed into Delta tables (workspace.gathered.*).
//
//   node databricks/ingest.mjs
//
// Repeatable and idempotent: every table is CREATE OR REPLACE ... AS SELECT from the CSVs uploaded
// to the UC volume workspace.gathered.seed. All columns are read as STRING (explicit schema) and cast
// here, so types are decided in one place. Stable ids stay strings, exactly as generated. Row counts
// are compared with the CSV files and the script fails if any differ.
//
// Minimal on purpose: only the tables the analytics needs. Names, gender and free-text
// (about_me, descriptions) are not loaded. No secrets: authentication is the Databricks CLI profile.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCsv } from "../lib/seed/csv.mjs";
import { NS, query, sql, upload } from "./dbx.mjs";

const SEED = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "seed", "out");
const VOL = "/Volumes/workspace/gathered/seed";
const arr = (c) => `filter(split(regexp_replace(${c}, '[{}"]', ''), ','), x -> x <> '')`;
const bool = (c) => `lower(${c}) = 'true'`;

// table -> { csv, cols: CSV header (all read as STRING), select: typed select list }
const TABLES = {
  service: { csv: "service.csv", select: `service_id, cast(service_date as date) service_date, start_time, name, slot, ${bool("livestreamed")} livestreamed` },
  attendance_event: { csv: "attendance_event.csv", select: `person_id, service_id, channel, checked_in_by, cast(checked_in_at as timestamp) checked_in_at, cast(minutes_watched as int) minutes_watched` },
  ministry: { csv: "ministry.csv", select: `ministry_id, name, area` },
  serving_assignment: { csv: "serving_assignment.csv", select: `person_id, ministry_id, role, schedule_slot, frequency, cast(start_on as date) start_on, cast(end_on as date) end_on` },
  person: { csv: "person.csv", select: `person_id, household_id, household_role, cast(birth_year as int) birth_year, cast(first_attended_on as date) first_attended_on, gender` },
  household: { csv: "household.csv", select: `household_id, zip, cast(lat_approx as double) lat_approx, cast(lng_approx as double) lng_approx` },
  member_profile: { csv: "member_profile.csv", select: `person_id, cast(opted_in_at as timestamp) opted_in_at, life_stage, ${arr("available_slots")} available_slots, cast(max_distance_mi as int) max_distance_mi, group_pref, profile_source, cast(confirmed_at as timestamp) confirmed_at` },
  group_membership: { csv: "group_membership.csv", select: `group_id, person_id, status, cast(joined_at as timestamp) joined_at, cast(left_at as timestamp) left_at` },
  grp: { csv: "grp.csv", select: `group_id, name, gender_focus, life_stage_focus, meeting_slot, frequency, cast(lat_approx as double) lat_approx, cast(lng_approx as double) lng_approx, ${bool("is_online")} is_online, cast(capacity_min as int) capacity_min, cast(capacity_max as int) capacity_max, ${bool("childcare")} childcare, status` },
  group_tag: { csv: "group_tag.csv", select: `group_id, tag` },
  group_leader: { csv: "group_leader.csv", select: `group_id, person_id, role, cast(start_on as date) start_on` },
};

const header = (rows) => Object.keys(rows[0]);
let bad = 0;
const report = [];
for (const [table, spec] of Object.entries(TABLES)) {
  const rows = readCsv(spec.csv);
  const cols = header(rows);
  upload(path.join(SEED, spec.csv), `${VOL}/${spec.csv}`);
  const schema = cols.map((c) => `${c} STRING`).join(", ");
  await sql(`create or replace table ${NS}.${table} as
    select ${spec.select} from read_files('${VOL}/${spec.csv}', format => 'csv', header => true, multiLine => true, escape => '"', schema => '${schema}')`);
  const n = Number((await query(`select count(*) n from ${NS}.${table}`))[0].n);
  const ok = n === rows.length;
  if (!ok) bad++;
  report.push({ table, csv_rows: rows.length, delta_rows: n, ok });
  console.log(`${ok ? "OK  " : "FAIL"} ${table.padEnd(18)} csv=${String(rows.length).padStart(6)}  delta=${String(n).padStart(6)}`);
}
if (bad) { console.error(`${bad} table(s) differ from the CSV row counts`); process.exit(1); }
console.log("All Delta row counts equal the seed CSVs.");
