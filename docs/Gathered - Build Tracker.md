# Gathered: Build Tracker
**Implementation status, sequencing, dependencies and cut decisions · last updated 2026-11-10**

This is the only document that tracks what is built, what is current, what is next and what is cut. It carries no product behavior and no architecture.

- Product behavior, screens and demo scenarios: `Gathered - Demo Journeys.md`
- Architecture, schema, security and decisions: `Gathered - Data Model & Architecture.md`
- Submission requirements and safeguards: `AI for Church Hackathon - Submission Deliverables.md`

**Dates:** build window Oct 30 – Nov 27, 2026. **Submit by Tue Nov 24**; hard deadline Nov 27, 11:59 PM ET.

**Implementation order is not demo order.** Journey numbers are stable product scenarios. The order below is the order work is done; the order the video shows them is *Video Run Order* in Demo Journeys. If behind, cut from *Optional / Cut*.

**Work item fields:** `Status` · `Depends on` · `Acceptance` · `Notes` · `Validate` · `Commit` (only when one exists; none are recorded otherwise).
**Status values:** Not started · In progress · Blocked · Complete.

---

## Current

### Slice 0: Application & Data Connection — Complete

**Goal:** Prove every layer of the application stack works together locally before building user-facing journeys.

**Status:** Complete.

**Implemented and validated:**
- Next.js application runs locally.
- Persona selection exercises the application-to-database path.
- `withPersona` establishes the correct persona-scoped database context.
- The application connects successfully to Lakebase PostgreSQL through `DATABASE_URL`.
- Row-level security and persona permissions operate through the application connection.
- Lakebase scale-to-zero is configured for 5 minutes. Cold and resumed connections have occurred throughout development with no observed performance issue.
- `npm run build` succeeds.
- Slice 0 implementation is committed.

**Acceptance criteria:** Complete when the local application successfully exercises the full path from UI → application/server action → `withPersona` → Lakebase PostgreSQL and returns successfully under the expected persona permissions.

### Slice 0a: Vercel Deployment Validation

- When Vercel deployment access is restored, deploy the existing application and verify the same application → `withPersona` → Lakebase path from the deployed environment.

---

## Next
Implementation order. The synthetic data expansion gates re-testing of the finished journeys. Items 1–2 build the remaining product screens on the finished recommendation lifecycle and Journey 1; the Databricks item is independent and can run alongside them.

### Synthetic data expansion (in progress)
Specification: `Gathered - Synthetic Data Design.md`. The work is staged so the development database is untouched until the generated world has been reviewed.

- **Increment 1: generator refactor and offline validation — done (2026-11-10), awaiting review.** Not committed.
  - **Delivered:** `seed/generate_seed.py` v1.0 rebuilt around configuration, household and member archetypes, group-family templates, campus and geography, engagement patterns, named-persona overlays and evaluation overlays (RNG 516, deterministic). New `scripts/seed_validate.mjs` (identity, referential integrity, loader compatibility, schema, rules, determinism, distributions, persona and evaluation analysis through the real reference implementations), `seed/stable_ids.json` (recorded invariants) and the generated `seed/SYNTHETIC_DATA_REPORT.md`.
  - **Result:** 2,598 households, 4,559 adults, 1,743 children, 140 groups, 1,039 active memberships, 1,571 profiles, 52 weeks of history, 29 evaluation scenarios. Every approved target passed; 191 of 191 checks passed; two regenerations are byte-identical. Dana: 24 broadly eligible groups, 11 pass every hard filter; Priya and her cohort stay at zero on purpose.
  - **Known gaps, reported in the data report:** Dana's #1–#2 deterministic gap is about 2 points (the scoring has few continuous factors; no tuning was done); no campus column in the schema; Dana's stated group preference changed from "women" to "mixed".
  - **Validate:** `npm run seed:generate`; `npm run seed:check` (generates twice, compares, validates, rewrites the report); `npm run seed:validate` for a quick pass. Python 3 and Node 20 or newer. None of these touch a database or call a model.
- **Increment 1b (Synthetic Data V2): semantic differentiation, label model, evaluation tooling — done (2026-11-10), awaiting review.** Not committed. Database impact: **none**. OpenRouter calls: **zero**.
  - **Delivered:** generator v2.0 (structure, counts and engagement byte-identical to v1.0; only text and labels changed): every template group description now states who it assumes it is talking to (new `DEPTH_TEXT`), sentences appended to 11 named groups, Dana's narrative says she feels a little behind (preference stays `mixed`). 11 ranking scenarios (including Dana) are selected for semantic differentiation, each with an expected group, at least two credible shortlisted alternatives, distinct text and a written contrast (`semantic_contrast`, `contrast_group_ids` in `eval_label.csv`).
  - **Label model:** `outcome_type` is a controlled vocabulary (`ranking`, `empty`, `excluded`, `duplicate_pending`, `active_member`) with one execution behavior each; `expectation` (`top1`, `top1_or_alternates`, `top3`) sets how strictly a ranking scenario is judged. Shared parsing and validation in `lib/seed/eval-labels.mjs`. Five added labels (e13, e18, e19, e22, e23) were corrected from `top1_or_alternates` to `top1`; the 14 original labels are unchanged.
  - **Tooling ready for the load, not run against a database:** `scripts/test_recommendations.mjs` reads the label set from the file (no fixed count), accounts for the 14 originals by identity and checks policy labels; `scripts/rank_eval.mjs` sends only `ranking` scenarios to the model, reports Shortlist Recall@6, LLM Top-1, Top-3, stability and fallback count and rate separately, and skips policy scenarios with a count and reason. New offline `npm run test:eval` (14 tests, no database or model) covers the label model and the metric arithmetic.
  - **Evidence (offline):** `npm run seed:check` 209 of 209 checks, two regenerations byte-identical and equal to `seed/out`; Shortlist Recall@6 is 100% on the ranking scenarios; excluded groups are absent in every exclusion scenario; `tsc --noEmit` clean and `npm run build` succeeded. Dana: 24 broadly eligible, 11 hard-filter survivors, shortlist First Steps 56.1, Thursday Twenties 53.8, Online Thursday Study 52.5, Thursday Women in the Word 51.5, New Group: Thursday Families 48.6, Deep Roots 46.0 (close scores are acceptable; nothing was tuned).
  - **Commands run:** `python seed/generate_seed.py`; `npm run seed:check`; `npm run test:eval`; `npx tsc --noEmit`; `npm run build`; `node --check` on the edited scripts. Report: `seed/SYNTHETIC_DATA_REPORT.md` (V2).
  - **Unresolved:** the Journey 3 leader-persona gap (First Steps and Sunday Lunch D-Group leaders are not personas) is still open and needs your decision; the model's final order for Dana has not been observed.
- **Increment 2: V2 reset and load, verification — done (2026-11-11). Live ranking evaluation and Journey 1 validation still pending.** Not committed. OpenRouter calls: **zero**.
  - **Reset/load:** `npm run seed:reset` (single-transaction truncate and COPY of the app data tables, schema/roles/RLS/grants untouched; structural hashes identical before and after, migrations 0001–0006 intact). Database counts equal the CSVs: 2,598 households, 6,302 people (4,559 adults, 1,743 children), 1,571 profiles, 140 groups, 140 leaders, 1,039 active and 59 left memberships, 5,066 meetings, 30,943 attendance rows, 88 join requests (4 pending), 9 portal users. Services, attendance events and serving assignments are Databricks-side and not loaded (verified in the CSVs only). 65 stable identities verified in the database.
  - **person_features:** first run inserted 4,559 of 4,559 adults; immediate rerun inserted 0, updated 0, unchanged 4,559 (so no recommendation invalidation). The local producer takes about 3m40s (one round trip per adult).
  - **Parity:** database `recommendation_shortlist()` equals the reference for all 25 ranking scenarios plus the empty and excluded scenarios (identical ids and order; max score/breakdown difference 5e-5). Shortlist Recall@6 is 25 of 25; no excluded group appears. Dana: 24 broadly eligible, 11 survivors, shortlist First Steps 56.1, Thursday Twenties 53.8, Online Thursday Study 52.5, Thursday Women in the Word 51.5, New Group: Thursday Families 48.6, Deep Roots 46.0 (identical to the offline baseline).
  - **Tests:** `npm test` passed: 14 offline label/metric tests, 45 lifecycle, RLS and concurrency tests, 19 Journey 1 tests (1m40s). `npx tsc --noEmit` clean; `npm run build` succeeded. The suite leaves the database clean (0 runs, 0 audit rows).
  - **Remaining:** live ranking evaluation with `scripts/rank_eval.mjs` (real OpenRouter calls, explicit approval), the Journey 1 live check, and the leader-persona decision. The overall synthetic-data expansion is not complete until those finish.

### 1. Journey 3: A leader accepts, and the group changes
- **Status:** Not started.
- **Depends on:** Journey 1 (Completed: requests exist); Slice 1 invalidation (Completed).
- **Scope:** leader home (my group, recent joiners, requests waiting with name and the requester's own note only), Accept/Decline, the single transaction (`join_request` update + `group_membership` insert + `audit_log`).
- **Acceptance:** after Chris accepts Sam, Sam appears under recent joiners and the count goes 0/8 → 1/8; Jordan's current result is out of date and his next visit generates a new one in which New Men's D-Group scores higher; the leader sees no profile, attendance or rationale.
- **Notes:** the invalidation mechanism already exists and is tested for the leader-accept path at the database level; this item adds the screens and the real accept transaction.
- **Validate:** `npm run build`; `npm run test:recommendations`; manual run as Chris and Jordan.

### 2. Journey 2: New attender intake
- **Status:** Not started.
- **Depends on:** Journey 1 (Completed: member home screen).
- **Scope:** intake textarea, LLM-proposed chips, confirmation, `insert member_profile` (`llm_confirmed`), zod-validated allowed values; then the member home generates Jordan's first recommendations.
- **Acceptance:** nothing is saved without confirmation; `about_me` is saved verbatim; Jordan's three groups are the forming New Men's D-Group, Tuesday Night Dads and Men's Accountability (order to be verified).
- **Notes:** uses the Haiku model through the same server-side OpenRouter path; each call is audited.
- **Validate:** `npm run build`; a manual run as Jordan using `demo_intake_text` from `personas.json`.

### Databricks `person_features` (independent track)
- **Status:** Not started. Tracked as work still to do; the local bootstrap producer covers development until this lands.
- **Depends on:** nothing in the journeys. Not a prerequisite for any journey. A Databricks workspace that stays available through judging (Dec 1).
- **Steps:**
  1. Create the Databricks job that reads the engagement tables (attendance events, serving assignments, services, ministries) and writes `person_features` into Lakebase, using the existing output contract (architecture §3b) and the owner-role write path.
  2. Compare its output to the local bootstrap producer for the synthetic dataset.
  3. Require schema and value parity: the same columns and types, and identical values for every adult, including the attendance-derived columns whose definitions are in the header of `lib/features/person-features.mjs`. Resolve any definition difference in the architecture (§3b) first, then in whichever side is wrong.
  4. Switch the deployed/demo feature refresh path to Databricks. The writer is idempotent and the invalidation triggers fire only on changed values, so a parity run on unchanged data invalidates no recommendation run.
  5. Keep the local script for deterministic development and recovery. Do not present it as the deployed analytical architecture.
- **Acceptance:** column and value parity on the synthetic dataset; a rerun on unchanged data reports zero changed rows; the deployed refresh path uses Databricks.
- **Validate:** compare the two outputs row by row; `npm run test:recommendations` after the switch; `npm run seed:reset` returns to the local bootstrap state.

---

## Later

### Journey 4: Manager oversight and escalations (rule items + AI hidden schedule conflict)
- **Status:** Not started.
- **Depends on:** Journey 1 (Completed: Marcus's request to Sunday Lunch can be made); Journey 3 (Tom's waiting requests).
- **Scope:** dashboard tiles, groups table with 12-week meeting attendance, escalations list with "Run review", rule items (First Steps and Young Couples below the minimum, Tom's 9-day-old request), the AI schedule-conflict review (Sonnet), escalation detail with Acknowledge and Resolve, duplicate suppression.
- **Acceptance:** see Demo Journeys, Journey 4.
- **Validate:** `npm run build`; a manual run as Alan.

### Journey 5: Audit and the two-role proof
- **Status:** Not started.
- **Depends on:** Journey 3 (Jordan's before and after); the Manager audit function (Completed in Slice 1).
- **Scope:** recommendation audit screen for a member (all runs including out-of-date ones, score breakdown, rank, confidence, rationale, model and prompt version, before/after compare); the Tom-versus-Alan group page with the "Not available for your role" panel.
- **Acceptance:** see Demo Journeys, Journey 5. Both views screenshotted for the write-up.
- **Validate:** `npm run build`; `npm run test:recommendations`; manual run as Tom and Alan.

### Pre-submission checks
- **Status:** Not started.
- **Items:**
  - Deployed verification of the finished app signed out; keep it warm through judging (Nov 28–30) and the Dec 1 showcase.
  - Add 6–10 harder evaluation labels, written by someone other than the author, before quoting the match-quality number publicly (the current 14 labels are a designed set; architecture §10.2).
  - Reconcile `AI for Church Hackathon - Submission Deliverables.md` and `AI for Church Hackathon - Application.md` with the built system. Both still describe an earlier plan (deterministic matching with the LLM only writing explanations, a different data platform and surface, giving data "masked") that W1, W3 and W9 supersede.
  - Screenshots and the demo video, per the Submission Deliverables checklist.
- **Validate:** the Submission Deliverables checklist.

---

## Optional / Cut
Below the cut line: do only if the items above are done.

1. **Journey 4: AI unmet-demand review** (Priya's cluster, Clermont outside the radius, leader candidate Ruth Abbott). Depends on Journey 4 (base).
2. **Journey 6: a member already in a group.** The eligibility rule behind it (members in a group get no recommendations) is already built and tested in Slice 1; only the "Your group" screen remains. Optional 0:10 demo clip.
3. **Dashboard tile: online-first households within 5 miles of an in-person group.** Depends on the Databricks `person_features` track for real `online_share_12w` values.
4. **Consistency factor in the score.** Neutral (7.5) today. Turning it on is a new scoring version and a new evaluation, not part of the Databricks cutover. Depends on Databricks parity.

**Cut by decision (W8):** escalation "needs care" and escalation "group drift" are out of demo scope.

---

## Completed

### Journey 1: A member chooses a group
- **Status:** Complete against the development database (2026-11-09). Not yet exercised on a deployed environment (Slice 0a) or in a real browser; the pages and server actions were driven over HTTP.
- **Scope delivered:** member persona chooser and role-based landing; member home on the real recommendation lifecycle (ranked group cards, explicit "Show me groups" request, saved-result reuse, empty, ineligible and error states); group detail; Ask to join with an optional note; confirmation and pending states; leader first name for "will reach out".
- **Acceptance (all passed):**
  1. Dana's top pick is First Steps; Marcus sees Tuesday Night Dads first with Sunday Lunch D-Group among the three (live, via the application path; 1 model call each).
  2. A saved result is reused with zero model calls on revisit and refresh.
  3. No score, shortlist, breakdown, rationale, model or prompt version appears in the member pages, their payloads or member-readable queries.
  4. A member can ask to join and sees a pending state on the group and on the home screen; the request is stored as `requested`, linked to the recommendation, with one audit row that holds no note text.
  5. Duplicate and concurrent requests create exactly one request; ineligible callers, unknown/full/closed groups and gender-incompatible groups are rejected by the database; members cannot insert or change join requests directly.
  6. The leader of the requested group can read the request; other leaders and other members cannot.
  7. Creating a request does not invalidate the member's recommendation run.
  8. `npm run build` succeeds.
- **Evidence:** `npm run test:journey1` 19 of 19 (no model calls; includes active-member, forged-identity and audit-table access checks); `npm run test:recommendations` still passes; `npm run smoke:journey1` against a running app, 21 of 21 (no model calls); `npm run verify:journey1` live, 2 calls total, both revisits reused.
- **Notes:**
  - Migration `0006` adds `app.request_to_join()`, `app.my_join_requests()`, a partial unique index (one open request per member and group) and revokes the direct member insert on `join_request`, which previously let a member choose the request's status.
  - Opening or refreshing the member home never generates recommendations. The first request is an explicit "Show me groups" button (architecture W14). Demo Journeys was updated to match; auto-generating on first visit would be a small change if preferred.
  - Journey 6 ("Your group") and Journey 2 (intake) were not started: a member already in a group sees a short message, and a member without a profile is pointed to the existing mock intake screen.
  - The Slice 0 debug badge and `/connection-test`, and `/recommendation-test`, remain as internal tools, linked quietly from the landing page only.
- **Validate:** `npm run build`; `npm test` (stubbed, no external calls); with the app running, `npm run smoke:journey1`. Explicit only: `npm run verify:journey1`. Node 20 or newer.

### Slice 1: Recommendation Lifecycle
- **Status:** Complete against the development database (2026-11-07). Not yet exercised on a deployed environment or by clicking through the browser; the server action was driven over HTTP.
- **Goal:** prove `eligible request → current run? → reuse | shortlist → Haiku → persist → reuse`, with invalidation on material change (architecture §5–§6, W9, W14–W17).
- **Acceptance (all passed):**
  1. `person_features` populated (331 adults).
  2. First eligible request creates a run and stores its full shortlist and ordered rows.
  3. Haiku ranking returns up to three valid recommendations, or the deterministic score-order fallback does.
  4. A second visit and a refresh reuse the run with zero ranking calls and no new audit rows.
  5. A material change invalidates the affected run, with a reason and timestamp, and no model call.
  6. The next eligible request creates a replacement; the old run is kept.
  7. A zero-candidate request creates a valid empty run, which is reused.
  8. A member in an active group (Ruth) is ineligible and gets no run.
  9. A member cannot read score, breakdown, shortlist, rationale, model or prompt version; no persona can write run tables.
  10. A leader cannot use the Manager audit; the Manager audit works.
  11. Changing the ranking prompt version invalidates old runs lazily, with zero model calls.
  12. Concurrent persists leave exactly one current run.
  13. `npm run build` succeeds.
- **Evidence:**
  - `npm run test:recommendations` (stubbed, no external calls): 42 of 42 passed on repeated runs, including parity of the database shortlist with the JS reference for all 14 evaluation labels.
  - `npm run verify:openrouter` (live, explicit): 1 model call; model `anthropic/claude-haiku-5.5`, prompt `rank-v2`, outcome `llm`; the immediate revisit made 0 calls.
  - `scripts/rank_eval.mjs` on `rank-v2` (3 runs per variant): A 42/42 top-1, 42/42 top-3, 0 fallbacks; B 39/42 top-1, 42/42 top-3. Details: architecture §10.2.
  - The `/recommendation-test` page and server action were driven over HTTP with a persona that has no eligible group (zero model calls): first request generated an empty run, second reused it, and the Manager audit page listed it.
- **Notes:**
  - Migration `0005` fixes a defect found along the way: `gathered_app` lacked use of the `audit_log` id sequence, so app-side audit inserts failed.
  - `person_features` comes from the local bootstrap producer (`scripts/compute_person_features.mjs`), idempotent and counts-only; Databricks parity is tracked under *Next*.
  - Known approximation: invalidation does not re-score groups that were never on a member's shortlist (architecture §6.6).
- **Validate:** `npm run test:recommendations`; `npm run build`. Explicit only: `npm run verify:openrouter`, `node --env-file=.env.local scripts/rank_eval.mjs`. Run with Node 20 or newer.
- **Commit:** `e7f7415` ("Recommendation Lifecycle").

### Foundation: schema, security and seed
- **Status:** Complete.
- **Includes:** migrations `0001` (tables), `0002` (row-level security and grants), `0003` (`app.group_card()`), applied with `scripts/migrate.mjs`; seed generator and loader (`seed/generate_seed.py`, `scripts/load_seed.mjs`, `npm run seed:reset`); Lakebase `gathered-demo` with the `gathered_app` and owner roles.
- **Commit:** `e6c857d` ("Seed data and migration scripts").

### Operational store spike
- **Status:** Complete (2026-11-02). Lakebase chosen; results in architecture §10.1. The true cold-start measurement remains open under Slice 0.
- **Validate:** `node --env-file=.env.local pgtest.mjs pg` (the spike scripts are to be deleted once no longer needed).

### UI scaffold
- **Status:** Complete. The v0-generated Next.js App Router application (all screens in the Demo Journeys screen inventory, mock data) merged into the repository root.
- **Commit:** `433b2d0` ("Initial web app").

### Recommendation Model Evaluation
- **Status:** Complete. `rank-v1` passed (2026-11-05); `rank-v2` re-run (2026-11-07). Method, prompt contract and results: architecture §10.2.
- **Validate (explicit, real OpenRouter calls):** `node --env-file=.env.local scripts/rank_eval.mjs`.
- **Commit:** `39d6626` ("LLM ranking pilot", the original script).

### Documentation reconciliation
- **Status:** Complete. Decisions W14–W17 and the recommendation lifecycle codified in the architecture; MVP limitations documented (architecture §12); documentation split into architecture, product behavior and this tracker (2026-11-08).
