# Gathered: Build Tracker
**Implementation status, sequencing, dependencies and cut decisions · last updated 2026-11-23**

This is the only document that tracks what is built, what is current, what is next and what is cut. It carries no product behavior and no architecture.

- Product behavior, screens and demo scenarios: `Gathered - Demo Journeys.md`
- Architecture, schema, security and decisions: `Gathered - Data Model & Architecture.md`
- Submission requirements and safeguards: `AI for Church Hackathon - Submission Deliverables.md`

**Required scope (reduced 2026-11-23, deadline-driven).** The submission proves two LLM capabilities: **Dana's recommendation** (Journey 1) and **the Manager's schedule-conflict insight** (Journey 4, Marcus / Sunday Lunch D-Group). A real **Databricks analytics** increment follows. Everything else is Optional / Post-submission / Cut below: those ideas are kept, but they are not required to prove the thesis.

**Operational stack as built (do not read more into it).** Lakebase PostgreSQL is the operational store. `person_features` is produced by the **local** deterministic bootstrap script (`scripts/compute_person_features.mjs`). The Databricks analytical job, the Delta engagement tables, the parity check and the cutover are **not implemented**; being on a Databricks-hosted Postgres is not lakehouse analytics.

**Dates:** build window Oct 30 – Nov 27, 2026. **Submit by Tue Nov 24**; hard deadline Nov 27, 11:59 PM ET.

**Implementation order is not demo order.** Journey numbers are stable product scenarios. The order below is the order work is done; the order the video shows them is *Video Run Order* in Demo Journeys. If behind, cut from *Optional / Cut*.

**Work item fields:** `Status` · `Depends on` · `Acceptance` · `Notes` · `Validate` · `Commit` (only when one exists; none are recorded otherwise).
**Status values:** Not started · In progress · Blocked · Complete.

---

## Current

### Manager AI schedule-conflict review: Marcus / Sunday Lunch D-Group
- **Status:** Implemented and verified against the development database (2026-11-23). Awaiting review. Not committed. Driven over HTTP against a production build (real pages and the real Manager server action); **not clicked in a real browser** (no browser tooling in the session).
- **Behavior:** the Manager chooses **Run AI review** on `/manager` ("Insights requiring review"). For each pending join request whose requester serves on the same day the group meets, the review model (Sonnet via `OPENROUTER_MODEL_REVIEW`, prompt `schedule-conflict-v1`) is asked one narrow question. A validated `raise: true` saves one escalation (source `ai`, kind `schedule_conflict`, severity from the allowed set, status `open`) whose evidence holds the model's evidence statements, the exact facts it was shown, the request id, and the model and prompt version. The card shows "Potential schedule conflict", the summary, the evidence list, "Status: Needs review", and that the join request is still pending. It never changes the request, membership or recommendation runs and contacts no one.
- **Review input (only these):** first name, the request's own note, the group's name, description and meeting slot, the requester's serving slots (`person_features.busy_slots`), serving areas, and their own `about_me`. No other member, no last name, no ids, no attendance, scores, rationale or profile fields.
- **Safeguards:** Manager-only (the library refuses any other persona before reading anything, and row-level security hides the inputs from members and leaders); explicit action only; at most two attempts per candidate (an invalid reply is retried once, then dropped); the model may not state a number that was not supplied (rejects invented times); one audit row per attempt (`llm_review_attempt`: model, prompt version, attempt, outcome, latency, tokens, cost; never the prompt, facts or `about_me`) and one `escalation_created` row; an open or acknowledged insight for the same person and group is not raised again and costs no model call; concurrent reviews are serialised so a double click cannot duplicate.
- **Code:** `lib/review/schedule-conflict.mjs` (contract, prompt, schema, grounding check), `lib/review/schedule-review.ts` (candidates, attempts, audit, dedup, persistence, insights read), `app/manager/actions.ts`, `app/manager/page.tsx` (replaces the static KPI mock), `scripts/test_schedule_contract.mjs`, `scripts/test_schedule_review.mjs`, `scripts/smoke_manager_review.mjs`. **No schema change; RLS hardened afterward by migration 0008 (see the escalation RLS item below).**
- **Evidence:** `npm test` 187 passed (14 + 15 + 12 + 48 + 19 + 24 + 30 + 25; the new ones are 12 offline contract tests and 25 database tests with a stubbed model and a fetch spy); `npm run smoke:manager` 15 of 15 without a model call; `npx tsc --noEmit` and `npm run build` clean. **One controlled live verification** (`LIVE=1 npm run smoke:manager`, 26 of 26): 1 model attempt, `anthropic/claude-sonnet-5.5`, prompt `schedule-conflict-v1`, outcome ok, about 4.9 s, 1,210 tokens, about $0.006; `raise: true`, severity medium; one open escalation saved (evidence: serving slot Sunday second service 11:00 in the kids area; his own words about the preschool room; the group's "right after second service"; the group's Sunday-afternoon slot); the second press of **Run AI review** made no model call and added no duplicate; Marcus's request stayed one unchanged pending row. The test data was removed afterwards.
- **Marcus setup:** the seed has no Marcus request. He creates it through the ordinary member path: Marcus, open Sunday Lunch D-Group, **Ask to join**. Demo recording therefore needs that one step first (about ten seconds).
- **Gaps and decisions for review (see the report):** the `serving_assignment`, `ministry` and `service` tables are not in Lakebase (they are Databricks-side per architecture D1), so the "preschool room" detail reaches the model only through Marcus's own `about_me`, and the slot codes (`sun_11` = Sunday second service, 11:00) come from a small legend in the contract module; the escalation RLS gap found here is closed by migration 0008 (AI escalations are Manager-only to read and insert; rule escalations unchanged); acknowledged insights also block re-raising; Acknowledge/Resolve is not built.
- **Escalation RLS hardening (migration 0008, applied 2026-11-23):** `select_escalation` now lets group leaders read only `rule` escalations; `insert_escalation` allows `ai` rows only from the manager role (and only as `open`), while `rule` inserts stay open to any role. Update stays manager-only. No feature or UI change; the Manager review server action already runs as the manager. Evidence: 4 new database tests in `scripts/test_schedule_review.mjs` (the group's own leader cannot read the AI insight; member, leader and no-role inserts of an AI row are refused; manager insert works and must be open; rule escalations behave as before).
- **Open:** a real-browser pass (including 320 px width and keyboard use).

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

---

## Next
Required work, in order. The synthetic data expansion block records what was done and what remains open.

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

### Databricks analytics increment (required next, after the Manager review)
- **Status:** Not started. **Not implemented:** the Databricks analytical `person_features` job, Delta engagement tables, parity check and cutover. Gathered currently uses Lakebase PostgreSQL as the operational store and the local deterministic bootstrap producer for `person_features`. Its detailed scope is decided separately; the intended direction is below.
- **Depends on:** a Databricks workspace and Lakebase endpoint that stay available through judging (Dec 1); both are available now (see the operational note under Submission stabilization). Not a prerequisite for the two proofs.
- **Intended direction:**
  1. Load or represent the expanded V2 engagement history (attendance events, serving assignments, services, ministries) in Delta tables.
  2. Use Databricks compute to derive the behavioral and member features at population scale.
  3. Prove schema and value parity with the local bootstrap producer (the same columns and types and identical values for every adult, including the attendance-derived columns defined in the header of `lib/features/person-features.mjs`; resolve any definition difference in architecture §3b first).
  4. Write the approved `person_features` output into Lakebase through the owner-role write path. The writer is idempotent and the invalidation triggers fire only on changed values, so a parity run on unchanged data invalidates no recommendation run.
  5. If time permits, expose one real population-level analytical insight, for example unmatched demand by life stage and time slot, online-first cohorts, or group capacity versus member demand.
  6. Keep the local script for deterministic development and recovery. Do not present it as the deployed analytical architecture.
- **Acceptance:** column and value parity on the synthetic dataset; a rerun on unchanged data reports zero changed rows; the demo refresh path uses Databricks.
- **Validate:** compare the two outputs row by row; `npm run test:recommendations` after the switch; `npm run seed:reset` returns to the local bootstrap state.

---

## Later

### Submission stabilization (after the Databricks analytics increment)
- **Status:** Not started.
- **Items:**
  - Validate Dana's journey and the Manager insight end to end, including a real-browser pass (320 px width, keyboard use).
  - Reconcile `AI for Church Hackathon - Submission Deliverables.md` and `AI for Church Hackathon - Application.md` with the built system. Both still describe an earlier plan (deterministic matching with the LLM only writing explanations, a different data platform and surface, giving data "masked") that W1, W3 and W9 supersede.
  - Screenshots and the demo video, per the Submission Deliverables checklist and the reduced Video Run Order in Demo Journeys.
  - Add 6–10 harder evaluation labels, written by someone other than the author, before quoting the match-quality number publicly (architecture §10.2); the live ranking evaluation has not been re-run under the 1–3 contract.
  - **Lakebase re-enable operational note.** Databricks/Lakebase access is currently available. On 2026-11-16 the Lakebase compute endpoint was found disabled ("The endpoint has been disabled"), alongside a Databricks budget message that resets Dec 1; the database was reachable again by 2026-11-23. To re-enable it: `PATCH /api/2.0/postgres/projects/{project}/branches/{branch}/endpoints/{endpoint}?update_mask=spec.disabled` with body `{"spec": {"disabled": false}}` and a workspace bearer token; `scripts/lakebase-enable-endpoint.postman_collection.json` has the requests. Check it before recording and before judging, and keep test and seed runs against the hosted database to a minimum.
  - Vercel access is available now: deploy (see Slice 0a below) and keep the deployment warm through judging (Nov 28–30) and the Dec 1 showcase.
- **Validate:** the Submission Deliverables checklist.

---

## Optional / Post-submission / Cut
Not required to prove the hackathon thesis (Dana's recommendation and the Manager's schedule-conflict insight). Kept as ideas, not deleted. Do these only after the required work above.

1. **Journey 3: a leader accepts, and the group changes.** Not started. Scope: leader home (my group, recent joiners, requests with name and the requester's own note only), Accept/Decline, the single transaction (`join_request` update + `group_membership` insert + `audit_log`). The invalidation mechanism for the leader-accept path already exists at the database level. Open decision: the leaders of First Steps and Sunday Lunch D-Group are not portal personas.
2. **Journey 2: new attender intake (Jordan AI intake).** Not started. Scope: intake textarea, LLM-proposed chips, confirmation, `insert member_profile` (`llm_confirmed`). `/member/intake` already serves the existing-profile editor and shows an honest "not available yet" page for a member with no profile.
3. **Full Manager KPI dashboard and groups-health table; rule alerts** (groups below minimum, requests waiting more than seven days, full groups, leaders with too many groups). Replaced for now by the Manager insights page.
4. **Unmet-demand clustering and the "start a group" AI feature** (Priya's cluster, Clermont outside the radius, leader candidate Ruth Abbott), including a candidate-leader recommendation.
5. **Broad escalation management** (Acknowledge and Resolve with audit).
6. **Journey 5: full audit UI and the two-role proof.** Not started beyond the Manager audit database function. Scope: a recommendation audit screen for a member (all runs including out-of-date ones, score breakdown, rank, confidence, rationale, model and prompt version, before/after compare) and the Tom-versus-Alan "Not available for your role" panel. Show it in the video only if it is already easy.
7. **Journey 6: a member already in a group.** The eligibility rule behind it is built and tested; only the "Your group" screen remains. Optional 0:10 clip.
8. **Slice 0a: Vercel deployment validation.** Vercel deployment access is available. Deploy the existing application and verify the same application → `withPersona` → Lakebase path from the deployed environment.
9. **Dashboard tile: online-first households near an in-person group.** Depends on the Databricks analytics increment for real `online_share_12w` values.
10. **Consistency factor in the score.** Neutral (7.5) today. Turning it on is a new scoring version and a new evaluation, not part of the Databricks cutover. Depends on Databricks parity.

**Cut by decision (W8):** escalation "needs care" and escalation "group drift" are out of demo scope.

---

## Completed

### Journey 1: A member chooses a group
- **Status:** Complete against the development database (2026-11-09). Not yet exercised on a deployed environment (Slice 0a) or in a real browser; the pages and server actions were driven over HTTP.
- **Scope delivered:** member persona chooser and role-based landing; member home on the real recommendation lifecycle (ranked group cards, explicit recommendation request, saved-result reuse, empty, ineligible and error states); group detail; Ask to join with an optional note; confirmation and pending states; leader first name for "will reach out".
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
  - Opening or refreshing the member home never generates recommendations. The first request is an explicit button (architecture W14; now "Find my best matches", see the Browse Groups increment below). Demo Journeys was updated to match; auto-generating on first visit would be a small change if preferred.
  - Journey 6 ("Your group") and Journey 2 (intake) were not started: a member already in a group sees a short message, and a member without a profile is pointed to the existing mock intake screen.
  - The Slice 0 debug badge and `/connection-test`, and `/recommendation-test`, remain as internal tools, linked quietly from the landing page only.
- **Validate:** `npm run build`; `npm test` (stubbed, no external calls); with the app running, `npm run smoke:journey1`. Explicit only: `npm run verify:journey1`. Node 20 or newer.

### Journey 1 increment: Hybrid Group Discovery (Browse Groups)
- **Status:** Done (2026-11-11) against the development database. Not committed. Driven over HTTP against a production build of the running app; **not clicked in a real browser** (no browser tooling in the session). Not exercised on a deployed environment.
- **Scope delivered:** the member home opens on a database-backed catalog (real total, search, day / time of day / format / life stage / childcare / open-to-new-members filters, 12 cards per page with stable name order, result count, previous/next paging, empty-filter, invalid-parameter, database-error and loading states), a prominent "Find my best matches" action through the existing server action and orchestrator, a recommendation view ("Three groups selected for you", "Browse all groups"), and "View my best matches" for a saved run. Catalog and recommendation cards use the same public card contract; group detail and Ask to join are unchanged.
- **Code:** `lib/catalog-params.ts` (URL parsing and clamping), `lib/catalog.ts` (reads only `app.group_card()` as `gathered_app`, explicit public columns, bound parameters), `components/catalog-controls.tsx`, `app/member/(home)/page.tsx` (moved from `app/member/page.tsx`; same URL) with `loading.tsx`, `app/member/error.tsx`, `scripts/test_catalog.mjs`. No migration, no schema, RLS, scoring, prompt, model or seed change.
- **Evidence:** `npm test` passed: 14 offline + 45 lifecycle/RLS/concurrency + 19 Journey 1 + 24 new catalog tests; `npm run smoke:journey1` against the running app 38 of 38; `npx tsc --noEmit` clean; `npm run build` succeeded. No OpenRouter calls were made by this work: the automated tests inject a stub model and assert zero network calls and zero audit rows from browsing.
- **Open:** the real-browser check (including 320 px width and keyboard use) and the live "Find my best matches" click have not been done; no live ranking evaluation was run.

### Journey 1 increment: Your preferences (existing confirmed profile)
- **Status:** Done (2026-11-11) against the development database. Not committed. Driven over HTTP (real pages and the real server action) against a production build; **not clicked in a real browser** (no browser tooling in the session). Not exercised on a deployed environment.
- **Scope delivered:** the member-home preferences widget now reads the member's own `member_profile` (life stage, meeting times, group preference, interests, and `about_me` as "What you told Gathered") with **Edit preferences**; `/member/intake` is **Your preferences** for a member with a profile: every control prefilled from the database, nothing saved until **Save preferences**, **Cancel** leaves without saving. A real change returns to Browse Groups with "Preferences updated." and **Find my best matches** (the database trigger has already marked the saved run out of date, reason `profile_changed`); an identical confirmation writes nothing, adds no audit row, and the saved run stays reusable. A member with no profile gets an honest "not available in this demo yet" page (Journey 2 is not built) with no fake confirm.
- **Code:** `lib/profile-schema.ts` (allowed values, zod validation, change detection), `lib/member.ts` (`saveMyProfile`, `about_me` added to `getMyPreferences`), `app/member/actions.ts` (`savePreferences`), `components/preferences-form.tsx`, `app/member/intake/page.tsx`, `app/member/(home)/page.tsx`, `scripts/test_profile.mjs`, `scripts/smoke_profile.mjs`. `sun_9` now prints as "Sundays · 9:00 am" (`lib/group-view.ts`). No migration, schema, RLS, scoring, prompt, model or seed change.
- **Decisions to confirm:** `about_me` is limited to 1000 characters (no limit existed in the docs or code). Meeting times are the 10 slots present in the seed (a profile slot no group offers is still selectable). `profile_source` and `confirmed_at` are left unchanged by an edit; a hand edit of an `llm_confirmed` profile keeps that label. Life stage and group preference may be left empty (the seed has members with neither).
- **Evidence:** `npm test` 150 passed (14 + 15 + 48 + 19 + 24 + 30 new profile tests); `npm run smoke:profile` 31 of 31; `npm run smoke:journey1` 40 of 40; `npx tsc --noEmit` and `npm run build` clean. Zero OpenRouter calls: the tests use a stub model and a fetch spy, and the smoke test asserts no model audit rows after a save. The profile audit row (`member_profile_updated`) lists changed field names only, never values or `about_me`.
- **Open:** the real-browser pass (including 320 px width and keyboard use) is not done. Journey 2 AI extraction for a member with no profile is not built. A member in a group (for example Ruth) can still open the editor by URL; the home page does not link to it for them.

### Ranking output: 1 to 3 groups
- **Status:** Done (2026-11-11) against the development database. Not committed. Prompt label stays `rank-v2` (in-place amendment, as requested).
- **Change:** the ranking model returns only groups it can positively support, between 1 and `min(3, shortlist)`, and is told not to fill slots. Validation (`lib/ranking/rank-v2.mjs`), migration `0007` (`persist_recommendation_run` accepts 1..min(3,n) for model outcomes), tests and docs updated. Unchanged: shortlist, scoring, Haiku model, seed data, security boundaries, lifecycle, and the score fallback (still the top `min(3, n)` by score). The member page already rendered 1 to 3 cards ("One group selected for you", "Two groups…").
- **Evidence:** `npm test` 120 passed (14 + 15 + 48 + 19 + 24; the 15 are the new offline contract tests); `npm run smoke:journey1` 40 of 40 including 1- and 2-group pages; `npx tsc --noEmit` and `npm run build` clean. One live Dana call (Haiku, 1 attempt, about 2.6k tokens): returned 2 groups, First Steps then New Group: Thursday Families, outcome `llm`.
- **Caveats:** runs saved under `rank-v2` before this change stay valid (same label) and may hold a padded third group until they are superseded. The §10.2 model evaluation predates this contract and has not been re-run.

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
