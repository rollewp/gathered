// Gathered: Manager "Group demand gaps" HTTP smoke test against a RUNNING app.
//
//   1. npm run build && npx next start -p 3117
//   2. BASE_URL=http://localhost:3117 node --env-file=.env.local scripts/smoke_demand_gaps.mjs
//
//   default       reads whatever the Databricks refresh put in app.demand_gap (the real result)
//   FIXTURE=1     temporarily writes known rows with the owner connection to check rendering, then
//                 restores the real rows (use before the first refresh has run)
//   RECONCILE=1   also compares app.demand_gap with workspace.gathered.demand_gaps in Databricks
//                 (uses the SQL warehouse; one small query) and checks the page against it
//
// Plain HTTP with a persona cookie. Not a browser click-through. Makes no model call.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3117";
import { accessCookie } from "./lib/demo_access.mjs";
const AC = await accessCookie(BASE); // passes the demo access gate (needs DEMO_PASSWORD when the app enforces it)
const FIXTURE = process.env.FIXTURE === "1";
const RECONCILE = process.env.RECONCILE === "1";
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
await own.connect();
const q = async (sql, params) => (await own.query(sql, params)).rows;
const snapshot = await q("select * from app.demand_gap");
const COLS = ["life_stage", "available_slot", "opted_in_ungrouped_count", "serving_group_count", "available_seat_count", "people_per_open_seat", "people_without_group_in_catalog", "people_without_reachable_group", "gap_classification", "gap_rank", "as_of_date", "computed_at"];
const put = async (rows) => {
  await own.query("delete from app.demand_gap");
  for (const r of rows) await own.query(`insert into app.demand_gap (${COLS.join(",")}) values (${COLS.map((_, i) => `$${i + 1}`).join(",")})`, COLS.map((c) => r[c]));
};

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (h) => unesc(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: AC + (key ? `personaKey=${key}` : "") }, redirect: "manual" }); return { status: r.status, html: await r.text() }; };
const section = (t) => { const i = t.indexOf("Group demand gaps"); return i < 0 ? "" : t.slice(i); };

const mk = (stage, slot, n, groups, seats, reach, cls, rank) => ({
  life_stage: stage, available_slot: slot, opted_in_ungrouped_count: n, serving_group_count: groups, available_seat_count: seats,
  people_per_open_seat: seats ? Math.round((n / seats) * 100) / 100 : null, people_without_group_in_catalog: groups ? 0 : n,
  people_without_reachable_group: reach, gap_classification: cls, gap_rank: rank, as_of_date: "2026-11-01", computed_at: new Date().toISOString(),
});

try {
  if (FIXTURE) await put([
    mk("retired", "wed_am", 38, 1, 8, 34, "High demand", 1), mk("empty_nest", "thu_am", 34, 0, 0, 34, "No current group", 2),
    mk("young_kids", "tue_am", 27, 2, 10, 22, "Limited reach", 3), mk("retired", "thu_am", 31, 0, 0, 31, "No current group", 4),
    mk("empty_nest", "wed_am", 31, 0, 0, 31, "No current group", 5), mk("teens", "tue_am", 12, 1, 6, 9, "Limited reach", 6),
    mk("single", "wed_eve", 122, 8, 44, 0, "Served", null),
  ]);
  const rows = await q("select * from app.demand_gap order by gap_rank nulls last");
  const gaps = rows.filter((r) => r.gap_rank != null);

  console.log(`Access  (${FIXTURE ? "fixture rows" : "rows written by the refresh"}: ${rows.length}, gaps: ${gaps.length})`);
  let r = await get("manager", "/manager");
  const t = text(r.html), s = section(t);
  check("Alan sees the Group demand gaps section on the Manager page", r.status === 200 && s.length > 0, t.slice(0, 200));
  check("the section keeps the existing Insights requiring review and Run AI review controls", t.includes("Insights requiring review") && t.includes("Run AI review"));
  for (const k of ["member_dana", "member_marcus", "leader_tom", null]) {
    r = await get(k, "/manager");
    check(`${k ?? "no persona"}: the Manager page shows no demand analysis`, r.status === 200 && !text(r.html).includes("Group demand gaps") && !text(r.html).includes("opted-in"));
  }

  console.log("\nContent");
  if (rows.length === 0) {
    check("with no rows the section says the analysis has not been loaded", s.includes("has not been loaded yet"), s.slice(0, 300));
  } else {
    const shown = Math.min(5, gaps.length);
    check(`the top ${shown} gaps are listed, of ${gaps.length}`, s.includes(`Top ${shown} of ${gaps.length} gaps`), s.slice(0, 500));
    check("each cohort shows people without a group, open groups and open seats", ["People without a group", "Open groups", "Open seats"].every((x) => s.includes(x)));
    const top = gaps[0];
    check("the highest-ranked cohort appears with its exact counts and classification",
      s.includes(String(top.opted_in_ungrouped_count)) && s.includes(top.gap_classification), `${top.life_stage}/${top.available_slot} ${top.opted_in_ungrouped_count}`);
    check("the footer explains that a person free at several times is counted in each", s.includes("not additive"));
    const names = personas.flatMap((p) => [p.display, ...p.display.split(" ")]);
    const leaked = names.filter((n) => n.length > 3 && s.includes(n));
    check("the section names no person", leaked.length === 0, leaked.join(", "));
    check("the section shows no score, rationale, attendance or profile text", !/score|rationale|attendance|about me/i.test(s));
  }

  if (RECONCILE) {
    console.log("\nReconcile with Databricks");
    const { query } = await import("../databricks/dbx.mjs");
    const dbx = await query("select * from workspace.gathered.demand_gaps");
    const lake = await q("select * from app.demand_gap");
    const key = (x) => `${x.life_stage}|${x.available_slot}`;
    const lm = new Map(lake.map((x) => [key(x), x]));
    const F = ["opted_in_ungrouped_count", "serving_group_count", "available_seat_count", "people_without_group_in_catalog", "people_without_reachable_group"];
    let diffs = 0;
    for (const d of dbx) {
      const l = lm.get(key(d));
      if (!l) { diffs++; continue; }
      for (const f of F) if (Number(d[f]) !== Number(l[f])) diffs++;
      if (d.gap_classification !== l.gap_classification || String(d.gap_rank ?? "") !== String(l.gap_rank ?? "")) diffs++;
    }
    check(`Lakebase app.demand_gap equals the Databricks table (${dbx.length} cohorts, ${lake.length} in Lakebase, ${diffs} differences)`, dbx.length === lake.length && diffs === 0);
    const topD = dbx.filter((d) => d.gap_rank != null).sort((a, b) => Number(a.gap_rank) - Number(b.gap_rank))[0];
    if (topD) {
      const people = await query(`select count(*) n from workspace.gathered.member_profile m join workspace.gathered.person p on p.person_id = m.person_id and p.household_role = 'adult'
        join workspace.gathered.person_features f on f.person_id = m.person_id
        where m.life_stage = '${topD.life_stage}' and array_contains(m.available_slots, '${topD.available_slot}') and not array_contains(f.busy_slots, '${topD.available_slot}')
        and not exists (select 1 from workspace.gathered.group_membership g where g.person_id = m.person_id and g.status = 'active')`);
      check(`top cohort ${topD.life_stage}/${topD.available_slot}: an independent Databricks count of the people (${people[0].n}) equals the page's ${topD.opted_in_ungrouped_count}`, Number(people[0].n) === Number(topD.opted_in_ungrouped_count));
    }
  }
} finally {
  if (FIXTURE) await put(snapshot);
  const after = await q("select count(*)::int c from app.demand_gap");
  check("cleanup: the demand_gap rows are as they were before the smoke test", after[0].c === snapshot.length);
  await own.end();
}
console.log(failed ? `\n${failed} FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
