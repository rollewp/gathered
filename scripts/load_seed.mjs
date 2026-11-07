// Gathered: seed loader. Truncates the app schema's seeded tables and reloads them from
// seed/out/*.csv via COPY, in one transaction, so it's safe to re-run after
// seed/generate_seed.py regenerates the CSVs.
//
// Usage: node --env-file=.env.local scripts/load_seed.mjs
//
// Not loaded here (see migrations/0001_app_schema.sql "Not created / not loaded"):
//   - service.csv, ministry.csv, attendance_event.csv, serving_assignment.csv
//     (Databricks/Delta side per D1, loaded by a separate mechanism, not built yet)
//   - _truth_household.csv, _truth_person.csv (doc: never loaded into the app)
//   - eval_label.csv (offline LLM-ranking answer key, not an operational table)
//   - personas.json (consumed by the Next.js persona picker, not a DB table)
//   - app.person_features has no seed CSV at all; the nightly Databricks job populates it.
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import { from as copyFrom } from "pg-copy-streams";

const SEED_DIR = path.join(import.meta.dirname, "..", "seed", "out");

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error("DATABASE_OWNER_URL is not set (expected in .env.local)");
  process.exit(1);
}

// Parent-to-child load order. Column lists must equal each seed/out/<file> header, name for name
// and in order: COPY runs with HEADER MATCH (Postgres 15+), so a renamed or reordered CSV column
// fails the load instead of landing in the wrong table column.
const TABLES = [
  { table: "household", file: "household.csv",
    columns: ["household_id", "zip", "lat_approx", "lng_approx", "checkin_app_opt_in", "app_opt_in_at"] },
  { table: "person", file: "person.csv",
    columns: ["person_id", "household_id", "first_name", "last_name", "gender", "birth_year",
              "household_role", "first_attended_on", "is_synthetic"] },
  { table: "member_profile", file: "member_profile.csv",
    columns: ["person_id", "opted_in_at", "consent_version", "life_stage", "available_slots",
              "max_distance_mi", "group_pref", "interests", "about_me", "profile_source", "confirmed_at"] },
  { table: "portal_user", file: "portal_user.csv",
    columns: ["user_id", "person_id", "role", "email"] },
  { table: "grp", file: "grp.csv",
    columns: ["group_id", "name", "description", "gender_focus", "life_stage_focus", "meeting_slot",
              "frequency", "lat_approx", "lng_approx", "is_online", "capacity_min", "capacity_max",
              "childcare", "status"] },
  { table: "group_tag", file: "group_tag.csv", columns: ["group_id", "tag"] },
  { table: "group_leader", file: "group_leader.csv",
    columns: ["group_id", "person_id", "role", "start_on"] },
  { table: "group_membership", file: "group_membership.csv",
    columns: ["group_id", "person_id", "status", "joined_at", "left_at", "left_reason"] },
  { table: "group_meeting", file: "group_meeting.csv",
    columns: ["meeting_id", "group_id", "met_on"] },
  { table: "meeting_attendance", file: "meeting_attendance.csv",
    columns: ["meeting_id", "person_id", "present"] },
  { table: "recommendation", file: "recommendation.csv",
    columns: ["rec_id", "person_id", "group_id", "rank", "score", "score_breakdown",
              "internal_rationale", "model", "prompt_version", "generated_at"] },
  { table: "join_request", file: "join_request.csv",
    columns: ["request_id", "person_id", "group_id", "rec_id", "status", "member_note",
              "requested_at", "decided_at", "decided_by", "decline_reason"] },
  { table: "escalation", file: "escalation.csv",
    columns: ["escalation_id", "source", "kind", "severity", "group_id", "person_id", "summary",
              "evidence", "status", "created_at", "resolved_by"] },
  { table: "audit_log", file: "audit_log.csv",
    columns: ["id", "actor_user_id", "action", "entity", "entity_id", "detail", "at"] },
];

const client = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query("begin");

  // One statement so FK relationships among these tables (and person_features's FK to person)
  // don't block it. person_features has no seed CSV and isn't reloaded below; known tradeoff:
  // once the nightly job populates it, re-running this script will also clear it.
  const truncateList = [...TABLES.map((t) => `app.${t.table}`), "app.person_features"].join(", ");
  await client.query(`truncate ${truncateList} restart identity`);

  for (const { table, file, columns } of TABLES) {
    const csvPath = path.join(SEED_DIR, file);
    const copySql = `copy app.${table} (${columns.join(", ")}) from stdin with (format csv, header match)`;
    const stream = client.query(copyFrom(copySql));
    await pipeline(fs.createReadStream(csvPath), stream);
  }

  // audit_log.id is bigserial; keep its sequence consistent with whatever was just COPYed in
  // (currently nothing, since audit_log.csv is header-only, but safe either way).
  await client.query(`
    select setval(pg_get_serial_sequence('app.audit_log', 'id'), coalesce(max(id), 1), max(id) is not null)
    from app.audit_log
  `);

  await client.query("commit");
} catch (err) {
  await client.query("rollback");
  console.error("load failed, rolled back:", err.message);
  await client.end();
  process.exit(1);
}

console.log("loaded. row counts:");
for (const { table } of TABLES) {
  const { rows } = await client.query(`select count(*) from app.${table}`);
  console.log(`  ${table.padEnd(20)} ${rows[0].count}`);
}

await client.end();
