# Gathered: build context for Claude Code

## What this is
AI for Church Hackathon entry (build window Oct 30 – Nov 27, 2026; **submit by Tue Nov 24**). Gathered matches members to small groups (D-Groups) with a deterministic shortlist plus LLM final ranking, inside a 3-persona demo portal.

## Source of truth (read before significant work)
- `docs/Gathered - Data Model & Architecture.md`: decisions W1–W13, schema, RLS matrix, matching, escalations, seed spec. **If code and spec disagree, the spec wins. Ask before changing a decision.**
- `docs/Gathered - Demo Journeys.md`: the build slices in order (Slice −1 ranking test first), per-journey screens, data, LLM calls and guardrails, plus the v0 screen inventory.
- `docs/AI for Church Hackathon - Submission Deliverables.md`: form fields and the safeguards that must be built and shown.
- `seed/generate_seed.py` → `seed/out/*.csv`: synthetic Winter Garden, FL church (deterministic, RNG 516).

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
  - Then a weighted score to a shortlist of ~6. Then the LLM returns the top 3 group IDs and an internal rationale.
  - The LLM never adds a group that wasn't on the shortlist.
- **Contact:** Gathered never contacts anyone. Every LLM call goes to `audit_log`.
- **Minimal CRUD:** the only writes are member intake confirmation, join request, leader accept/decline, manager acknowledge.

## Working rules
- Propose a short plan, then implement in small steps. Run SQL against Lakebase with the owner URL only for migrations and seeds.
- Re-run `node --env-file=.env.local pgtest.mjs pg`-style persona checks after any RLS change.
- Drop schema `spike` once `app` exists.

## Repo layout
- `docs/`: build spec (canonical), submission deliverables, application text, ER diagram. Strategy and outreach stay in Walt's Light 516 workspace; build decisions live here.
- `seed/`: `generate_seed.py` and its output CSVs (`seed/out`). Regenerate rather than hand-edit CSVs.
- `spike/` and `pgtest.mjs`: the Postgres validation test (passed 2026-11-02). Delete once the `app` schema is in.
