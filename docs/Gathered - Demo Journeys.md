# Gathered: Demo Journeys
**Product behavior reference · Version 0.3 · 2026-11-08**

**What this document is:** the reference for what users experience and how the product behaves: the personas and their stories, the screens, the data effects of each action, the guardrails, and the demo narrative. Journey numbers identify stable product and demo scenarios; they are **not** a build sequence.

**What it is not:** it does not track implementation status, sequencing, dependencies or cut decisions. Those live in `Gathered - Build Tracker.md`. Technical design (schema, row-level security, matching, the recommendation lifecycle, LLM contracts) lives in `Gathered - Data Model & Architecture.md`, which is canonical: if this document disagrees with it, it wins.

**Companions:**
- `Gathered - Data Model & Architecture.md`: decisions W1–W17 and D1–D7, schema, security, matching and lifecycle.
- `Gathered - Build Tracker.md`: what is built, what is current and next, dependencies and cut decisions.
- `AI for Church Hackathon - Submission Deliverables.md`: submission requirements and safeguards checklist.

**Contents**
1. Product Principles
2. How Recommendations Behave
3. Screen Inventory
4. User Journeys 1–6
5. Scope Boundaries
6. Demo Narrative

---

## Product Principles
- **Mock authentication.** A landing page lists the seeded personas; choosing one acts as that person (W5). Personas come from `seed/out/personas.json`.
- **Three views** (W6). Manager: group data, oversight and escalations. Leader: their own groups, recent joiners, open requests. Member: not in a group → recommendations; in a group → that group's details.
- **Gathered recommends; the member decides.** It never explains a recommendation in terms of a person (W3), never contacts anyone, and a person makes every decision: the member asks to join, the leader accepts or declines, the Manager acknowledges.
- **What each role can see** (W3, W10; architecture §4):
  - Members see public group cards, identical for every member, and never any reasoning about themselves.
  - Leaders see their own groups' members and the requester's name and own note while a request is pending. They never see a member profile, attendance or the internal rationale.
  - Only the Manager sees meeting attendance, score breakdowns and internal rationales.
- **Minimal CRUD** (W4). User-initiated writes: intake confirmation, join request, leader accept or decline, Manager acknowledge or resolve. System writes that follow from them: recommendation runs and their invalidation, escalation inserts, audit rows. Groups, leaders, history and personas are seeded.
- **AI is server-side and audited.** Every model attempt writes an audit record (architecture §6.4).

---

## How Recommendations Behave
This is the member's-eye view of the recommendation lifecycle (architecture §5–§6, W9, W14–W17).

**When a member gets recommendations**
- Only members who opted in (they have a confirmed profile) and are **not in an active group** are eligible. A member already in a group sees their group instead (Journey 6), and a member with no profile yet is sent to intake (Journey 2).
- The first time an eligible member asks, Gathered filters the groups by what the member can actually attend (open seats, gender focus, an available and not-busy meeting time, within 5 miles of the leader's home unless the group is online), scores them, and keeps the best six. The model then picks and orders the top three from those six.
- The member sees up to three **group cards**: name, description, tags, meeting time, area, open seats, childcare. No explanation accompanies them.

**What a member sees on a return visit**
- The same three groups, in the same order, instantly. Reloading, revisiting or refreshing never re-ranks anything or calls the model; the saved result is reused until something that matters changes.

**What changes the result**
- Anything that could change who qualifies or how groups score marks the saved result out of date. The next time the member asks, a fresh result is generated; the old one is kept for the Manager's audit. Nothing is regenerated in the background.
- Examples:
  - **Dana confirms new preferences** on the intake screen: her saved result is out of date, and her next request generates new recommendations.
  - **A leader accepts someone** into a group: the new member's own result is out of date (they now have a group), and so is the result of any member who had that group in their shortlist, because its seats and mix changed (Journey 3).
  - A group's schedule, status, capacity, focus, tags, description or leader changes, or a member's availability or serving schedule changes.
- Creating a join request does **not** change anyone's recommendations: a pending request holds no seat.

**When there is nothing to show**
- If no group passes the filters, the member sees the empty state ("No group fits your mornings yet. We've let our groups pastor know."). That empty result is saved and reused too, until a relevant change lets the next request try again. Members with zero eligible groups also feed the Manager's unmet-demand review (Journey 4).

**What the Manager can see that others cannot** (Journey 5)
- Every recommendation run for a member, including out-of-date ones and why they went out of date, the shortlist with each group's score and per-factor breakdown, the model's rank and confidence, the internal rationale, and the model and prompt version.

---

## Screen Inventory
Next.js App Router + Tailwind + shadcn/ui, with the screens below.

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
- **Recommendations:** the member's current run (see *How Recommendations Behave*). The member reads the ordered groups joined to the public group cards; score breakdown and rationale are not on that path.
- **Join request:** `insert join_request` (`status = requested`, `rec_id`) plus an `audit_log` row. Creating a request does not invalidate any run.

**Guardrail on screen:** cards are identical for every member. No reasoning appears. The member decides.

**Expected outcomes:**
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
- **On save:** `insert member_profile` (`profile_source = 'llm_confirmed'`, `consent_version = 'v1-2026-10'`) plus an `audit_log` row. Jordan is now eligible and has no saved result, so opening the member home generates his first recommendations. A later confirmed profile change makes that result out of date.

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
- **Out of date, not regenerated:** the new membership is a material change (architecture §6.3). It marks Sam's own result out of date (he is no longer eligible) and every result that shortlisted New Men's D-Group, including Jordan's. No model call happens at accept time.
- **Jordan's next visit** to his home screen finds no current result and generates a new one. New Men's D-Group's member mix and kids-age overlap have changed, so its score rises. The old result stays for the audit, so Journey 5 can show before and after.

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
   - every recommendation run for that member, including out-of-date runs and the reason
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
- **Data:** her own active membership plus the public group card. No recommendation run is generated for her (W15).

---

## Scope Boundaries
What the product does not do, so a question about a missing behavior has a clear answer. This is about product scope, not implementation status; the architecture decisions cited are canonical.

- **Leaving a group.** There is no member or leader action for leaving a group, and no journey for it. The data model can record a membership as `left` (with a date and reason), but the only user-initiated writes are those listed under *Minimal CRUD* (W4), and none of them ends a membership.
- **Withdrawing a join request.** No journey covers it, although a request can carry a `withdrawn` status in the data model.
- **What a member sees after a decline.** Not specified. The leader's decline reason is optional and is not shown to the member in any designed screen.
- **Editing group details, tags or leaders.** Seeded only (W4); there is no screen for it.
- **Changing preferences after intake.** The designed path is the intake screen (`/member/intake`): a confirmed change makes the saved recommendations out of date. A separate "update my profile" journey is not designed.
- **Escalations "needs care" and "group drift."** Out of demo scope (W8).
- **Crisis detection or pastoral emergency routing.** Not part of the MVP (architecture §12).
- **Contacting anyone.** Gathered never sends invitations or messages; people do.

---

## Demo Narrative

### Video Run Order (≤ 5:00)
The video follows a story arc, which is intentionally different from the order the features were or will be built.

| Segment | Time |
|---|---|
| Problem | 0:30 |
| Journey 2 (Jordan intake) | 0:45 |
| Journey 1 (Dana's pick, Marcus's request) | 1:00 |
| Journey 3 (Chris accepts Sam, Jordan's ranking shifts) | 0:45 |
| Journey 4 (Run review: conflict + unmet demand) | 1:00 |
| Journey 5 (audit + two-role clip) | 0:45 |
| How it's built and the evaluation number | 0:15 |

Journey 6 is an optional 0:10 clip and is not part of the run order above.
