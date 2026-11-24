## Gathered: Demo Journeys

**Product behavior reference · Version 0.5 · 2026-11-23**  
**What this document is:** the reference for what users experience and how the product behaves: the personas and their stories, the screens, the data effects of each action, the guardrails, and the demo narrative. Journey numbers identify stable product and demo scenarios; they are **not** a build sequence.  
**What it is not:** it does not track implementation status, sequencing, dependencies, or cut decisions. Those live in `Gathered - Build Tracker.md`. Technical design lives in `Gathered - Data Model & Architecture.md`, which is canonical if the documents conflict.

**Companions:**
- `Gathered - Data Model & Architecture.md`: architecture decisions, schema, security, matching, and recommendation lifecycle.
- `Gathered - Synthetic Data Design.md`: synthetic population, group catalog, personas, and evaluation scenarios.
- `Gathered - Build Tracker.md`: implementation status, dependencies, sequencing, and cut decisions.
- `AI for Church Hackathon - Submission Deliverables.md`: submission requirements and safeguards checklist.

**Required demo scope (reduced for the submission deadline).** The demo proves two LLM capabilities. Everything else in this document is supporting or later behavior and is not required to prove the thesis.

1. **Journey 1: Dana's recommendation.** A member faces a large catalog; ordinary filters only partly help; deterministic rules decide who and what is eligible; the LLM reasons over unstructured member and group text to reduce the search to one to three useful groups.
2. **Journey 4: the Manager's schedule-conflict insight.** Operational facts alone do not explain the issue; the LLM connects a pending request, a serving schedule and a group's schedule and description; the Manager receives evidence and decides.
3. **Databricks population analytics (a Manager section within Journey 4, no new journey).** Databricks turns six months of engagement history into the member features the matching uses (the serving schedule behind Marcus's insight) and into a population view for Alan: the "Group demand gaps" section on the Manager page lists the top cohorts of unplaced members (life stage and time slot) the current catalog does not serve, as counts only, with no names and no model.

**Contents**
- Product Principles
- How Recommendations Behave
- Screen Inventory
- User Journeys 1–6
- Scope Boundaries
- Demo Narrative

### Product Principles

- **Mock authentication.** A landing page lists seeded personas; choosing one acts as that person. Personas come from `seed/out/personas.json`.
- **Three views.** Manager: group data, oversight, and escalations. Leader: their own groups, recent joiners, and open requests. Member: not in a group → Browse Groups and recommendations; in an active group → that group's details.
- **Gathered recommends; the member decides.** Gathered never explains a recommendation in terms of a person, never contacts anyone, and leaves each decision to a person: the member asks to join, the leader accepts or declines, and the Manager acknowledges or resolves.
- **What each role can see:**
  - Members see public group cards, identical for every member, and never reasoning about themselves.
  - Leaders see their own groups' members and a requester's name and own note while a request is pending. They never see a member profile, attendance, deterministic scores, or internal rationale.
  - Only the Manager sees meeting attendance, recommendation score breakdowns, and internal rationales.
- **Minimal CRUD.** User-initiated writes are intake/profile confirmation, join request, leader accept or decline, and Manager acknowledge or resolve. System writes that follow from them include recommendation runs, invalidations, escalation inserts, and audit rows. Groups, leaders, history, and personas are seeded.
- **AI is server-side and audited.** Every model attempt creates an audit record.

### How Recommendations Behave

This is the member's-eye view of the recommendation lifecycle.

#### When a member gets recommendations

- Only members who opted in through a confirmed profile and are **not in an active group** are eligible.
- A member already in a group sees that group instead (Journey 6).
- A member with no confirmed profile is sent to intake (Journey 2).
- The first time an eligible member explicitly chooses **Find my best matches**, Gathered applies hard eligibility rules, calculates deterministic relevance, keeps a shortlist of up to six groups, and asks the ranking model to select and order **one to three** positively supportable recommendations.
- The member sees only public group cards: name, description, tags, meeting time, general area, open seats, and childcare. No personalized explanation accompanies them.

#### Browsing never recommends

- A member looking for a group starts on **Browse Groups**, the full public catalog.
- Searching, filtering, and paging never call a model, create a recommendation run, or invalidate a saved run.
- **Find my best matches** is the explicit recommendation action.
- **Browse all groups** returns to the catalog without changing the saved result.

#### What a member sees on a return visit

- The member home opens on Browse Groups.
- When a valid saved result exists, the page offers **View my best matches** instead of generating again.
- Reloading, revisiting, and refreshing never re-rank or call the model.
- A saved result is reused until something material changes.

#### What changes the result

- A confirmed profile or preference change makes the member's saved result out of date.
- A leader accepting someone can make recommendation runs out of date when membership, seats, or group mix changes.
- Changes to a group's schedule, status, capacity, focus, tags, description, or leader may invalidate affected runs.
- Changes to a member's availability or serving schedule may invalidate that member's run.
- Creating a join request does **not** invalidate recommendations because a pending request does not reserve a seat.
- Nothing regenerates in the background. A new run is created only when the member explicitly requests recommendations again.

#### When there is nothing to show

- If no group passes the rules, the member sees a calm empty state such as: “No group fits your mornings yet. We've let our groups pastor know.”
- An empty recommendation result is saved and reused until a relevant material change makes a later request worth trying again.
- Members with zero eligible groups can contribute to the Manager's unmet-demand review in Journey 4.

#### What the Manager can see that others cannot

Journey 5 exposes every recommendation run for a member, including out-of-date runs and why they became out of date, the shortlist with deterministic score and per-factor breakdown, model rank and confidence, internal rationale, model, and prompt version.

### Screen Inventory

| Route | Screen | Key components |
|---|---|---|
| `/` | Persona picker | Persona cards with name, role badge, one-line blurb, and “Continue as…” |
| `/member` | Member home | For a member looking for a group: Browse Groups catalog with real total, search, filters, 12 public cards per page, pagination, **Find my best matches**, saved recommendations, and **Browse all groups**. For a member already in a group: “Your group.” |
| `/member/intake` | Profile and preference intake/confirmation | Existing confirmed profile loads as editable values for Dana; members without a profile enter free text and later receive LLM-proposed values in Journey 2. Editable life stage, availability slots, group preference, interests, and `about_me`; explicit confirmation required. |
| `/member/groups/[id]` | Group detail and ask to join | Full public description, note field, **Ask to join**, and pending state |
| `/leader` | Leader home | My-group summary, recent joiners, and requests with Accept/Decline |
| `/manager` | Manager insights | **Insights requiring review**: **Run AI review**, and persisted insight cards (title, summary, evidence, status, join-request state). No KPI tiles or groups table are required. |
| `/manager/members/[id]/audit` | Recommendation audit | Run history, score breakdown, internal rationale, model/prompt metadata, and before/after compare |
| All pages | App shell | Current persona, role badge, switch-persona link, and quiet demo-data banner |

**Design notes:**
- Calm and pastoral rather than SaaS-flashy.
- Generic labels where practical so the design carries beyond church settings.
- Mobile-first member screens; desktop table layout for the Manager.

### User Journeys

#### Journey 1 · A member chooses a group (Dana) · video 1:00

**Story:** Dana has been attending for six weeks. She wants to start reading the Bible without feeling judged for what she does not know. The public catalog contains about 140 groups. Dana uses ordinary filters, still has several groups to inspect, and can see that some technically matching groups are not right for her. She asks Gathered for help, receives one to three persisted recommendations, opens First Steps, and asks to join.

**Screens:**

- **Browse Groups:**
  - Heading: **Find your group**.
  - Real catalog total from the database, approximately 140 groups.
  - Search by group name or description.
  - Ordinary filters: one meeting day, time of day, format, life stage, childcare, and open-to-new-members status.
  - Twelve public group cards per page with result count and pagination.
  - No explanation of why a catalog result appears; the catalog is the same for every member.
- **Dana's manual-filter moment:**
  - Dana selects Wednesday, evening, in person, and single.
  - The catalog still leaves several groups to inspect, including groups that are technically eligible but contextually poor fits, such as an advanced study.
  - Her manual filter also excludes compatible alternatives on another available day.
- **Preferences:**
  - Dana can open **Your preferences** and review or edit her confirmed profile.
  - Confirmation is required before changes are saved.
  - A confirmed change marks her current recommendations out of date; it does not generate a new run automatically.
- **Find my best matches:**
  - The explicit action uses the existing hybrid recommendation lifecycle.
  - It returns one to three public group cards in model-ranked order.
  - The page says **Groups selected for you** and **Explore these options and decide what feels right**.
  - **Browse all groups** returns to the catalog without changing the saved result.
  - No explanation of why a group was recommended appears to Dana.
- **Saved recommendations:**
  - A return visit offers **View my best matches** and reuses the saved run with no model call.
  - When the run is out of date, the page offers **Find my best matches** again.
- **Group detail:**
  - Dana opens First Steps from either the catalog or recommendations.
  - She sees the full public description and can submit an optional note with **Ask to join**.
- **Request sent:**
  - The page confirms that the leader will reach out if it is a fit.
  - The group shows **Request sent · pending**.
  - A duplicate open request for the same member and group is not possible.

**Rules for asking to join:**
- Only a member looking for a group can ask.
- The group must be open or forming with a seat.
- A gender-focused group accepts requests only from members it is intended to serve.
- The optional note is limited to 500 characters.
- There is at most one open request per member and group.
- A member may ask to join a group that was not recommended; that request is simply not linked to a recommendation.

**Data:**
- Browse Groups reads paged and filtered public group cards only. It makes no recommendation-model call.
- Recommendations use the member's current persisted recommendation run.
- A join request inserts `join_request` with status `requested` and the recommendation link when applicable, plus an audit row.
- Creating a request does not invalidate any recommendation run.

**Guardrail:** Catalog cards and recommendation cards display the same public group facts. Only selection and order differ. No score, profile fact, behavioral signal, or reasoning appears. Dana decides.

**Expected outcome:** Dana's top recommendation is First Steps, and she asks to join it.

#### Journey 2 · New attender intake (Jordan) · supporting, not required for the demo

**Story:** Jordan moved here a month ago with two little ones. He has no confirmed profile. He describes himself in a sentence, reviews a structured proposal, confirms it, and becomes eligible to request recommendations.

**Screens:**
- **Intake:** “Tell us a little about you and when you're free.” The presenter pastes `demo_intake_text` from `personas.json`.
- **Confirm:** LLM-proposed values appear as editable controls for life stage, days and times, group preference, and interests.
- **Looks right:** saves only after Jordan confirms.
- The original text is saved word for word as `about_me`.
- Jordan returns to the Journey 1 member home and explicitly chooses **Find my best matches**.

**Data:**
- The intake model returns only allowed values validated by the application contract.
- Confirmation inserts `member_profile` with the canonical source and consent version plus an audit row.
- Jordan then has a confirmed profile, no active group, and no saved run. His explicit recommendation request creates the first run.
- A later confirmed profile change makes that result out of date.

**Guardrail:** The model proposes; Jordan confirms. Personal details never become unrestricted profile fields. Free text is used for group matching only. Gathered is not a crisis-detection system.

#### Journey 3 · A leader accepts, and the group changes (Chris → Sam → Jordan) · supporting, not required for the demo

**Story:** Chris leads a forming men's group with no members yet. He accepts Sam, the first member. Jordan's recommendations shift because the group now has a dad of toddlers in it.

**Screens:**
- **Leader home:** group status, member count against capacity, meeting time, recent joiners, and requests waiting.
- Each request shows only the requester's name and their own note.
- Accept/Decline; Decline allows a short optional reason.
- After accepting, Sam appears under recent joiners and the count changes from 0/8 to 1/8.

**Data:**
- One transaction updates the request, inserts membership, and creates an audit row.
- The new membership marks Sam's own run and each run that shortlisted New Men's D-Group out of date, including Jordan's. No model call occurs at acceptance time.
- Jordan's next explicit recommendation request creates a new run. The old run remains available for Journey 5's audit comparison.

**Guardrail:** The leader sees no profile, attendance, deterministic score, or internal rationale.

**Also seeded:** Tom has two waiting requests; one is nine days old and feeds Journey 4's rule escalation.

#### Journey 4 · Manager schedule-conflict insight (Alan, Marcus) · video 1:00

**Story:** Marcus asks to join Sunday Lunch D-Group, a perfectly valid request. The groups pastor, Alan, runs an AI review. Gathered notices something the structured data does not show on its own: the group meets right after second service, and Marcus serves in the preschool room at second service, so he may routinely arrive late. Alan sees the evidence and decides.

**Required story:**
1. Marcus has, or creates, a pending request for Sunday Lunch D-Group.
2. Alan opens the Manager view.
3. Alan chooses **Run AI review**.
4. The system correlates Marcus's serving-schedule facts with the group's schedule and description.
5. A **Potential schedule conflict** insight appears, with evidence.
6. Alan remains the decision-maker.

**Setup:** Marcus creates the request himself through the ordinary member path. Switch to Marcus, open Sunday Lunch D-Group, and choose **Ask to join** (a note is optional). The seed does not contain this request. It exists only as the input for the Manager review shown next; Marcus does not appear in Journey 1.

**Manager screen (`/manager`):**
- **Insights requiring review** with a primary **Run AI review** action. Nothing is reviewed on page load, on refresh, or when a request is created.
- A persisted insight card: **Potential schedule conflict**, the member and group, a short summary, an **Evidence** list, and **Status: Needs review**. For example: *Marcus requested Sunday Lunch D-Group. His preschool serving assignment overlaps the service immediately before the group meets, so he may routinely arrive late.*
- The card states that the join request is still pending and that nothing has been sent to anyone.

**How the conflict is found:** For each pending request whose requester serves on the same day the group meets, the review model is shown only the request, the group's meeting slot and description, and the requester's serving slots, serving areas and their own `about_me` text. It may raise an insight only when those facts support a concrete recurring conflict, and it may not invent times. Its answer is validated before anything is saved, and the evidence it returns is stored beside the exact facts it was shown.

**Data:**
- A validated "raise" inserts one escalation (source `ai`, kind `schedule_conflict`, status `open`) with its evidence, model and prompt version. Nothing is stored when the model finds no conflict or answers invalidly.
- Running the review again does not duplicate an insight that is already open or acknowledged, and makes no model call for it.
- Every model attempt is written to the audit log.

**Repeating the demo (no database reset).** While the request is pending, Marcus's group page shows **Request sent · Pending** and **Withdraw request**; he confirms, the request becomes withdrawn (kept for history, no membership, recommendations untouched) and **Ask to join** returns. Alan can **Resolve insight** (with a confirmation) on an insight card: it leaves **Insights requiring review** and stays in history. A resolved insight is not recreated by another review while the same request is pending; a new request by Marcus to the same group is a new request and can produce a new insight. Neither action calls a model or contacts anyone.

**Guardrail:** The insight is advisory. The review never rejects, withdraws or changes Marcus's request, never changes his membership or his recommendations, never contacts Marcus or a leader, and draws no conclusion about him beyond a schedule overlap. Alan decides.

**Group demand gaps (Alan).** Below the insights, the Manager page shows up to five gap cohorts, ranked by people with no reachable group: life stage and slot, people without a group, open groups, open seats and a plain classification (No current group, High demand, Limited reach). Aggregates only; a person free at several times is counted in each cohort, so rows are not additive, and availability is not intent. The data is a persisted result written by the Databricks refresh; viewing the page runs no analysis and calls no model. Members and leaders never see it. In the V2 seed the story is weekday-morning demand (for example retired members free on Wednesday mornings: 38 people, one group, eight seats).

**Later / not required for the hackathon demo.** These were part of the earlier Journey 4 and are kept as ideas, not commitments: a Manager KPI dashboard and groups-health table; rule alerts (groups below minimum, requests waiting more than seven days, full groups, leaders with too many groups); an AI unmet-demand review that proposes starting a group and a possible leader; and a fuller escalation workflow (Acknowledge and Resolve with audit).

#### Journey 5 · Under the hood: audit and the two-role proof (Alan, Tom) · show only if already easy

**Story:** Show judges what the recommendation system decided and prove that role boundaries are enforced.

**Screens:**
- **Manager → member → Recommendation audit:**
  - every recommendation run for that member, including out-of-date runs and reason
  - deterministic score breakdown by factor
  - model rank and confidence
  - internal rationale
  - model and prompt version
  - Jordan's before/after runs from Journey 3
- **Two-role clip:** open Tuesday Night Dads as Tom, then Alan.

| Content | Tom, Leader | Alan, Manager |
|---|---:|---:|
| Member names | Yes | Yes |
| Request notes | Yes | Yes |
| Meeting attendance | No | Yes |
| Profiles | No | Yes |
| Internal rationale | No | Yes |
| Hidden-fields panel | “Not available for your role” | Content shown |

**Data:** The Manager audit function rejects non-managers.

**Guardrail:** This is the live safeguards proof. Capture both views for the submission.

#### Journey 6 · A member already in a group (Ruth) · optional, not required for the demo

**Story:** A member who already belongs to a group sees that group's details, not Browse Groups or recommendations.

- **Screen:** Your group, with group card, joined date, meeting time, and leader's first name.
- **Data:** Ruth's own active membership plus the public group card. No recommendation run is generated.

### Scope Boundaries

- **Leaving a group.** No member or leader action exists for leaving a group. The data model can record a departed membership, but it is not a user-initiated MVP action.
- **Withdrawing a join request.** Covered only as the small repeatability step in Journey 4 (no reasons, no messages to the leader, no notifications).
- **What a member sees after a decline.** Not specified. A leader's optional decline reason is not shown to the member in a designed screen.
- **Editing group details, tags, or leaders.** Seeded only; no screen is designed.
- **Changing preferences after intake.** The `/member/intake` route also serves as the confirmed-profile editor. A confirmed change invalidates the saved recommendation run. It does not generate recommendations automatically.
- **Escalations other than the schedule conflict.** Needs-care, group drift, unmet demand and the rule alerts are out of the required demo scope; only the Marcus schedule-conflict insight is built for the submission.
- **Crisis detection or pastoral emergency routing.** Not part of the MVP.
- **Contacting anyone.** Gathered does not send invitations or messages; people do.

### Demo Narrative

#### The two proofs

**Proof 1: Dana's recommendation.** Ordinary browsing and filtering leave real work for the member. Deterministic rules control eligibility. The LLM reasons over the unstructured member and group text to pick the strongest one to three choices, and Dana decides.

**Proof 2: the Manager's schedule-conflict insight.** The operational facts alone do not explain the issue. The LLM connects a pending request, a serving schedule and a group's schedule and description, and the Manager receives evidence and decides.

#### Video Run Order, five minutes or less

The video follows a story arc that is intentionally different from build order. It centers on the two proofs and does not require Jordan's intake, a leader accepting, an unmet-demand analysis, or Ruth's story.

| Segment | Time |
|---|---:|
| Problem and scale | 0:20–0:30 |
| Journey 1: Dana browses about 140 groups, filters, gets one to three recommendations, and asks to join First Steps | 1:15–1:30 |
| Journey 4: Marcus's request, then Alan's AI review and the schedule-conflict insight | 1:00–1:15 |
| Alan's "Group demand gaps" from Databricks: the population view behind it (same Manager page) | 0:15–0:30 |
| Manager audit and safeguards proof (Journey 5), only if already easy to show | 0:30–0:45 |
| Architecture, safeguards and the evaluation summary | 0:30–0:45 |
