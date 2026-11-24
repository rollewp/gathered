// Gathered: deploy the refresh notebook and its job to Databricks, optionally run it.
//
//   node databricks/deploy.mjs          upload the notebook (SQL embedded) and create/update the job
//   node databricks/deploy.mjs --run    ... then run it once and print the returned summary
//
// The job is "gathered-nightly-refresh": a serverless notebook task, scheduled 02:00 America/New_York
// but created PAUSED (a Free Edition budget is limited; unpause it from the Jobs page, or just run it
// on demand). Credentials come from the Databricks secret scope "gathered"
// (databricks/setup_refresh_secrets.mjs); nothing secret is in this repo.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cliPath, PROFILE, query } from "./dbx.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = process.argv.includes("--run");
const me = (await query("select current_user() u"))[0].u;
const DIR = `/Users/${me}/gathered`;
const NOTEBOOK = `${DIR}/refresh_lakebase`;
const JOB = "gathered-nightly-refresh";

// MSYS_NO_PATHCONV keeps Git Bash from rewriting /Users/... workspace paths.
const cli = (args, opts = {}) => execFileSync(cliPath(), [...args, "-p", PROFILE], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" }, maxBuffer: 64 * 1024 * 1024, ...opts });
const pyString = (file) => JSON.stringify(fs.readFileSync(path.join(HERE, "sql", file), "utf8"));
const source = fs.readFileSync(path.join(HERE, "jobs", "refresh_lakebase.py"), "utf8")
  .replace("__PERSON_FEATURES_SQL__", () => pyString("person_features.sql"))
  .replace("__DEMAND_GAPS_SQL__", () => pyString("demand_gaps.sql"));
const tmp = path.join(os.tmpdir(), "refresh_lakebase.py");
fs.writeFileSync(tmp, source);
cli(["workspace", "mkdirs", DIR]);
cli(["workspace", "import", NOTEBOOK, "--file", tmp, "--language", "PYTHON", "--format", "SOURCE", "--overwrite"]);
console.log(`notebook uploaded: ${NOTEBOOK}`);

const settings = {
  name: JOB,
  tasks: [{ task_key: "refresh", notebook_task: { notebook_path: NOTEBOOK }, environment_key: "pg" }],
  environments: [{ environment_key: "pg", spec: { environment_version: "3", dependencies: ["pg8000"] } }],
  schedule: { quartz_cron_expression: "0 0 2 * * ?", timezone_id: "America/New_York", pause_status: "PAUSED" },
  max_concurrent_runs: 1,
};
const jobs = JSON.parse(cli(["jobs", "list", "-o", "json"]) || "[]");
const existing = (Array.isArray(jobs) ? jobs : jobs.jobs ?? []).find((j) => j.settings?.name === JOB);
const jsonFile = path.join(os.tmpdir(), "job.json");
let jobId;
if (existing) {
  jobId = existing.job_id;
  fs.writeFileSync(jsonFile, JSON.stringify({ job_id: jobId, new_settings: settings }));
  cli(["jobs", "reset", "--json", `@${jsonFile}`]);
  console.log(`job updated: ${JOB} (${jobId})`);
} else {
  fs.writeFileSync(jsonFile, JSON.stringify(settings));
  jobId = JSON.parse(cli(["jobs", "create", "--json", `@${jsonFile}`, "-o", "json"])).job_id;
  console.log(`job created: ${JOB} (${jobId}), schedule PAUSED`);
}

if (run) {
  const out = JSON.parse(cli(["jobs", "run-now", String(jobId), "--timeout", "20m", "-o", "json"]));
  const state = out.state ?? {};
  console.log("run state:", state.result_state ?? JSON.stringify(state));
  const taskRun = out.tasks?.[0]?.run_id ?? out.run_id;
  const res = JSON.parse(cli(["jobs", "get-run-output", String(taskRun), "-o", "json"]));
  if (res.error) { console.error("run error:", res.error, (res.error_trace ?? "").slice(0, 1500)); process.exit(1); }
  console.log("SUMMARY " + res.notebook_output?.result);
}
