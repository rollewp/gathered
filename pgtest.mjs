// Gathered Postgres spike: P2 external connect, P3 RLS, P4 cold start, P6 Databricks SQL API
// Usage (from a normal terminal on your PC, NOT inside Databricks):
//   npm install pg
//   node --env-file=.env.local pgtest.mjs pg   (reads DATABASE_URL; never hardcode it)
// Optional P6:
//   set DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
//   set DATABRICKS_TOKEN=<personal access token>
//   set DATABRICKS_WAREHOUSE_ID=<sql warehouse id>
//   node pgtest.mjs dbsql
import process from "node:process";
const mode = process.argv[2] || "pg";

if (mode === "pg") {
  const { default: pg } = await import("pg");
  const t0 = Date.now();
  if (!process.env.DATABASE_URL) { console.error("DATABASE_URL not set. Run: node --env-file=.env.local pgtest.mjs pg"); process.exit(1); }
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const connectMs = Date.now() - t0;
  console.log(`P2 connect from outside: PASS (${connectMs} ms)  P4 cold start ${connectMs < 5000 ? "PASS" : "FAIL"} (<5000 ms)`);
  const cases = [
    { label: "Leader 900 (G1)", role: "leader", id: "900", expect: 2 },
    { label: "Member 101",      role: "member", id: "101", expect: 1 },
    { label: "Manager",         role: "manager", id: "",   expect: 3 },
    { label: "No context",      role: "",        id: "",   expect: 0 },
  ];
  let ok = true;
  for (const k of cases) {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [k.role, k.id]);
    const r = await c.query("select note from spike.group_membership order by note");
    await c.query("commit");
    const pass = r.rowCount === k.expect; ok &&= pass;
    console.log(`P3 ${k.label}: ${r.rowCount} rows (expect ${k.expect}) ${pass ? "PASS" : "FAIL"}  ${r.rows.map(x => x.note).join(", ")}`);
  }
  const who = await c.query("select current_user, version()");
  console.log(`Connected as ${who.rows[0].current_user}; ${who.rows[0].version.split(",")[0]}`);
  if (who.rows[0].current_user !== "gathered_app") console.log("WARNING: not connected as gathered_app. Owners bypass RLS, so P3 results are not meaningful.");
  console.log(ok ? "RLS: ALL PASS" : "RLS: CHECK FAILURES ABOVE");
  await c.end();
}

if (mode === "dbsql") {
  const t0 = Date.now();
  const res = await fetch(`${process.env.DATABRICKS_HOST}/api/2.0/sql/statements`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ warehouse_id: process.env.DATABRICKS_WAREHOUSE_ID, statement: "select current_user() as u, now() as t", wait_timeout: "30s" }),
  });
  const j = await res.json();
  console.log(`P6 Databricks SQL API: HTTP ${res.status}, state ${j.status?.state}, ${Date.now() - t0} ms`);
  console.log(JSON.stringify(j.result?.data_array ?? j, null, 0).slice(0, 400));
}
