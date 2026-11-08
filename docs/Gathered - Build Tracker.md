# Gathered: Build Tracker
**Implementation status, sequencing, dependencies and cut decisions · last updated 2026-11-08**

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

### Slice 0: Application & Data Connection
- **Status:** In progress. Built and exercised locally; deployed verification and the cold-start measurement are not done, so it is **not** complete.
- **Goal:** every layer works end to end on Vercel before further feature work: Vercel (Next.js) → `withPersona` → Lakebase as `gathered_app` → `app.group_card()`.
- **Depends on:** schema and seed (Completed); Vercel project with `DATABASE_URL` set server-side.
- **Acceptance:**
  1. The deployed URL shows 20 group cards from `app.group_card()`.
  2. Switching persona (at least one Member, one Leader and the Manager) changes the debug badge's role and person while `current_user` stays `gathered_app` and the cards stay identical.
  3. The cold-start time after 10+ minutes idle is measured and recorded (architecture §10.1, P4).
- **Notes:**
  - Done locally: persona picker, `withPersona`, `/connection-test` with the debug badge (current user, `app.role`, `app.person_id`), cookie-based mock auth. Checked with Marcus, Tom and Alan: the role and person changed per persona and 20 cards were returned each time.
  - Not done: Vercel deployment verification and the cold-start measurement. Automatic Vercel deploys are currently disabled (`vercel.json`), so a deploy is a deliberate action.
  - The debug badge is temporary instrumentation. Remove it once Journey 1 replaces the screen.
  - Vercel needs `DATABASE_URL`, `OPENROUTER_API_KEY` and `OPENROUTER_MODEL_FAST` (server-side) and Node 20 or newer. Any other database must have migrations `0001`–`0005` applied.
- **Validate:** `npm run build`; then on the deployed URL pick three personas and compare the badge, and time one request after 10+ minutes idle.
- **Commit:** `afa6bef` (code, "Add database connection"). Not complete, so this is not a completion record.

---

## Next
Implementation order. Items 1–3 build the product screens that sit on the finished recommendation lifecycle; the Databricks item is independent and can run alongside them.

### 1. Journey 1: A member chooses a group
- **Status:** Not started.
- **Depends on:** Slice 1 (Completed). No dependency on Slice 0's deployed verification or on Databricks: the shortlist runs on the local `person_features` producer, and Databricks is a swap of the producer, not a prerequisite for the screens.
- **Scope:** member home with real recommendations (replacing the mock data and the Slice 0 debug screen), group detail with "Ask to join" and an optional note, request-sent state, `insert join_request` plus an `audit_log` row. See Demo Journeys, Journey 1.
- **Acceptance:** Dana's top pick is First Steps; Marcus sees Tuesday Night Dads first and Sunday Lunch among the three; both requests appear in the leaders' views (needs Journey 3 for the leader screen).
- **Notes:** also retire the temporary `/connection-test` debug badge and the `/recommendation-test` page (or keep the latter only as an internal tool).
- **Validate:** `npm run build`; `npm run test:recommendations`; manual run as Dana and Marcus.

### 2. Journey 3: A leader accepts, and the group changes
- **Status:** Not started.
- **Depends on:** Journey 1 (requests exist); Slice 1 invalidation (Completed).
- **Scope:** leader home (my group, recent joiners, requests waiting with name and the requester's own note only), Accept/Decline, the single transaction (`join_request` update + `group_membership` insert + `audit_log`).
- **Acceptance:** after Chris accepts Sam, Sam appears under recent joiners and the count goes 0/8 → 1/8; Jordan's current result is out of date and his next visit generates a new one in which New Men's D-Group scores higher; the leader sees no profile, attendance or rationale.
- **Notes:** the invalidation mechanism already exists and is tested for the leader-accept path at the database level; this item adds the screens and the real accept transaction.
- **Validate:** `npm run build`; `npm run test:recommendations`; manual run as Chris and Jordan.

### 3. Journey 2: New attender intake
- **Status:** Not started.
- **Depends on:** Journey 1 (member home screen).
- **Scope:** intake textarea, LLM-proposed chips, confirmation, `insert member_profile` (`llm_confirmed`), zod-validated allowed values; then the member home generates Jordan's first recommendations.
- **Acceptance:** nothing is saved without confirmation; `about_me` is saved verbatim; Jordan's three groups are the forming New Men's D-Group, Tuesday Night Dads and Men's Accountability (order to be verified).
- **Notes:** uses the Haiku model through the same server-side OpenRouter path; each call is audited.
- **Validate:** `npm run build`; a manual run as Jordan using `demo_intake_text` from `personas.json`.

### Databricks `person_features` (independent track)
- **Status:** Not started. Tracked as work still to do; the local bootstrap producer covers development until this lands.
- **Depends on:** nothing in the journeys. Not a hard prerequisite for Journey 1. A Databricks workspace that stays available through judging (Dec 1).
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
- **Depends on:** Journey 1 (Marcus's request to Sunday Lunch); Journey 3 (Tom's waiting requests).
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
