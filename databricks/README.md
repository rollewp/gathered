# Gathered on Databricks

Analytics for the Winter Garden synthetic congregation. Databricks holds the engagement history,
derives `person_features` and runs the population demand-gap analysis; Lakebase stays the operational
store (architecture D1). No tokens are in the repo: everything authenticates with the CLI profile from
`databricks auth login` (profile `gathered`).

## Workspace discovery (2026-11-23, Free Edition)

| Item | Found |
|---|---|
| Catalogs | `system`, `samples`, `workspace` (managed, writable; the default catalog) |
| Namespace used | `workspace.gathered` (schema created here; no new top-level catalog) |
| SQL warehouse | `Serverless Starter Warehouse` (2X-Small, starts on demand) |
| Clusters | none; serverless notebook jobs run (tested) |
| Jobs | can be created and run |
| Lakebase reachability | a serverless job reaches the Lakebase host on port 5432; `psycopg2` is preinstalled |
| Ingest path | CSVs uploaded to a Unity Catalog volume (`/Volumes/workspace/gathered/seed`), read with `read_files` |

## Resources

Created by this work: schema `workspace.gathered`; volume `workspace.gathered.seed`; Delta tables
`service`, `attendance_event`, `ministry`, `serving_assignment`, `person`, `household`, `member_profile`,
`group_membership`, `grp`, `group_tag`, `group_leader` (source), `person_features`, `demand_gaps`
(results); notebook `/Users/<you>/gathered/refresh_lakebase`; job `gathered-nightly-refresh` (02:00
America/New_York, created **paused**); secret scope `gathered`; Lakebase role `gathered_refresh`
(migration 0009).
Reused: catalog `workspace`, the starter warehouse, serverless job compute, the Lakebase project.

Names, gender and free text (`about_me`, group descriptions) are not copied except `person.gender`,
which the gender-focus hard filter needs.

## Commands

| Command | What it does |
|---|---|
| `npm run dbx:ingest` | reload the seed CSVs into Delta (idempotent) and check row counts against the files |
| `npm run dbx:features` | build `person_features` in Databricks and run the parity gate (writes `PARITY_REPORT.md`) |
| `npm run dbx:demand` | build `demand_gaps` and reconcile it with the independent JavaScript reference |
| `npm run dbx:verify` | all three, in order |
| `npm run dbx:deploy` | upload the refresh notebook (SQL embedded from `databricks/sql`) and create/update the job |
| `npm run dbx:refresh` | deploy, then run the job once and print the insert/update/unchanged counts |

The SQL warehouse and job use the free budget; run them deliberately.

## Pipeline

```
seed/out CSVs -> UC volume -> Delta source tables -> person_features, demand_gaps (Spark SQL)
                                                          |  (job, as gathered_refresh)
                                                          v
                          Lakebase app.person_features (upsert only on change)
                          Lakebase app.demand_gap      (aggregates only)
```

- `sql/person_features.sql` is a direct translation of `lib/features/person-features.mjs`, the reference
  contract; it adds no definitions. Parity is a hard gate (`PARITY_REPORT.md`).
- `sql/demand_gaps.sql` is the population analysis (below).
- The job writes with the narrow role `gathered_refresh`: select/insert/update on `app.person_features`
  and select/insert/update/delete on `app.demand_gap`, nothing else, no BYPASSRLS. A row is written
  only when a feature value differs, so an unchanged refresh updates nothing and (through the existing
  triggers) invalidates no recommendation run.

## Demand-gap definition

Question: among opted-in adults without an active group, where are people concentrated in
life-stage / availability combinations the current catalog serves poorly?

- **Population:** adults with a profile (opt-in) and a life stage, with no `group_membership` of status `active`.
- **Demand cohort:** (life stage, slot). A person counts in a slot they listed as available and are not
  rostered to serve in (`busy_slots`). A person free at several times appears in several cohorts, so rows
  are not additive (932 people, 1,982 person-slots, 43 cohorts in the V2 seed).
- **Supply (catalog rules):** groups `open` or `forming` with at least one open seat (`capacity_max` minus
  active members) that meet in the slot and whose declared life-stage focus is empty or equal to the cohort's.
- **Reach (full hard filters):** per person, gender focus and, for in-person groups, within 5 miles of the
  group's location. Reported next to the catalog counts, so the effect of geography is visible:
  `people_without_group_in_catalog` (no distance, no gender) and `people_without_reachable_group`.
- **Classification, in order:** fewer than **5** people: *Not a gap*; no compatible open group:
  *No current group*; people per open seat at least **4**: *High demand*; at least 5 people and at least
  half with no reachable group: *Limited reach*; otherwise *Served*.
- **Why 5 and 4:** in the V2 seed the 32 served cohorts run from 0.21 to 3.55 people per seat and the
  three high-demand cohorts from 4.30 to 5.00, so 4 separates them with a visible margin; 5 is a deliberately
  small floor so a handful of people is not reported as a trend (the seed's smallest group minimum is 3,
  so 5 people is enough to start one with a little margin). The thresholds are
  constants in `lib/analytics/demand-gaps-reference.mjs` and `demand.mjs`, not tuned to a target.
- **Caveat:** availability is not intent. People per seat measures pressure, not a count of people who
  will join. No scores and no model are used anywhere in this analysis.
- **Order shown:** gap cohorts ranked by people without a reachable group, then cohort size.

## One-time setup of the refresh credential

1. Role `gathered_refresh` exists (created through the Lakebase roles API) and migration 0009 grants it
   its narrow privileges. Lakebase does not let the API or another role set a native password, so:
2. In the Lakebase console (project `gathered-demo`, branch `production`, Roles), set a password for
   `gathered_refresh`, and add this line to `.env.local` (git-ignored):
   `DATABASE_REFRESH_URL=postgresql://gathered_refresh:<password>@<same host as DATABASE_URL>:5432/databricks_postgres?sslmode=require`
3. `node --env-file=.env.local databricks/setup_refresh_secrets.mjs` checks the credential really is the
   narrow role (it can write the two tables and cannot read people, profiles, runs or the audit log) and
   only then stores it in the Databricks secret scope `gathered` for the job.
