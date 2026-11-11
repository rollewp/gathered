# Gathered: build context for Claude Code

## What this is
AI for Church Hackathon entry (build window Oct 30 – Nov 27, 2026; **submit by Tue Nov 24**). Gathered matches members to small groups (D-Groups) with a deterministic shortlist plus LLM final ranking, inside a 3-persona demo portal.

## Source of truth (read before significant work)
- [`docs/Gathered - Data Model & Architecture.md`](docs/Gathered%20-%20Data%20Model%20%26%20Architecture.md): **canonical technical architecture and decisions.** Decisions W1–W17 and D1–D7, schema, RLS matrix, hybrid matching, recommendation lifecycle and invalidation, Lakebase/Databricks responsibilities, LLM contracts and guardrails, escalations, seed spec, validation results, open questions. **If code and spec disagree, the spec wins. Ask before changing a decision.**
- [`docs/Gathered - Demo Journeys.md`](docs/Gathered%20-%20Demo%20Journeys.md): **canonical product behavior.** User journeys (stable numbers, not build order), personas and stories, screens, data effects, guardrails, scope boundaries, and the demo video narrative. It is not a status or sequencing document.
- [`docs/Gathered - Build Tracker.md`](docs/Gathered%20-%20Build%20Tracker.md): **implementation status.** Current and next work, dependencies, sequencing, completed work, and cut decisions. Update it when work starts, finishes or is cut; do not put status in the other documents.
- [`docs/AI for Church Hackathon - Submission Deliverables.md`](docs/AI%20for%20Church%20Hackathon%20-%20Submission%20Deliverables.md): submission requirements and the safeguards that must be built and shown.
- [`docs/Gathered - Synthetic Data Design.md`](docs/Gathered%20-%20Synthetic%20Data%20Design.md): **canonical synthetic-world specification** (scale, population, group catalog, engagement, personas, evaluation scenarios). Technical architecture still wins on any conflict.
- [`seed/generate_seed.py`](seed/generate_seed.py) → `seed/out/*.csv`: synthetic Winter Garden, FL church (deterministic, RNG 516). `seed/SYNTHETIC_DATA_REPORT.md` is generated; `seed/stable_ids.json` records the ids that must never change.

## Stack
- **Operational store:** Lakebase Postgres 17, project `gathered-demo`, schema `app`.
  - Owner role: migrations and seeds only.
  - `gathered_app`: LOGIN only, the only role the app uses.
- **Engagement data and person features:** Databricks Free Edition (Delta). The nightly notebook writes `person_features` into Lakebase.
- **App:** Next.js on Vercel (free tier). Mock auth: a persona picker sets `app.person_id` / `app.role` per request via `set_config(..., true)` inside a transaction.
- **LLM:** OpenRouter, called server-side only (Claude Haiku for intake and ranking, Sonnet for escalation review). Structured output via zod. **No LangChain.**

## Secrets (never print, log, commit or paste into chat)
- `.env.local`:
  - `DATABASE_URL` (gathered_app)
  - `DATABASE_OWNER_URL` (owner; migrations only)
  - `OPENROUTER_API_KEY`
- Databricks: use the CLI profile from `databricks auth login`. No tokens in files.
- `.env*` is git-ignored.

## Non-negotiable guardrails
- **Data:** synthetic data only. No giving data anywhere. Locations are approximate; never show addresses.
- **Visibility:**
  - Meeting attendance, engagement history, score breakdowns and LLM rationale are **Manager-only**.
  - Leaders see their own groups, and requesters only while a request to their group is pending.
  - Members see public group cards, identical for everyone. **No reasoning about a person is ever surfaced** (no "why you fit").
- **Matching:**
  - Hard filters first: opt-in, seats, gender focus, schedule (available and not busy), **≤5 miles from the leader's home**.
  - Then a weighted score to a shortlist of ~6. Then the LLM returns 1 to 3 group IDs (only groups it can positively support; never padded to three) and an internal rationale.
  - The LLM never adds a group that wasn't on the shortlist.
  - Only opted-in members with no active group membership get recommendations.
  - Score, score breakdown, shortlist and internal rationale are Manager-only, enforced by grants and `SECURITY DEFINER` functions, not the UI. Members read ordered groups and public group cards only.
  - Recommendation runs are persisted. A page view or refresh never calls the ranking LLM by itself; material changes invalidate runs through database triggers without calling it (a run is a first-class record that keeps its full shortlist; empty results are valid runs; a prompt-version change invalidates old runs); regeneration happens on the next eligible request with no valid run.
- **Scope:** Gathered is not a crisis-detection or pastoral emergency-response system; do not add that capability in the MVP.
- **Contact:** Gathered never contacts anyone. Every LLM call goes to `audit_log`.
- **Minimal CRUD:** the only user-initiated writes are member intake confirmation, join request, leader accept/decline, manager acknowledge/resolve. System writes that follow from them: recommendation runs and invalidation, escalation inserts, audit rows.

## Working rules
- Propose a short plan, then implement in small steps. Run SQL against Lakebase with the owner URL only for migrations and seeds.
- Re-run `node --env-file=.env.local pgtest.mjs pg`-style persona checks after any RLS change.
- Tests: `npm test` (offline label/metric tests via `npm run test:eval`, then recommendation lifecycle + Journey 1 + Browse Groups catalog, stubbed, no external LLM calls, needs Node 20+) and `npm run build` are routine; `npm run smoke:journey1` drives a running app over HTTP. `npm run verify:openrouter`, `npm run verify:journey1` and `scripts/rank_eval.mjs` make real OpenRouter calls and are run explicitly only.
- `npm run seed:generate` regenerates `seed/out` (Python 3, offline); `npm run seed:check` regenerates twice, compares, validates and rewrites the report; `npm run seed:validate` is the quick pass. None of them touch a database or call a model.
- `npm run seed:reset` reloads the seed and recomputes `person_features` (returns the demo database to a known state, with no recommendation runs).
- `scripts/compute_person_features.mjs` is a local bootstrap producer; Databricks is the intended deployed producer of `person_features`.
- Drop schema `spike` once `app` exists.

## Repo layout
- `docs/`: architecture (canonical), product behavior (Demo Journeys), Build Tracker, submission deliverables, application text, ER diagram.
- `seed/`: `generate_seed.py`, its output CSVs (`seed/out`), `stable_ids.json` and the generated `SYNTHETIC_DATA_REPORT.md`. Regenerate rather than hand-edit CSVs.
- `spike/` and `pgtest.mjs`: the Postgres validation test (passed 2026-11-02). Delete once the `app` schema is in.
