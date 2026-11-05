# Gathered: Demo Journeys & Build Slices v0.1
**2026-11-04 · Each journey is one vertical slice and one segment of the demo video.** Build them in order; demo them in order.
**Companions:** `Gathered - Data Model & Architecture.md` (decisions W1–W13, schema, guardrails) · `AI for Church Hackathon - Submission Deliverables.md` (form fields, safeguards checklist)
**Target:** submit Tue Nov 24. If behind, cut from the bottom of §10.

---

## 0 · Ground rules for every slice
- **One database helper.** `withPersona(personaKey, async (db) => …)` opens a transaction, runs `set_config('app.role', …, true)` and `set_config('app.person_id', …, true)`, runs the callback as `gathered_app`, then commits. **No database access anywhere else.**
- **Mock auth.** The persona picker writes `personaKey` to a cookie. Personas come from `seed/out/personas.json`.
- **LLM calls are server-side only** (OpenRouter). Each call writes an `audit_log` row: purpose, model, prompt version, token counts. Never the full prompt if it contains `about_me`.
- **What each role can see** (W3/W10, spec §4):
  - Members see public group cards (`app.group_card()`) and never any reasoning about themselves.
  - Leaders never see `member_profile`, attendance or rationale.
  - Only the Manager sees score breakdowns and rationale, via `app.manager_recommendation_audit()`.
- **Minimal CRUD (W4).** Writes are limited to: intake confirm, join request, leader accept/decline, manager acknowledge, escalation insert, recommendation insert, audit insert.

---

## Slice −1 · Ranking test (script only, before any UI) ⭐ build first
**Goal:** prove the shortlist-then-LLM ranking picks the right group before building screens around it.

**Script:** `scripts/rank_eval.mjs` (`node --env-file=.env.local scripts/rank_eval.mjs`)
1. For each row in `seed/out/eval_label.csv`, build the member context from Lakebase (owner URL is fine; this is offline evaluation).
2. **Hard filters** (spec §5):
   - opt-in
   - open seats, and status `forming` or `open`
   - gender focus
   - meeting slot in `available_slots` and **not** in busy slots
   - within 5 miles of the leader's home, unless online

   *Busy slots:* `person_features` is empty until the Databricks job runs, so derive them from `seed/out/serving_assignment.csv`.
3. **Weighted score** (spec §5 table) → shortlist of up to 6, with `score_breakdown`.
4. **LLM call** using the prompt contract below. Run **two variants:**
   - (A) the shortlist includes each group's score
   - (B) the shortlist has no scores (tests whether the LLM just copies the score order)
5. **Validate the output:**
   - Every `group_id` comes from the shortlist, there are no duplicates, and there are `min(3, n)` items.
   - On failure, retry once. If that fails, fall back to the score order and log it.
6. **Report for each label:** the shortlist, the LLM's top 3, the expected group, hit or miss, and the rationale (printed locally only).
7. **Summary:**
   - top-1 hits out of 14
   - top-3 hits out of 14 (an "acceptable" alternate counts for top-3)
   - off-shortlist or invalid outputs
   - average latency and token cost
   - **3 runs per variant**, to check stability

**Pass mark (decide before you run it):**
- **top-1 ≥ 10 of 14**
- **top-3 ≥ 13 of 14**
- **0 invalid outputs after retry**
- the same top-1 in at least 2 of 3 runs

Below that, fix the prompt or the shortlist size before building any UI. The final number goes in the submission as the match-quality evaluation.

**Prompt contract (v1, versioned as `rank-v1`):**
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
- **Model:** `OPENROUTER_MODEL_FAST` (Haiku). If the pass mark is missed, try Sonnet once before rewriting the prompt, so you learn whether it's the model or the prompt.

---

## Slice 0 · Connection test (no features)
**Goal:** every layer works end to end on Vercel before any feature work.
- **Screens:** the persona picker (landing page) and a bare group card list.
- **Path:** Vercel (Next.js) → `withPersona` → Lakebase as `gathered_app` → `app.group_card()`.
- **Done when:** the deployed URL shows 20 cards, and switching persona changes a debug badge showing `current_user`, role and person. Note the cold-start time after 10+ minutes idle.

---

## Journey 1 · A member chooses a group (Dana, Marcus) · **video 1:00**
**Story:**
- **Dana:** new for six weeks, wants to start reading the Bible without being judged. She gets three groups and asks to join First Steps.
- **Marcus:** a dad of two who serves in the preschool room at 11:00. He asks to join Sunday Lunch D-Group, which sets up Journey 4.

**Screens:**
1. **Member home (not in a group):**
   - heading: "Groups that might fit you"
   - 3 group cards: name, description, tags, meeting time, area, open seats, childcare
   - **no "why you fit" text**
2. **Group card detail:** a full description, then "Ask to join" with an optional note (`member_note`).
3. **Request sent:** "Tom will reach out if it's a fit." Shown as pending on the home screen.

**Data:**
- **Recommendations:**
  - computed by `app.recommend_groups(person)` (owner-rights; built in this slice from the Slice −1 logic) plus the LLM ranking
  - stored as `recommendation` rows; the member reads them through `recommendation` (no hidden columns) joined to `group_card()`
- **Join request:** `insert join_request` (`status = requested`, `rec_id`) plus an `audit_log` row.

**Guardrail on screen:** cards are identical for every member. No reasoning appears. The member decides.

**Done when:**
- Dana's top pick is First Steps.
- Marcus sees Tuesday Night Dads first and Sunday Lunch among the three.
- Both requests show up in the leaders' views (Journey 3).

---

## Journey 2 · New attender intake (Jordan) · **video 0:45**
**Story:** Jordan moved here a month ago with two little ones. He describes himself in a sentence and gets recommendations right away.

**Screens:**
1. **Intake:** "Tell us a little about you and when you're free." A text box. The presenter pastes `demo_intake_text` from `personas.json`.
2. **Confirm:** the LLM-proposed fields shown as editable chips: life stage, days and times, men/women/mixed/couples, interests.
   - "Looks right" saves.
   - Nothing is saved without confirmation.
   - The text box is saved word for word as `about_me`.
3. → **Member home** (Journey 1 screen) with three groups. *Expected:* forming New Men's D-Group, Tuesday Night Dads, Men's Accountability (order to be verified).

**Data:**
- **The intake LLM call** returns only allowed values (`life_stage`, `available_slots`, `group_pref`, `interests`), validated by a zod schema.
- **On save:** `insert member_profile` (`profile_source = 'llm_confirmed'`, `consent_version = 'v1-2026-10'`), then recommendations as in Journey 1.

**Guardrail:** the LLM proposes and the member confirms. Personal details never become profile fields.

---

## Journey 3 · A leader accepts, and the group changes (Chris → Sam → Jordan) · **video 0:45**
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
- **Jordan's recommendations are generated again** when he next opens his home screen (or by a "Refresh" button for the demo):
  - The `group_mix` and kids-age overlap for New Men's D-Group change, so its score rises.
  - The new `recommendation` rows carry a later `generated_at`, so Journey 5 can show before and after.

**Guardrail:** the leader sees no profile, attendance or rationale. Prove it on screen in Journey 5.

**Also seeded:** Tom has 2 waiting requests (one is 9 days old, which feeds the rule escalation in Journey 4).

---

## Journey 4 · Manager oversight and escalations (Alan) · **video 1:00**
**Story:** the groups pastor sees the health of every group and gets two escalations no rule could catch.

**Screens:**
1. **Manager dashboard tiles:**
   - % of opted-in people connected to a group
   - groups below the minimum
   - groups full
   - requests waiting more than 7 days
   - (optional) online-first households within 5 miles of a group
2. **Groups table:** each group with members, open seats, 12-week meeting attendance rate (manager-only data), and leader.
3. **Escalations list** with a **"Run review"** button:
   - **Rule items:** First Steps and Young Couples below the minimum; Tom's 9-day-old request.
   - **AI item #1, hidden schedule conflict:** "Marcus asked to join Sunday Lunch D-Group, which meets right after second service. He serves in the preschool room at 11:00 and may arrive 30–40 minutes late every week."
     - *How it's caught:* the review compares the request's group description with the requester's busy slots and `about_me`.
   - **AI item #2, unmet demand:** "6 moms of toddlers want weekday mornings. The only weekday-morning moms group is in Clermont, outside the 5-mile radius. Consider starting one; possible leader: Ruth Abbott (9 years here, consistent attendance, serves on the Care Team, available Tue/Wed mornings, wrote that she has walked alongside young moms)."
     - *How it's caught:* opted-in, unmatched members with zero eligible groups are grouped by available slots and life stage. Leader candidates are found by fixed rules (attendance confidence, serving, 12+ months here, slot overlap). The LLM writes the summary and picks one candidate from that list.
4. **Escalation detail:** the evidence list (the facts it was built from), with Acknowledge and Resolve.

**Data:**
- **Run review:** a server route runs the rule checks plus the two AI reviews (Sonnet), and inserts `escalation` rows with `source = 'rule'` or `'ai'` and `status = 'open'`.
- **Duplicates:** skip any escalation whose kind, group and person already has an open row.
- **Acknowledge:** `update escalation` (manager only, enforced by row-level security).

**Guardrail:** escalations are advisory. The manager decides. AI escalations store their evidence and prompt version.

---

## Journey 5 · Under the hood: audit and the two-role proof (Alan, Tom) · **video 0:45**
**Story:** show judges what the AI decided and who can see it.

**Screens:**
1. **Manager → member → "Recommendation audit":**
   - every recommendation run for that member
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
   | Rationale | ✖ | ✔ |
   | Hidden-fields panel | "Not available for your role" | Content shown |

**Data:** `app.manager_recommendation_audit()` (raises an error for non-managers).

**Guardrail:** this is the safeguards section of the write-up shown live. Screenshot both views.

---

## Journey 6 · A member already in a group (Ruth) · **video 0:10 (optional)**
**Story:** a member who already belongs to a group sees that group's details, not recommendations.
- **Screen:** "Your group": the group card, "Joined Mar 2025", the meeting time and the leader's first name.
- **Data:** her own membership plus `group_card()`.

---

## 8 · Screen inventory (brief for the v0 scaffold, mock data only)
Next.js App Router + Tailwind + shadcn/ui. **Mock data only. No database, auth or API calls.** Claude Code wires those up.

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

**Design notes for v0:**
- Calm and pastoral rather than SaaS-flashy.
- Generic labels ("Manager / Leader / Member", "group"), so it carries over outside church settings.
- Mobile-first for the member screens. Desktop table layout for the manager.

---

## 9 · Video run order (≤ 5:00)
| Segment | Time |
|---|---|
| Problem | 0:30 |
| Journey 2 (Jordan intake) | 0:45 |
| Journey 1 (Dana's pick, Marcus's request) | 1:00 |
| Journey 3 (Chris accepts Sam, Jordan's ranking shifts) | 0:45 |
| Journey 4 (Run review: conflict + unmet demand) | 1:00 |
| Journey 5 (audit + two-role clip) | 0:45 |
| How it's built and the evaluation number | 0:15 |

---

## 10 · Build order and cut line
1. Slice −1: ranking test ⭐
2. Slice 0: connection test on Vercel
3. Databricks: load the engagement tables, build `person_features` into Lakebase. *Fallback: a local Python job fills `person_features` if Databricks gets in the way.*
4. Journey 1
5. Journey 3
6. Journey 2
7. Journey 4: rule items + AI #1
8. Journey 5
9. ── **cut line if behind** ──
10. Journey 4: AI #2 (unmet demand)
11. Journey 6
12. Dashboard tile: online-first households
