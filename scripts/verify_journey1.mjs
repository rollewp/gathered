// Gathered: LIVE check of Journey 1's expected outcomes (docs/Gathered - Demo Journeys.md):
//   Dana's top pick is First Steps; Marcus sees Tuesday Night Dads first with Sunday Lunch among the three.
// Explicitly invoked only (makes real OpenRouter calls: one per member, plus a revisit that must make none).
//
//   npm run verify:journey1
//
// Prints group names, outcome and call counts. Never prints prompts, about_me or secrets.
// Removes its own runs and audit rows afterwards.
import pg from "pg";
import { getRecommendations } from "../lib/recommendations.ts";

for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_FAST"]) {
  if (!process.env[k]) { console.error(`${k} is not set (expected in .env.local)`); process.exit(1); }
}
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl: { rejectUnauthorized: false } });
await own.connect();
const startId = Number((await own.query("select coalesce(max(id), 0) m from app.audit_log")).rows[0].m);
const clean = async () => {
  await own.query("update app.join_request set rec_id = null where rec_id is not null"); // kept (withdrawn/declined) requests reference recommendations
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startId]);
};
await clean();

let ok = true;
try {
  for (const [key, expectFirst, expectAmong] of [["member_dana", "First Steps", null], ["member_marcus", "Tuesday Night Dads", "Sunday Lunch"]]) {
    const first = await getRecommendations(key);
    const again = await getRecommendations(key);
    const names = first.groups.map((g) => g.name);
    const calls = (await own.query("select count(*)::int c from app.audit_log where action = 'llm_rank_attempt' and id > $1 and detail->>'outcome' is not null", [startId])).rows[0].c;
    const pass = names[0]?.includes(expectFirst) && (!expectAmong || names.some((n) => n.includes(expectAmong))) && again.source === "reused" && again.llmAttempts === 0;
    if (!pass) ok = false;
    console.log(`${key}: ${names.map((n, i) => `${i + 1}. ${n}`).join(" | ")}`);
    console.log(`  first=${first.source} (model attempts ${first.llmAttempts})  revisit=${again.source} (attempts ${again.llmAttempts})  ${pass ? "PASS" : "FAIL"}`);
  }
  const rows = (await own.query("select detail from app.audit_log where action = 'llm_rank_attempt' and id > $1 order by id", [startId])).rows;
  console.log(`OpenRouter attempts in total: ${rows.length}  models: ${[...new Set(rows.map((r) => r.detail.model))].join(", ")}  prompt: ${[...new Set(rows.map((r) => r.detail.prompt_version))].join(", ")}`);
} catch (e) {
  ok = false; console.error("FAIL:", e.message);
} finally {
  await clean(); await own.end();
}
console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
process.exit(ok ? 0 : 1);
