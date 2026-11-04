// Gathered: migration runner. Applies migrations/*.sql in filename order, tracked in
// app._migrations so re-running is a no-op for anything already applied.
//
// Usage: node --env-file=.env.local scripts/migrate.mjs
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "migrations");

const ownerUrl = process.env.DATABASE_OWNER_URL;
if (!ownerUrl) {
  console.error("DATABASE_OWNER_URL is not set (expected in .env.local)");
  process.exit(1);
}

const files = fs.readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const client = new pg.Client({ connectionString: ownerUrl, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  await client.query("create schema if not exists app");
  await client.query(`
    create table if not exists app._migrations (
      version text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const { rows: appliedRows } = await client.query("select version from app._migrations");
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into app._migrations (version) values ($1)", [file]);
      await client.query("commit");
      console.log(`apply ${file}`);
    } catch (err) {
      await client.query("rollback");
      console.error(`FAILED ${file}: ${err.message}`);
      throw err;
    }
  }

  console.log("migrations up to date");
} finally {
  await client.end();
}
