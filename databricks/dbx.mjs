// Gathered: thin Databricks helper. Runs SQL on the SQL warehouse and copies files to a UC volume
// through the Databricks CLI, using the profile from `databricks auth login`. No tokens in files.
//
//   DATABRICKS_PROFILE   CLI profile (default "gathered")
//   DATABRICKS_CLI       path to the CLI binary (default: `databricks` on PATH, else the winget install)
//   DATABRICKS_WAREHOUSE warehouse id (default: the first warehouse found)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PROFILE = process.env.DATABRICKS_PROFILE ?? "gathered";
export const CATALOG = process.env.DATABRICKS_CATALOG ?? "workspace";
export const SCHEMA = "gathered";
export const NS = `${CATALOG}.${SCHEMA}`;

function findCli() {
  if (process.env.DATABRICKS_CLI) return process.env.DATABRICKS_CLI;
  try { execFileSync("databricks", ["--version"], { stdio: "ignore" }); return "databricks"; } catch { /* fall through */ }
  const pk = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(pk)) {
    for (const d of fs.readdirSync(pk)) if (d.startsWith("Databricks.DatabricksCLI")) {
      const p = path.join(pk, d, "databricks.exe");
      if (fs.existsSync(p)) return p;
    }
  }
  throw new Error("Databricks CLI not found (set DATABRICKS_CLI)");
}
const CLI = findCli();
export const cliPath = () => CLI;
const cli = (args, opts = {}) => execFileSync(CLI, [...args, "-p", PROFILE], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts });

function api(method, route, body) {
  const args = ["api", method, route];
  let tmp;
  if (body) { tmp = path.join(os.tmpdir(), `dbx-${process.pid}-${Date.now()}.json`); fs.writeFileSync(tmp, JSON.stringify(body)); args.push("--json", `@${tmp}`); }
  try { return JSON.parse(cli(args)); } finally { if (tmp) fs.rmSync(tmp, { force: true }); }
}

let warehouseId = process.env.DATABRICKS_WAREHOUSE;
export function warehouse() {
  if (!warehouseId) {
    const list = api("get", "/api/2.0/sql/warehouses").warehouses ?? [];
    if (!list.length) throw new Error("no SQL warehouse found in this workspace");
    warehouseId = list[0].id;
  }
  return warehouseId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Runs one statement; returns { columns: [names], rows: [[...]] } with every value as a string or null. */
export async function sql(statement, { timeoutMs = 600_000 } = {}) {
  let res = api("post", "/api/2.0/sql/statements", { warehouse_id: warehouse(), statement, wait_timeout: "50s", on_wait_timeout: "CONTINUE", disposition: "INLINE", format: "JSON_ARRAY" });
  const t0 = Date.now();
  while (["PENDING", "RUNNING"].includes(res.status?.state)) {
    if (Date.now() - t0 > timeoutMs) throw new Error("statement timed out: " + statement.slice(0, 80));
    await sleep(2000);
    res = api("get", `/api/2.0/sql/statements/${res.statement_id}`);
  }
  if (res.status?.state !== "SUCCEEDED") throw new Error(`SQL ${res.status?.state}: ${res.status?.error?.message ?? ""}\n--- ${statement.slice(0, 200)}`);
  const columns = (res.manifest?.schema?.columns ?? []).map((c) => c.name);
  const rows = [...(res.result?.data_array ?? [])];
  let next = res.result?.next_chunk_index;
  while (next != null) {
    const chunk = api("get", `/api/2.0/sql/statements/${res.statement_id}/result/chunks/${next}`);
    rows.push(...(chunk.data_array ?? []));
    next = chunk.next_chunk_index;
  }
  return { columns, rows };
}

/** Rows as objects (string values). */
export async function query(statement, opts) {
  const { columns, rows } = await sql(statement, opts);
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

/** Copies a local file to a UC volume path (dbfs:/Volumes/...). */
export function upload(localFile, volumePath) {
  cli(["fs", "cp", localFile, `dbfs:${volumePath}`, "--overwrite"]);
}
