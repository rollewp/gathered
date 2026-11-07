// Gathered: LOCAL BOOTSTRAP producer of app.person_features.
//
// Development and recovery tool only. In the deployed architecture the nightly Databricks job
// computes person_features from the engagement tables and writes them into Lakebase
// (architecture §3b); this script implements the same output contract from the synthetic seed
// files so Slice 1 can run before that job exists. The formulas live in
// lib/features/person-features.mjs. Databricks must reach schema and value parity with them
// before cutover.
//
// Usage: node --env-file=.env.local scripts/compute_person_features.mjs [--dry-run]
//
// Deterministic upsert: a row is written only if some feature value differs, so rerunning on
// unchanged source data inserts and updates nothing (and so invalidates no recommendation run).
// Uses the owner URL, like load_seed.mjs. Prints counts only.
import pg from "pg";
import { readCsv } from "../lib/seed/csv.mjs";
import { computePersonFeatures, FEATURE_COLUMNS } from "../lib/features/person-features.mjs";

const dryRun = process.argv.includes("--dry-run");
const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) { console.error("DATABASE_OWNER_URL is not set (expected in .env.local)"); process.exit(1); }

const { asOf, rows } = computePersonFeatures({
  people: readCsv("person.csv"),
  servingAssignments: readCsv("serving_assignment.csv"),
  ministries: readCsv("ministry.csv"),
  services: readCsv("service.csv"),
  attendance: readCsv("attendance_event.csv"),
});

const client = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

const ARRAYS = new Set(["signal_sources", "busy_slots", "serving_areas", "kids_age_bands"]);
const cols = FEATURE_COLUMNS;
const nonKey = cols.filter((c) => c !== "person_id");
const placeholders = cols.map((c, i) => (ARRAYS.has(c) ? `$${i + 1}::text[]` : `$${i + 1}`)).join(", ");
const changed = nonKey.map((c) => `app.person_features.${c} is distinct from excluded.${c}`).join(" or ");
const upsert = `
  insert into app.person_features (${cols.join(", ")}, computed_at)
  values (${placeholders}, now())
  on conflict (person_id) do update set
    ${nonKey.map((c) => `${c} = excluded.${c}`).join(", ")}, computed_at = excluded.computed_at
  where ${changed}
  returning (xmax = 0) as inserted`;

let inserted = 0, updated = 0, unchanged = 0;
try {
  await client.query("begin");
  for (const row of rows.values()) {
    const res = await client.query(upsert, cols.map((c) => row[c]));
    if (res.rowCount === 0) unchanged++;
    else if (res.rows[0].inserted) inserted++;
    else updated++;
  }
  await client.query(dryRun ? "rollback" : "commit");
} catch (err) {
  await client.query("rollback");
  console.error("compute_person_features failed, rolled back:", err.message);
  await client.end();
  process.exit(1);
}
await client.end();

console.log(`person_features (as of ${asOf}${dryRun ? ", DRY RUN, rolled back" : ""}): ` +
  `${rows.size} adults  inserted=${inserted}  updated=${updated}  unchanged=${unchanged}`);
