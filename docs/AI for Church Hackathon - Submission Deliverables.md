# AI for Church Hackathon 2026: Submission Deliverables

**Project:** Gathered  
**Track:** Care & Community  
**Build window:** Oct 30 – Nov 27, 2026  
**Target submission:** Tue Nov 24  
**Hard deadline:** Nov 27, 11:59 PM ET

**Companion documents:**
- `Gathered - Data Model & Architecture.md` — canonical architecture, data model, security, matching and AI decisions.
- `Gathered - Demo Journeys.md` — build sequence, user journeys and demo plan.
- `AI for Church Hackathon - Application.md` — historical registration submitted before implementation. The design evolved during the hackathon; it is not the current technical specification.

**Purpose:** This file tracks what must be demonstrated and accurately described in the final hackathon submission. Final claims must describe the system actually built.

---

## 1. Submission positioning

### Project name

**Gathered**

### Working tagline

**Gathered helps church members find a small group where they can belong, while giving church leaders a safe, auditable way to support the connection.**

Short version:

**Helping people find the right small group without turning people into scores.**

### Core problem

As churches grow, pastors and ministry staff cannot personally know every new attender well enough to identify the right small group from memory.

Small groups can carry much of the relational and discipleship load, but connecting a person to the right group depends on practical fit:

- schedule
- distance
- availability
- group capacity
- group focus
- life stage
- stated interests
- current group makeup

Gathered helps make that connection while keeping the person in control of the decision.

---

## 2. Description

**Required: 250 words maximum**

Final description should explain approximately this:

Gathered helps churches connect people with small groups that fit their schedule, location, interests and season of life.

A member opts in and provides their preferences. Gathered first applies deterministic eligibility rules such as meeting availability, distance, group capacity and gender focus. It then scores the eligible groups and produces a small shortlist.

A constrained AI ranking step compares the member's own words and confirmed preferences with the public descriptions and tags of those shortlisted groups. Claude selects and orders up to three groups, but it cannot introduce a group that failed the deterministic filters.

The member sees only the public facts about those groups and decides whether to ask to join. Gathered never tells the member what the system thinks about them or why it classified them as a fit.

Recommendations are persisted and reused rather than regenerated on every page view. They are recalculated only when matching-relevant information changes and the member next requests recommendations.

Church leaders see only the information needed to manage their own groups and respond to join requests. Managers can inspect recommendation scores, AI rationale, model and prompt version through a restricted audit view.

The demo uses a completely fictional church and synthetic data.

**Status:**  
- [ ] Final wording
- [ ] ≤250 words
- [ ] Matches implemented product
- [ ] No claims about unbuilt features

---

## 3. Problem it solves for churches

### Core story

As churches grow:

1. staff cannot personally remember every person's situation;
2. group availability and membership constantly change;
3. a technically available group may still be a poor practical fit;
4. new attenders who fail to form relationships can drift away;
5. sensitive member information should not simply be exposed to every ministry leader.

Gathered addresses the connection problem without creating an automated pastoral decision-maker.

### Evidence requirement

Before submission:

- [ ] Add at least one named, dated source supporting the importance of assimilation, belonging or small-group participation.
- [ ] Avoid unsupported claims such as "most churches" or invented industry statistics.

---

## 4. How AI is used

Gathered deliberately separates deterministic rules, analytical features and LLM judgment.

### Deterministic layer

Lakebase/Postgres handles:

- recommendation eligibility
- group availability
- capacity rules
- schedule compatibility
- distance
- gender focus
- deterministic weighted scoring
- shortlist generation

These constraints are explicit and testable.

### Analytical layer

Databricks computes slower-moving `person_features` from synthetic engagement signals, including information such as:

- observed attendance signals
- signal confidence
- consistency
- busy schedule slots
- serving areas
- household/kids-age signals
- tenure

Databricks does **not** select the final recommendations.

### LLM ranking

For an eligible member who needs a new recommendation set:

1. deterministic filters remove ineligible groups;
2. deterministic scoring produces a shortlist of approximately six;
3. Claude Haiku, accessed server-side through OpenRouter, selects and orders up to three groups from that shortlist;
4. its 