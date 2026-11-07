# Gathered: Demo Journeys & Build Plan
**Version 0.2 · 2026-11-07**
**Companions:**
- `Gathered - Data Model & Architecture.md`: decisions W1–W17, schema, row-level security, matching and the recommendation lifecycle. It is canonical; if this plan disagrees with it, it wins.
- `AI for Church Hackathon - Submission Deliverables.md`: submission fields and safeguards checklist.

This document is the build plan. Each **slice** proves one piece of infrastructure; each **user journey** is one vertical slice of the product and one segment of the demo video. Build them in the order under *Build Priorities & Cut Order*. Demo them in the order under *Video Run Order*. Target submission: **Tue Nov 24**; if behind, cut from the bottom of the build list.

**Contents**
1. Build Principles
2. Pre-Build Validation: Operational Store Spike · Recommendation Model Evaluation
3. Foundation
4. Slice 0: Application & Data Connection
5. Slice 1: Recommendation Lifecycle
6. User Journeys 1–6
7. Demo Plan: Video Run Order · Build Priorities & Cut Order

---

## Build Principles
These apply to every slice and journey.

- **One database helper.** `withPersona(personaKey, async (db) => …)`:
  1. opens a transaction as `gathered_app`
  2. runs `set_config('app.role', …, true)` and `set_config('app.person_id', …, true)`
  3. runs the callback on the same connection
  4. commits, or rolls back on error, and releases the connection

  **No database access anywhere else** in the app. The runtime uses `DATABASE_URL` (`gathered_app`) only; the owner URL is for migrations and seeds.
- **Mock auth.** The persona picker writes `personaKey` to a cookie. Personas come from `seed/out/personas.json`.
- **LLM calls are server-side only** (OpenRouter). Each call writes an `audit_log` row: purpose, model, prompt version, token counts. Never the full prompt if it contains `about_me`.
- **Recommendations are persisted and reused** (W14). A page view never calls the ranking LLM by itself; only a request with no valid stored run does.
- **What each role can see** (W3, W10; architecture §4):
  - Members see public group cards (`app.group_card()`) and never any reasoning about themselves.
  - Leaders never see `member_profile`, attendance or the internal rationale.
  - Only the Manager sees score breakdowns and internal rationales, via `app.manager_recommendation_audit()`.
- **Minimal CRUD** (W4). User-initiated writes: intake confirmation, join request, leader accept/decline, manager acknowledge/resolve. System writes that follow from them: recommendation runs and their invalidation, escalation inserts, audit rows.

---

## Pre-Build Validation
Two risks were tested before any UI was built: whether the operational store could support the security model, and whether the hybrid ranking picks the right groups.

### Operational Store Spike
Lakebase passed external connection, a stable native credential and per-request row-level security on 2026-11-02, and was chosen over Neon. Results and the remaining cold-start measurement: architecture §10.1. Script: `pgtest.mjs`.

### Recommendation Model Evaluation
**Goal:** prove that the shortlist-then-LLM ranking picks the right group before building screens around it.

**Script:** `scripts/rank_eval.mjs` (`node --env-file=.env.local scripts/rank_eval.mjs`)
1. For each row in `seed/out/eval_label.csv`, build the member context from Lakebase. The owner URL is acceptable here because this is offline evaluation, not the app.
2. **Hard filters** (architecture §5.2):
   - open seats, and status `forming` or `open`
   - gender focus
   - meeting slot in `available_slots` and **not** in busy slots
   - within 5 miles of the leader's home, unless online

   *Busy slots:* `person_features` is empty until the Databricks job runs, so the script derives them from `seed/out/serving_assignment.csv`.
3. **Weighted score** (architecture §5.3) → shortlist of up to 6, with `score_breakdown`.
4. **LLM call** using the prompt contract below, in two variants:
   - (A) the shortlist includes each group's score
   - (B) the shortlist has no scores and is shuffled (tests whether the LLM just copies the score order)

   A third baseline, (C), takes the score order with no LLM.
5. **Validate the output:**
   - every `group_id` comes from the shortlist, with no duplicates and `min(3, n)` items
   - on failure, retry once; if that fails, fall back to the score order and log it
6. **Report for each label:** the shortlist, the LLM's top 3, the expected group, hit or miss, and the rationale (printed locally only).
7. **Summary:**
   - top-1 hits out of 14
   - top-3 hits out of 14 (an accepted alternate counts for top-3)
   - off-shortlist or invalid outputs
   - average latency and token cost
   - **3 runs per variant**, to check stability

**Pass mark (set before running):**
- **top-1 ≥ 10 of 14**
- **top-3 ≥ 13 of 14**
- **0 invalid outputs after retry**
- the same top-1 in at least 2 of 3 runs

**Prompt contract (`rank-v1`):**
- **System prompt:**
  - "You choose up to three small groups for a church member from a shortlist the church already filtered for schedule, distance, gender focus and open seats."
  - "Use only `group_id`s from the shortlist."
  - "Base the choice on the member's own words and stated preferences compared with each group's description and tags."
  - "Do not infer or mention anything about the member's spiritual state, marriage, health or struggles beyond what they wrote, and never describe the member's personal circumstances."
  - "The rationale is an internal audit note for the groups pastor: refer to group facts and the member's stated preferences."
- **Input (JSON):**
  - `member`: `life_stage`, `group_pref`, `interests[]`, `about_me`. No names, no attendance, no address.
  - `shortlist[]`: `group_id`, `name`, `description`, `tags[]`, `meeting_slot`, `gender_focus`, `life_stage_focus`, `childcare`, `is_online`, `group_mix` (aggregated counts only, e.g. `{"young_kids": 3}`), and in variant A `score`.
- **Output (JSON schema, zod-validated):** `{ "ranked": [{"group_id": uuid, "rank": 1..3}], "internal_rationale": string ≤ 60 words, "confidence": "high"|"medium"|"low" }`
- **Model:** `OPENROUTER_MODEL_FAST` (Claude Haiku).

**Result (2026-11-05, run `rank_eval-2026-11-05T18-02-26`, Haiku, `rank-v1`): PASS.**

| Variant | Top-1 | Top-3 | Fallbacks | Stable top-1 |
|---|---|---|---|---|
| C: score only, no LLM | 9/14 | 12/14 | n/a | n/a |
| A: LLM sees scores | **42/42** (3 runs) | 42/42 | 0 | 14/14 |
| B: LLM, scores hidden, shuffled order | 40/42 | 42/42 | 0 | 14/14 |

- **Shortlist recall:** 14/14.
- **Cost and latency:** about $0.02 for 42 calls; about 3.8 s per call.
- **What the LLM adds:** +5 top-1 picks over the score alone, exactly on the cue-driven cases: e05 (travels, so online), e10 ("right after church," which the score ranked 4th), e02, e09 and e11. Variant A departed from the score order 5 times, so it isn't copying the scores.
- **B's two misses:** both e11, which picked Tuesday Night Dads (an accepted alternate) over the forming group for "start something fresh." **Fix:** pass `status` and `open_seats` in the shortlist input (`rank-v2`).
- **Rationale check:** the rationales stick to stated preferences and group facts. In e08 the member mentioned needing to confess things; the rationale refers only to the *group's* confession focus and never describes the member.
- **Caveat:** these are 14 designed labels written alongside the groups, so it is an easy test. Report it as a designed test set, not field accuracy. Add 6–10 harder labels written by someone else before quoting the number publicly.
- **Shipping decision:** variant A, the hybrid of score and judgment. Report both A and B.

---

## Foundation
What the slices build on:

- **Schema:** `migrations/0001_app_schema.sql` (tables), `0002_rls_policies.sql` (row-level security and column grants), `0003_security_definer_functions.sql` (`app.group_card()`), `0004_recommendation_run.sql` (recommendation runs, shortlist, persistence, audit and invalidation triggers), `0005_audit_log_sequence_grant.sql`. Applied with `scripts/migrate.mjs` using the owner URL.
- **Seed data:** `seed/generate_seed.py` → `seed/out/*.csv`, loaded with `scripts/load_seed.mjs` using the owner URL (architecture §9).
- **Person features:** a nightly Databricks notebook is the intended producer of `person_features` (architecture §3b). Until it exists, `scripts/compute_person_features.mjs` is a **local bootstrap producer** of the same output contract from the seed files: deterministic, idempotent, and it writes a row only when a value changed (`npm run features:local`). It is a development and recovery tool, not the deployed architecture.
- **UI scaffold:** the screens below were generated as a Next.js App Router + Tailwind + shadcn/ui scaffold with mock data only, and are wired to the database slice by slice.

| Route | Screen | Key components |
|---|---|---|
| `/` | Persona picker | Persona cards (name, role badge, one-line blurb), "Continue as…" |
| `/member` | Member home: recommendations (3 cards) or "Your group" | GroupCard (name, description, tags, slot, area, open seats, childcare), empty state for no match ("No group fits your mornings yet. We've let our groups pastor know.") |
| `/member/intake` | Intake → confirm | Textarea, editable chip groups (life stage, slots, preference, interests), "Looks right" |
| `/member/groups/[id]` | Group detail + ask to join | Description, note field, "Ask to join", pending state |
| `/leader` | Leader home | My-group summary, recent joiners, requests list with Accept/Decline |
| `/manager` | Manager dashboard | KPI tiles, groups table, escalations list with "Run review", escalation detail drawer |
| `/manager/members/[id]/audit` | Recommendation audit | Run history, score-breakdown table, rationale panel, before/after compare |
| All pages | App shell | Header with the current persona and a "switch persona" link, role badge, a quiet "demo data" banner |

**Design notes:**
- Calm and pastoral rather than SaaS-flashy.
- Generic labels ("Manager / Leader / Member", "group"), so it carries over outside church settings.
- Mobile-first for the member screens. Desktop table layout for the Manager.

---

## Slice 0: Application & Data Connection
**Goal:** every layer works end to end on Vercel before any feature work.
- **Path:** Vercel (Next.js) → `withPersona` → Lakebase as `gathered_app` → `app.group_card()`.
- **Screens:** the persona picker (landing page) and a bare group-card list with a temporary debug badge.
- **Debug badge:** reads `current_user`, `app.role` and `app.person_id` back from the same transaction that served the cards, so it proves the database context changed, not just the cookie. It is demo instrumentation and is removed once Journey 1 replaces the screen.
- **No features:** no recommendations, intake, requests, LLM or Databricks.

**Done when:**
- The deployed URL shows 20 group cards from `app.group_card()`.
- Switching persona (at least one Member, one Leader and the Manager) changes the badge's role and person while `current_user` stays `gathered_app` and the cards stay identical.
- The cold-start time after 10+ minutes idle is measured and recorded (architecture §10.1, P4).

---

## Slice 1: Recommendation Lifecycle
**Status: Complete (2026-11-07).** All acceptance criteria below passed against the development database; evidence was reported with the implementation.

**Goal:** prove the persisted recommendation lifecycle before building member screens around it (architecture §5–§6, W9, W14–W17).

```
eligible request → current run stored? → yes: reuse (0 LLM calls)
                                       → no:  shortlist → Haiku (rank-v2) → persist run → return
next request → reuse
material change → invalidate (0 LLM calls) → next request regenerates
```

**Prerequisite:** `person_features` populated in Lakebase. The shortlist needs `busy_slots`, `kids_age_bands` and `serving_areas`. Slice 1 uses the local bootstrap producer; the Databricks job follows in the *Next increment*.

**Establishes:**
- **Eligibility:** opted-in members with no active group membership only (§5.1). A member with an active membership gets their group experience instead (Journey 6), with no matching.
- **Deterministic stage in the database:** `app.recommendation_shortlist()` implements the hard filters and weighted score (§5.2–5.3), moved from the evaluation script, returning up to 6 candidates with `score_breakdown`.
- **Haiku ranking with `rank-v2`:** the `rank-v1` contract plus each group's `status` and `open_seats`, zod-validated, shortlist-only, retry once, then score-order fallback. Re-evaluated against the 14 labels before it ships.
- **Persistence:** a `recommendation_run` with its full shortlist (`recommendation_run_candidate`) and its ordered `recommendation` rows, written only by `app.persist_recommendation_run()`. The ranking client writes one `audit_log` row per model attempt; the run stores final provenance and aggregate usage and does not duplicate those rows.
- **Manager-only audit:** score, breakdown, rationale, provenance and invalidation history readable only through `app.manager_recommendation_audit()`. Members read ordered groups and public group cards only.
- **Current/invalid semantics:** one current run per member; material changes (§6.3) invalidate affected runs through database triggers (§6.6), with a reason and timestamp, no LLM call, and no change to Leader RLS.
- **Empty runs:** zero eligible groups creates a valid empty run, reused on revisits (§6.2).
- **Prompt-version invalidation:** deploying a new `prompt_version` invalidates runs made under the old one, without regenerating.
- **Reuse:** a request with a current run returns it with zero ranking calls.

**Tests:** `npm run test:recommendations` runs the stubbed regression and integration suite (no external LLM calls; safe to repeat and for CI): shortlist parity with the reference implementation, eligibility, persistence and integrity, reuse, every invalidation trigger including no-op writes and the Leader-accept path, empty runs, prompt-version invalidation, visibility by direct query, audit access, retry and fallback, and concurrency. `npm run verify:openrouter` is the separate, explicitly invoked live check (one eligible request plus one revisit). Neither runs as part of `npm run build`. Run them with Node 20 or newer.

**Screens:** none new. A temporary `/recommendation-test` page (like Slice 0's `/connection-test`) with a "Request recommendations" button and a debug readout: run ID, current/invalid, outcome, and the count of ranking audit rows. For the Manager persona it also shows the audit rows. Journey 1 replaces it.

**Done when:**
1. The first request by an eligible member (e.g. Dana) generates a run and stores it with its shortlist and ranked rows.
2. Immediately revisiting or refreshing returns the same run with **zero** additional ranking LLM calls (no new ranking `audit_log` row).
3. A known material change (e.g. a leader accepting a request into a group on Dana's shortlist, or Dana re-confirming her profile) marks the run invalid with a reason and timestamp, and makes no LLM call.
4. Dana's next request generates a new run; the old run remains, marked invalid.
5. Both runs are visible to the Manager through the audit function, with shortlist scores, breakdown, internal rationale, model and prompt version, and none of that is readable by a Leader or Member (verified by direct queries, not just the UI).
6. A member whose filters leave no eligible group (Priya) gets a valid empty run, and a revisit reuses it.
7. A member with an active membership (Ruth) gets her group, and no run is generated.
8. Switching the deployed prompt version marks existing current runs invalid with no LLM call; the next request regenerates under the new version.

---

## User Journeys

### Journey 1 · A member chooses a group (Dana, Marcus) · video 1:00
**Story:**
- **Dana:** new for six weeks, wants to start reading the Bible without being judged. She gets three groups and asks to join First Steps.
- **Marcus:** a dad of two who serves in the preschool room at 11:00. He asks to join Sunday Lunch D-Group, which sets up Journey 4.

**Screens:**
1. **Member home (not in a group):**
   - heading: "Groups that might fit you"
   - 3 group cards: name, description, tags, meeting time, area, open seats, childcare
   - **no explanation of why a group was recommended**
2. **Group detail:** the full description, then "Ask to join" with an optional note (`member_note`).
3. **Request sent:** "Tom will reach out if it's a fit." Shown as pending on the home screen.

**Data:**
- **Recommendations:** the Slice 1 lifecycle. The member reads their current run's groups and order joined to `group_card()`; score breakdown and rationale are not on that path.
- **Join request:** `insert join_request` (`status = requested`, `rec_id`) plus an `audit_log` row. Creating a request does not invalidate any run.

**Guardrail on screen:** cards are identical for every member. No reasoning appears. The member decides.

**Done when:**
- Dana's top pick is First Steps.
- Marcus sees Tuesday Night Dads first and Sunday Lunch among the three.
- Both requests show up in the leaders' views (Journey 3).

### Journey 2 · New attender intake (Jordan) · video 0:45
**Story:** Jordan moved here a month ago with two little ones. He describes himself in a sentence and gets recommendations right away.

**Screens:**
1. **Intake:** "Tell us a little about you and when you're free." A text box. The presenter pastes `demo_intake_text` from `personas.json`.
2. **Confirm:** the LLM-proposed fields shown as editable chips: life stage, days and times, men/women/mixed/couples, interests.
   - "Looks right" saves.
   - Nothing is saved without confirmation.
   - The text box is saved word for word as `about_me`.
3. → **Member home** (Journey 1 screen) with three groups. *Expected:* the forming New Men's D-Group, Tuesday Night Dads and Men's Accountability (order to be verified).

**Data:**
- **The intake LLM call** returns only allowed values (`life_stage`, `available_slots`, `group_pref`, `interests`), validated by a zod schema.
- **On save:** `insert member_profile` (`profile_source = 'llm_confirmed'`, `consent_version = 'v1-2026-10'`) plus an `audit_log` row. Jordan is now eligible and has no run, so opening the member home generates his first run (Slice 1). A later profile change would invalidate it.

**Guardrail:** the LLM proposes and the member confirms. Personal details never become profile fields. Free-text intake is used for group matching only; Gathered is not a crisis-detection system (architecture §12).

### Journey 3 · A leader accepts, and the group changes (Chris → Sam → Jordan) · video 0:45
**Story:** Chris leads a forming men's group with no members yet. He accepts Sam, the first member. Jordan's recommendations shift, because the group now has a dad of toddlers in it.

**Screens:**
1. **Leader home:**
   - "My group": status, member count against capacity, meeting time
   - "Recent joiners" list
   - "Requests waiting", each showing the **requester's name and their own note only**
2. **Request row:** Accept / Decline. Decline asks for a short optional reason.
3. After accepting: Sam appears under recent joiners, and the count changes from 0/8 to 1/8.

**Data:**
- **One transaction:** `update join_request` (`accepted`, `decided_at`, `decided_by`) + `insert group_membership` + `audit_log`.
- **Invalidation, not regeneration:** the new membership is a material change (architecture §6.3). It invalidates Sam's own run (he is no longer eligible) and every run that shortlisted New Men's D-Group, including Jordan's. No LLM call happens at accept time.
- **Jordan's next visit** to his home screen finds no valid run and generates a new one. New Men's D-Group's member mix and kids-age overlap have changed, so its score rises. The old run stays for the audit, so Journey 5 can show before and after.

**Guardrail:** the leader sees no profile, attendance or rationale. Journey 5 proves it on screen.

**Also seeded:** Tom has 2 waiting requests (one is 9 days old, which feeds the rule escalation in Journey 4).

### Journey 4 · Manager oversight and escalations (Alan) · video 1:00
**Story:** the groups pastor sees the health of every group and gets two escalations no rule could catch.

**Screens:**
1. **Manager dashboard tiles:**
   - % of opted-in people connected to a group
   - groups below the minimum
   - groups full
   - requests waiting more than 7 days
   - (optional) online-first households within 5 miles of a group
2. **Groups table:** each group with members, open seats, 12-week meeting attendance rate (Manager-only data) and leader.
3. **Escalations list** with a **"Run review"** button:
   - **Rule items:** First Steps and Young Couples below the minimum; Tom's 9-day-old request.
   - **AI item, hidden schedule conflict:** "Marcus asked to join Sunday Lunch D-Group, which meets right after second service. He serves in the preschool room at 11:00 and may arrive 30–40 minutes late every week."
     - *How it's caught:* the review compares the requested group's description with the requester's busy slots and `about_me`.
   - **AI item, unmet demand:** "6 moms of toddlers want weekday mornings. The only weekday-morning moms' group is in Clermont, outside the 5-mile radius. Consider starting one; possible leader: Ruth Abbott (9 years here, consistent attendance, serves on the Care Team, available Tue/Wed mornings, wrote that she has walked alongside young moms)."
     - *How it's caught:* opted-in, unmatched members with zero eligible groups are grouped by available slots and life stage. Leader candidates are found by fixed rules (signal confidence, serving, 12+ months here, slot overlap). The LLM writes the summary and picks one candidate from that list.
4. **Escalation detail:** the evidence list (the facts it was built from), with Acknowledge and Resolve.

**Data:**
- **Run review:** a server route runs the rule checks plus the two AI reviews (Sonnet) and inserts `escalation` rows with `source = 'rule'` or `'ai'` and `status = 'open'`.
- **Duplicates:** skip any escalation whose kind, group and person already has an open row.
- **Acknowledge / Resolve:** `update escalation` (Manager only, enforced by row-level security) plus an `audit_log` row.

**Guardrail:** escalations are advisory. The Manager decides. AI escalations store their evidence, model and prompt version.

### Journey 5 · Under the hood: audit and the two-role proof (Alan, Tom) · video 0:45
**Story:** show judges what the AI decided and who can see it.

**Screens:**
1. **Manager → member → "Recommendation audit":**
   - every recommendation run for that member, including invalidated runs and the reason
   - score breakdown by factor, LLM rank, confidence and **internal rationale**
   - model and prompt version
   - Jordan's before and after (Journey 3) side by side
2. **Two-role clip:** open the **Tuesday Night Dads** group page as **Tom**, then as **Alan**.

   | | Tom (leader) | Alan (manager) |
   |---|---|---|
   | Member names | ✔ | ✔ |
   | Request notes | ✔ | ✔ |
   | Meeting attendance | ✖ | ✔ |
   | Profiles | ✖ | ✔ |
   | Internal rationale | ✖ | ✔ |
   | Hidden-fields panel | "Not available for your role" | Content shown |

**Data:** `app.manager_recommendation_audit()`, which raises an error for non-managers.

**Guardrail:** this is the safeguards section of the write-up, shown live. Screenshot both views.

### Journey 6 · A member already in a group (Ruth) · video 0:10 (optional)
**Story:** a member who already belongs to a group sees that group's details, not recommendations.
- **Screen:** "Your group": the group card, "Joined Mar 2025", the meeting time and the leader's first name.
- **Data:** her own active membership plus `group_card()`. No recommendation run is generated (W15).

---

## Demo Plan

### Video Run Order (≤ 5:00)
| Segment | Time |
|---|---|
| Problem | 0:30 |
| Journey 2 (Jordan intake) | 0:45 |
| Journey 1 (Dana's pick, Marcus's request) | 1:00 |
| Journey 3 (Chris accepts Sam, Jordan's ranking shifts) | 0:45 |
| Journey 4 (Run review: conflict + unmet demand) | 1:00 |
| Journey 5 (audit + two-role clip) | 0:45 |
| How it's built and the evaluation number | 0:15 |

### Build Priorities & Cut Order
1. ~~Recommendation Model Evaluation~~ (done, 2026-11-05; re-run on `rank-v2` 2026-11-07)
2. Slice 0: Application & Data Connection
3. ~~Slice 1: Recommendation Lifecycle~~ (done, 2026-11-07), on the local `person_features` bootstrap producer
4. **Next increment: Databricks `person_features`** (below)
5. Journey 1
6. Journey 3
7. Journey 2
8. Journey 4: rule items + AI schedule conflict
9. Journey 5
10. ── **cut line if behind** ──
11. Journey 4: AI unmet demand
12. Journey 6
13. Dashboard tile: online-first households

#### Next increment: Databricks `person_features`
Slice 1 runs on the local bootstrap producer. The deployed architecture computes features in Databricks. In order:
1. **Create the Databricks job** that reads the engagement tables (attendance events, serving assignments, services, ministries) and writes `person_features` into Lakebase, using the existing output contract and the owner-role write path.
2. **Compare its output to the local bootstrap producer** for the synthetic dataset.
3. **Require schema and value parity:** the same columns and types, and identical values for every adult, including the attendance-derived columns whose definitions are listed in `lib/features/person-features.mjs`. Resolve any definition difference in the architecture (§3b) first, then in whichever side is wrong.
4. **Switch the deployed/demo feature refresh path to Databricks.** Because the writer is idempotent and the invalidation triggers fire only on changed values, a parity run against unchanged data invalidates no recommendation run.
5. **Retain the local script** for deterministic development and recovery, and do not present it as the deployed analytical architecture.
6. Once parity is confirmed, decide whether to turn the consistency factor on in the score (it is neutral, 7.5, until then); that is a new scoring version and a prompt/score evaluation, not part of the cutover.

Journey 6 sits below the cut line as a demo segment, but the eligibility rule behind it (members in a group get no recommendations) is built in Slice 1.
