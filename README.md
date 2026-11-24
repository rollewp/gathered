# Gathered

**AI-assisted small-group discovery, contextual review, and population analytics for growing churches.**

Gathered is a portfolio and hackathon project that explores a practical question: as a church grows, how can it help people find meaningful small-group connections without asking a few staff members to remember every person, group, schedule, and circumstance?

The project combines deterministic matching, lakehouse analytics, operational PostgreSQL, and bounded LLM reasoning. The goal is not to automate pastoral decisions. It is to reduce search friction, surface useful context, and keep consequential decisions with people.

> **Gathered uses data and AI to make the connection easier. People make the decisions. Discipleship happens in the group.**

## What the demo proves

Gathered centers on three scenarios.

### 1. Dana: from catalog overload to a few useful choices

Dana can browse a synthetic catalog of about 140 groups and use ordinary filters for schedule, format, life stage, childcare, and other public group facts.

Filters help, but they only reflect the criteria Dana happened to select and can still leave several groups to inspect. **Find my best matches** uses a hybrid recommendation pipeline:

1. deterministic rules enforce eligibility and policy;
2. deterministic scoring reduces the candidates to a shortlist of up to six groups;
3. an LLM reasons over Dana's confirmed preferences, her own words, and the groups' natural-language descriptions;
4. Gathered returns one to three positively supportable groups.

The model cannot introduce a group that was not already on the deterministic shortlist.

Members see the same public group-card facts available in the catalog. They do **not** see a personalized explanation, behavioral signals, deterministic scores, or internal LLM rationale.

### 2. Marcus: surface a hidden conflict without making the decision

Marcus can make an otherwise valid request to join a group. A Manager can explicitly run an AI review that considers the pending request, derived schedule context, and the group's public schedule/description.

In the demo, the review identifies a possible recurring schedule conflict between Marcus's serving commitment and the requested group's meeting context. The insight includes grounded evidence for the Manager to review.

The AI does not reject the request, change membership, contact anyone, or make a pastoral decision.

### 3. Alan: see connection gaps across the population

Databricks analyzes the synthetic population and group supply to identify cohorts of opted-in adults without an active group whose life stage and availability are poorly served by the current catalog.

The Manager sees aggregate **Group demand gaps**, such as a cohort with many people available in a given slot but very limited group capacity.

This is deterministic population analytics, not another LLM judgment about individuals.

## Architecture

Gathered deliberately separates operational state, analytics, and language reasoning.

```text
                     Synthetic engagement history
                   attendance · serving · profiles
                                │
                                ▼
                    Databricks + Delta Lake
                 ┌───────────────────────────┐
                 │ person_features           │
                 │ population demand gaps    │
                 └───────────────────────────┘
                                │
                                ▼
                    Lakebase PostgreSQL
       profiles · groups · requests · recommendations
          escalations · demand_gap · audit log
                                │
                ┌───────────────┴───────────────┐
                ▼                               ▼
       Deterministic policy              LLM reasoning
       + shortlist scoring          bounded to supplied facts
                │                               │
                └───────────────┬───────────────┘
                                ▼
                     Next.js / TypeScript UI
```

### Databricks

Databricks is the analytical layer. Delta tables contain the synthetic engagement history and supporting reference data. The analytics pipeline derives the slower-moving `person_features` used by the application and computes population-level `demand_gap` aggregates.

The Databricks implementation is checked for schema and value parity against a deterministic local reference producer before its output is written to Lakebase.

### Lakebase PostgreSQL

Lakebase is the operational system of record. It holds application state such as:

- member profiles;
- groups and memberships;
- join requests;
- persisted recommendation runs and shortlist candidates;
- Manager insights/escalations;
- Databricks-produced analytical serving tables;
- audit records.

PostgreSQL roles, grants, row-level security, constraints, triggers, and narrowly scoped functions enforce authorization and lifecycle behavior below the UI.

### LLMs

Claude models are called server-side through OpenRouter.

- A fast Claude model performs bounded final ranking after deterministic shortlisting.
- A stronger review model performs the Manager schedule-conflict review.
- Structured model output is validated before it can affect persisted application state.

The LLM is not used as a substitute for database policy or population analytics.

## Synthetic data

No real congregant data is used.

The deterministic V2 synthetic dataset models a large church with approximately:

- **4,559 adults**;
- **1,743 children**;
- **2,598 households**;
- **140 groups**;
- **1,571 recommendation-ready profiles**;
- **1,039 active group memberships**;
- **52 weeks of engagement history**;
- **72,455 attendance signals**;
- **566 serving assignments**.

The generator uses a fixed RNG seed and stable IDs for named demo personas and evaluation fixtures. Generated CSVs are artifacts; `seed/generate_seed.py` is the executable source of truth.

## Recommendation lifecycle

Recommendations are persisted rather than regenerated on every page view.

For an eligible member:

1. Hard filters apply opt-in, capacity, schedule, geography, group-focus, membership, and other canonical rules.
2. A deterministic weighted score produces a shortlist of up to six groups.
3. The ranking model may return one to three groups from that shortlist.
4. The run, shortlist, ranking metadata, and recommendations are persisted.
5. Revisiting the page reuses the current valid run with zero additional model calls.
6. Material changes invalidate affected runs through database logic without calling the model.
7. The next explicit recommendation request creates a replacement run.

An empty recommendation result is valid and can also be persisted and reused.

## Responsible AI and safeguards

Gathered is intentionally constrained.

- **Groups are scored, not people.** Gathered never ranks, labels, or rates a person's worth, spirituality, health, marriage, or struggles.
- **Opt-in is required.** Recommendations apply only to people who confirmed a group-connection profile.
- **Rules precede AI.** LLM ranking cannot bypass deterministic eligibility or introduce a group outside the shortlist.
- **Members do not see reasoning about themselves.** Public group facts are identical whether seen in Browse Groups or as a recommendation.
- **Sensitive data is role-restricted.** Internal score breakdowns, behavioral information, and LLM rationale are protected by database permissions.
- **AI review is advisory.** Manager insights present evidence for human review and do not autonomously reject, enroll, contact, or message anyone.
- **Giving data is excluded.** It is not collected or modeled by Gathered.
- **Model outputs are validated.** Structured contracts and grounding checks reject malformed or unsupported results.
- **Every model attempt is auditable.** Audit records capture provenance without storing unnecessary prompt/profile text.
- **Demo data is fictional.** The project contains deterministic synthetic data only.

## Tech stack

- **App:** Next.js, TypeScript, Node.js
- **Operational data:** Databricks Lakebase PostgreSQL
- **Analytics:** Databricks, Delta Lake, Python/PySpark/SQL
- **LLMs:** Anthropic Claude models through OpenRouter
- **Structured AI output:** Zod validation
- **Hosting:** Vercel
- **Testing:** Node-based integration/contract tests, HTTP smoke tests, database/RLS tests, analytics reconciliation and parity checks

## Repository map

```text
app/                  Next.js routes, server actions, persona views
lib/                  recommendations, ranking, review, seed/eval helpers
migrations/           Lakebase PostgreSQL schema/security migrations
scripts/              tests, smoke tests, seed/load/feature utilities, Databricks helpers
seed/                  deterministic synthetic-data generator and outputs
docs/                  canonical architecture, journeys, build tracker, submission docs
databricks/            Databricks analytics assets, where present in the current repo
```

The exact structure may evolve; the canonical implementation and operating notes live in `CLAUDE.md` and `docs/`.

## Local development

### Prerequisites

- Node.js 20+
- Python 3
- access to a Lakebase PostgreSQL database
- OpenRouter credentials for explicit live-AI verification
- Databricks authentication for analytics refresh/development

### Environment

Create `.env.local` using the variable names documented in `CLAUDE.md`. The project uses server-side variables for database access, OpenRouter, the Databricks/Lakebase refresh path, and the optional public-demo password gate.

**Never commit `.env*`, database URLs, OpenRouter keys, Databricks credentials, or the demo password.**

### Common commands

Review `package.json` and `CLAUDE.md` for the current command set. Common workflows include:

```bash
npm test
npx tsc --noEmit
npm run build
npm run seed:generate
npm run seed:validate
npm run seed:check
```

Some smoke/evaluation commands can make real model calls. They are intentionally explicit rather than part of the default test suite.

## Evaluation and testing

The project includes tests for more than the happy path, including:

- deterministic/reference shortlist parity;
- recommendation persistence and reuse;
- invalidation behavior;
- empty results;
- role and RLS boundaries;
- concurrency;
- join-request lifecycle;
- Manager AI-review contracts;
- synthetic-data determinism and referential integrity;
- Databricks/Lakebase analytics reconciliation;
- demand-gap calculation;
- build and TypeScript correctness.

The synthetic evaluation suite contains ranking scenarios as well as exclusion, empty-result, duplicate-request, and active-member cases.

## Demo access

The public deployment may use a simple shared demo-access gate before the persona picker. This protects the fictional shared demo state and prevents anonymous visitors from repeatedly triggering paid model actions.

The demo password is deployment configuration, **not** application identity. Member/Leader/Manager authorization continues to be enforced by the persona context and PostgreSQL security model.

## Why I built this

Gathered is both a product experiment and a hands-on exploration of modern AI application architecture: where deterministic policy belongs, where analytics belongs, where an LLM adds genuine value, and how to keep those responsibilities separated.

The project intentionally uses three different kinds of reasoning:

- **deterministic rules** for eligibility, policy, and transactional integrity;
- **Databricks analytics** for behavioral features and population patterns;
- **LLMs** for bounded interpretation of natural-language context.

That separation became more important than simply adding more AI features.

## Beyond one church

The pattern can apply beyond small groups: member associations, alumni networks, volunteer programs, professional communities, and enthusiast communities all face versions of the same problem.

The domain rules change, but the architecture remains useful: governed operational state, analytical features, bounded language reasoning, and human control over consequential actions.

## Project status

Gathered was built for the AI for Church Hackathon as a working demonstration using fictional data. The repository is being published as a portfolio project and technical reference, not as production church-management software.

Before using any of these patterns with real congregant or member data, a production implementation would require an appropriate security, privacy, retention, observability, accessibility, authentication, and operational review.

## Author

**Walt Rolle**  
Founder, Light 516

