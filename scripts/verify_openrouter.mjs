// Gathered: LIVE OpenRouter verification of the ranking wiring. Explicitly invoked only; never part
// of `npm test` or `npm run build`.
//
//   npm run verify:openrouter
//
// Makes the minimum calls needed to prove the wiring: ONE eligible request (Dana) through the
// real application path (shortlist -> OpenRouter -> validation -> persist) and ONE immediate
// revisit, which must reuse the stored run with zero model calls. Reports call count, model,
// prompt version, latency and outcome. Never prints prompts, about_me or secrets.
// Cleans up its own run and audit rows afterwards.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { getRecommendations } from "../lib/recommendations.ts";

for (const k of ["DATABASE_URL", "DATABASE_OWNER_URL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL_FAST"]) {
  if (!process.env[k]) { console.error(`${k} is not set (expected in .env.local)`); process.exit(1); }
}
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const dana = personas.find((p) => p.key === "member_dana");
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl: { rejectUnauthorized: false } });
await own.connect();
const q = async (sql, params) => (await own.query(sql, params)).rows;
const startId = Number((await q("select coalesce(max(id), 0) m from app.audit_log"))[0].m);
const deleteRuns = async () => { for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t} where ${t === "recommendation_run_candidate" ? "run_id in (select run_id from app.recommendation_run where person_id = $1)" : t === "recommendation" ? "person_id = $1" : "person_id = $1"}`, [dana.person_id]); };
await deleteRuns();

let exitCode = 0;
try {
  const t0 = Date.now();
  const first = await getRecommendations("member_dana");
  const firstMs = Date.now() - t0;
  const second = await getRecommendations("member_dana");
  const rows = await q("select detail from app.audit_log where action = 'llm_rank_attempt' and id > $1 order by id", [startId]);
  const run = (await q("select outcome, model, prompt_version, confidence, llm_usage from app.recommendation_run where run_id = $1", [first.runId]))[0];
  const nameOf = Object.fromEntries((await q("select group_id, name from app.grp")).map((g) => [g.group_id, g.name]));

  console.log("Live OpenRouter verification");
  console.log(`  OpenRouter calls (audit_log attempts): ${rows.length}`);
  rows.forEach((r) => console.log(`    attempt ${r.detail.attempt}: ${r.detail.outcome}  model=${r.detail.model}  prompt=${r.detail.prompt_version}  latency=${r.detail.latency_ms} ms  tokens=${r.detail.total_tokens}`));
  console.log(`  first request:  source=${first.source}  run outcome=${run.outcome}  model=${run.model}  prompt=${run.prompt_version}  confidence=${run.confidence}  wall=${firstMs} ms`);
  console.log(`  ranked groups:  ${first.groups.map((g) => `${g.rank}. ${nameOf[g.group_id]}`).join(" | ")}`);
  console.log(`  second request: source=${second.source}  model attempts=${second.llmAttempts}`);
  const ok = first.source === "generated" && first.groups.length === 3 && second.source === "reused" && second.llmAttempts === 0 && rows.length === first.llmAttempts;
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  if (!ok) exitCode = 1;
} catch (e) {
  console.error("RESULT: FAIL:", e.message);
  exitCode = 1;
} finally {
  await deleteRuns();
  await own.query("delete from app.audit_log where id > $1", [startId]);
  await own.end();
}
process.exit(exitCode);
