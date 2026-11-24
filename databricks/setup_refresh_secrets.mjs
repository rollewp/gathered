// Gathered: connect the gathered_refresh role to Databricks.
//
//   node --env-file=.env.local databricks/setup_refresh_secrets.mjs
//
// Prerequisites (one-time, by the project owner):
//   1. The role exists (created through the Lakebase roles API) and migration 0009 is applied.
//   2. Its password is set in the Lakebase console (Roles -> gathered_refresh -> set password) and
//      added to .env.local as  DATABASE_REFRESH_URL=postgresql://gathered_refresh:<password>@<host>:5432/databricks_postgres?sslmode=require
//
// This script verifies the credential really is the narrow role (it can write person_features and
// demand_gap, and cannot read people), then stores the connection parts in the Databricks secret
// scope "gathered" for the refresh job. Nothing secret is printed.
import { execFileSync } from "node:child_process";
import pg from "pg";
import { cliPath, PROFILE } from "./dbx.mjs";

const raw = process.env.DATABASE_REFRESH_URL;
if (!raw) { console.error("DATABASE_REFRESH_URL is not set in .env.local (see the header of this file)."); process.exit(1); }
const u = new URL(raw);
if (decodeURIComponent(u.username) !== "gathered_refresh") { console.error("DATABASE_REFRESH_URL must use the gathered_refresh role."); process.exit(1); }

const c = new pg.Client({ connectionString: raw, ssl: { rejectUnauthorized: false } });
await c.connect();
const me = (await c.query("select current_user u")).rows[0].u;
const can = async (sql) => { try { await c.query("begin"); await c.query(sql); await c.query("rollback"); return true; } catch { await c.query("rollback"); return false; } };
const checks = {
  "connects as gathered_refresh": me === "gathered_refresh",
  "can read person_features": await can("select 1 from app.person_features limit 1"),
  "can read demand_gap": await can("select 1 from app.demand_gap limit 1"),
  "cannot read app.person": !(await can("select 1 from app.person limit 1")),
  "cannot read member_profile": !(await can("select 1 from app.member_profile limit 1")),
  "cannot read audit_log": !(await can("select 1 from app.audit_log limit 1")),
  "cannot read recommendation_run": !(await can("select 1 from app.recommendation_run limit 1")),
};
await c.end();
let bad = 0;
for (const [k, v] of Object.entries(checks)) { console.log(`${v ? "PASS" : "FAIL"}  ${k}`); if (!v) bad++; }
if (bad) { console.error("The credential is not the narrow refresh role; secrets were NOT stored."); process.exit(1); }

const cli = (args, input) => execFileSync(cliPath(), [...args, "-p", PROFILE], { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
try { cli(["secrets", "create-scope", "gathered"]); } catch (e) { if (!/already exists/i.test(String(e.stderr ?? e.message))) throw e; }
const secrets = { pg_host: u.hostname, pg_port: u.port || "5432", pg_database: u.pathname.slice(1), pg_user: "gathered_refresh", pg_password: decodeURIComponent(u.password) };
for (const [k, v] of Object.entries(secrets)) cli(["secrets", "put-secret", "gathered", k], v);
console.log("Stored pg_host, pg_port, pg_database, pg_user, pg_password in Databricks secret scope 'gathered'.");
