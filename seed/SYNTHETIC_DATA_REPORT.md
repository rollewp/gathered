# Synthetic data report (V2)

> **Generated file. Do not edit.** Produced by `node scripts/seed_validate.mjs` from `seed/out/`; `seed/generate_seed.py` remains the source of truth. Regenerate with `npm run seed:check`.

## 1. Generator and run metadata
- **Report version:** V2 (semantic differentiation, controlled label model, offline Shortlist Recall@6).
- Generator: `seed/generate_seed.py` **v2.0 (2026-11-10)**, RNG seed **516**. Repository revision: `76a9aa4`.
- Report generated: 2026-11-11T13:03:49.753Z (report metadata, not seed content).
- Generation duration: 6.6 s and 6.4 s (two runs, measured by the determinism check). Validation duration: 16.3 s (includes the two full regenerations).
- **Lakebase and OpenRouter were not touched.** This validator reads CSV files only. It runs the generator and `git` as local processes; it opens no database connection, makes no network call and invokes no model. The development database is unchanged.
- **Observed versus expected:** everything below is an observed offline fact about the generated CSVs unless a sentence says it is a later expectation. Nothing here is a model result (see section 19).
- Features and shortlists below use the reference implementations in `lib/features/person-features.mjs` and `lib/ranking/reference-shortlist.mjs` on the CSVs in memory (as-of 2026-11-01). No database, no network, no model calls.

## 2. Result at a glance
- Checks: **209 of 209 passed**.
- Determinism: **passed.** Two consecutive generations are byte-identical across 22 files and match `seed/out`.

| Target | Actual | Range | Result |
|---|---|---|---|
| Adults (approx. 4,500) | 4559 | 4,500 | passed |
| Children (1,500 to 2,500) | 1743 | 1,500-2,500 | passed |
| Households (2,500 to 3,200) | 2598 | 2,500-3,200 | passed |
| Groups (approx. 140) | 140 | 140 | passed |
| Active group memberships (900 to 1,400) | 1039 | 900-1,400 | passed |
| Recommendation-ready profiles (1,200 to 2,000) | 1571 | 1,200-2,000 | passed |
| Profile adoption (30 to 45 percent of adults) | 34.5% | 30-45% | passed |
| Weekly worship services (6 to 10) | 8 | 6-10 | passed |
| Engagement history (52 weeks) | 52 | 52 | passed |
| Evaluation scenarios (approx. 28) | 29 | 28 | passed |
| Dana: broadly eligible groups (15 to 25) | 24 | 15-25 | passed |
| Dana: groups passing every hard filter (8 to 15) | 11 | 8-15 | passed |
| Dana: presented recommendations | 3 (shortlist of up to 6, architecture) | 3 | passed |
| RNG seed 516 | 516 | 516 | passed |


## 3. File inventory
| File | Rows | Size |
|---|---|---|
| `_truth_group.csv` | 140 | 14 KB |
| `_truth_household.csv` | 2598 | 252 KB |
| `_truth_person.csv` | 4559 | 308 KB |
| `attendance_event.csv` | 72455 | 8528 KB |
| `audit_log.csv` | 0 | 0 KB |
| `escalation.csv` | 0 | 0 KB |
| `eval_label.csv` | 29 | 11 KB |
| `group_leader.csv` | 140 | 13 KB |
| `group_meeting.csv` | 5066 | 425 KB |
| `group_membership.csv` | 1098 | 113 KB |
| `group_tag.csv` | 318 | 15 KB |
| `grp.csv` | 140 | 57 KB |
| `household.csv` | 2598 | 187 KB |
| `join_request.csv` | 88 | 15 KB |
| `meeting_attendance.csv` | 30943 | 2425 KB |
| `member_profile.csv` | 1571 | 329 KB |
| `ministry.csv` | 6 | 0 KB |
| `person.csv` | 6302 | 713 KB |
| `portal_user.csv` | 9 | 1 KB |
| `service.csv` | 416 | 40 KB |
| `serving_assignment.csv` | 566 | 62 KB |

Total: 13.2 MB. `personas.json` is the persona picker input. `_truth_*.csv` are validation controls and are never loaded.

## 4. Population
| Measure | Value |
|---|---|
| Adults | 4559 |
| Children | 1743 |
| Households | 2598 |
| People | 6302 |
| Adults with a profile | 1571 (34.5%) |
| Detailed profiles (free text and interests) | 463 |
| Sparse profiles (missing preference or interests) | 320 |
| Adults with engagement signals in the history | 2372 |

**Adult age bands**

| Age band | Count | Share |
|---|---|---|
| 30-39 | 1307 | 28.7% |
| 40-49 | 891 | 19.5% |
| 23-29 | 826 | 18.1% |
| 50-59 | 575 | 12.6% |
| 60-69 | 392 | 8.6% |
| 70+ | 317 | 7.0% |
| 18-22 | 251 | 5.5% |

**Household types**

| Archetype | Count | Share |
|---|---|---|
| single_adult | 605 | 23.3% |
| retired | 303 | 11.7% |
| couple_school_age | 296 | 11.4% |
| couple_young_kids | 265 | 10.2% |
| empty_nest | 199 | 7.7% |
| single_parent | 194 | 7.5% |
| housemates | 173 | 6.7% |
| couple_teens | 167 | 6.4% |
| couple_no_kids | 153 | 5.9% |
| young_adult_w_parents | 141 | 5.4% |
| multigenerational | 52 | 2.0% |
| named | 50 | 1.9% |

**Church tenure**

| Tenure band | Count | Share |
|---|---|---|
| established (3-10 yr) | 1437 | 31.5% |
| 1-3 years | 1106 | 24.3% |
| long-tenured (10+ yr) | 943 | 20.7% |
| under 1 year | 427 | 9.4% |
| recent attendee (3-6 mo) | 319 | 7.0% |
| recent visitor (1-3 mo) | 194 | 4.3% |
| first-time (<1 mo) | 133 | 2.9% |

**Households by ZIP** (synthetic centroid + jitter)

| ZIP | Count | Share |
|---|---|---|
| 34787 | 960 | 37.0% |
| 34761 | 565 | 21.7% |
| 34786 | 454 | 17.5% |
| 34711 | 448 | 17.2% |
| 34734 | 171 | 6.6% |

**Households by home campus**

| Campus | Count | Share |
|---|---|---|
| WG | 960 | 37.0% |
| OC | 651 | 25.1% |
| WM | 591 | 22.7% |
| CL | 396 | 15.2% |


## 5. Group catalog
| Measure | Value |
|---|---|
| Groups | 140 |
| Leaders (distinct) | 140 |
| Group tags | 318 |

**By family**

| Family | Count | Share |
|---|---|---|
| mens | 13 | 9.3% |
| womens | 13 | 9.3% |
| bible_study | 12 | 8.6% |
| young_adult | 12 | 8.6% |
| young_family | 10 | 7.1% |
| couples | 9 | 6.4% |
| foundational | 9 | 6.4% |
| forming | 7 | 5.0% |
| interest | 7 | 5.0% |
| online | 6 | 4.3% |
| parenting | 6 | 4.3% |
| prayer | 6 | 4.3% |
| empty_nest | 5 | 3.6% |
| hybrid | 5 | 3.6% |
| mature_adult | 5 | 3.6% |
| recovery | 5 | 3.6% |
| serving | 5 | 3.6% |
| theology | 5 | 3.6% |

**By status**

| Status | Count | Share |
|---|---|---|
| open | 112 | 80.0% |
| full | 12 | 8.6% |
| closed | 7 | 5.0% |
| forming | 7 | 5.0% |
| multiplying | 2 | 1.4% |

**By format** (the schema has `is_online` only; hybrid groups are in-person with a video link and are subject to the distance rule)

| Format | Count | Share |
|---|---|---|
| in_person | 129 | 92.1% |
| online | 6 | 4.3% |
| hybrid | 5 | 3.6% |

**By campus / ministry location** (derived from the leader's household; the schema has no campus column)

| Campus | Count | Share |
|---|---|---|
| WG | 58 | 41.4% |
| CL | 39 | 27.9% |
| OC | 30 | 21.4% |
| WM | 13 | 9.3% |

**By meeting slot**

| Slot | Count | Share |
|---|---|---|
| thu_eve | 27 | 19.3% |
| sat_am | 26 | 18.6% |
| sun_pm | 26 | 18.6% |
| tue_eve | 26 | 18.6% |
| wed_eve | 19 | 13.6% |
| mon_eve | 11 | 7.9% |
| tue_am | 2 | 1.4% |
| wed_am | 2 | 1.4% |
| sun_9 | 1 | 0.7% |

**By capacity band**

| Capacity | Count | Share |
|---|---|---|
| 11-16 | 62 | 44.3% |
| 6-10 | 59 | 42.1% |
| 17-30 | 19 | 13.6% |

**By meeting frequency**

| Frequency | Count | Share |
|---|---|---|
| weekly | 113 | 80.7% |
| biweekly | 17 | 12.1% |
| monthly | 10 | 7.1% |


## 6. Membership and occupancy
| Measure | Value |
|---|---|
| Active memberships | 1039 |
| Historical memberships (left) | 59 |
| Join requests (all statuses) | 88 |
| Pending requests | 4 |

**Occupancy**

| Occupancy | Count | Share |
|---|---|---|
| healthy | 81 | 57.9% |
| under-enrolled | 24 | 17.1% |
| nearly full | 16 | 11.4% |
| full | 12 | 8.6% |
| empty | 4 | 2.9% |
| below minimum | 3 | 2.1% |

**Active group memberships per adult**

| Memberships | Count | Share |
|---|---|---|
| 0 | 3520 | 77.2% |
| 1 | 1039 | 22.8% |

**Groups per leader**

| Groups led | Count | Share |
|---|---|---|
| 1 | 140 | 100.0% |

**Eligible-group reach of opted-in members who are not in a group** (groups passing every hard filter)

| Eligible groups | Count | Share |
|---|---|---|
| 11+ | 689 | 73.9% |
| 6-10 | 195 | 20.9% |
| 3-5 | 31 | 3.3% |
| 1-2 | 11 | 1.2% |
| 0 | 6 | 0.6% |


## 7. Engagement history (52 weeks from 2025-11-05 to 2026-11-01)
| Measure | Value |
|---|---|
| Weekly services | 8 (Sunday ×7, Wednesday night ×1, across 4 campuses plus online) |
| Service rows | 416 |
| Attendance signal events | 72455 |
| Group meetings | 5066 |
| Group meeting attendance rows | 30943 |
| Serving assignments | 566 |

**Signals by channel**

| Channel | Count | Share |
|---|---|---|
| app_geofence | 29369 | 40.5% |
| kiosk | 25799 | 35.6% |
| livestream | 8938 | 12.3% |
| serving_roster | 8349 | 11.5% |

**Attendance patterns** (household level)

| Pattern | Count | Share |
|---|---|---|
| weekly | 621 | 23.9% |
| twice_monthly | 360 | 13.9% |
| monthly | 298 | 11.5% |
| mixed_online | 213 | 8.2% |
| sparse | 190 | 7.3% |
| online_first | 152 | 5.9% |
| seasonal | 151 | 5.8% |
| declining | 140 | 5.4% |
| interrupted | 111 | 4.3% |
| rising | 106 | 4.1% |
| concentrated_wed | 96 | 3.7% |
| returning | 94 | 3.6% |
| new_visit | 33 | 1.3% |
| none | 33 | 1.3% |

**Online participation**

| Mode | Count | Share |
|---|---|---|
| in_person | 2109 | 81.2% |
| hybrid | 337 | 13.0% |
| online_only | 152 | 5.9% |


## 8. Evaluation suite (29 scenarios, V2 label model)
The label file adds `expectation`, `semantic_contrast` and `contrast_group_ids` to the V1 columns (`purpose`, `outcome_type`, `excluded_group_ids`, `scenario_family`). `outcome_type` is a controlled vocabulary with exactly one execution behavior each (`lib/seed/eval-labels.mjs`); `expectation` (`top1`, `top1_or_alternates`, `top3`) says how strictly a ranking scenario is judged.

| Outcome type | Scenarios | Executed as |
|---|---|---|
| ranking | 25 | deterministic shortlist and LLM ranking |
| empty | 1 | deterministic only (no survivors expected) |
| excluded | 1 | deterministic only (excluded groups absent) |
| duplicate_pending | 1 | policy only (request blocked) |
| active_member | 1 | policy only (never matched) |

**By scenario family**

| Scenario family | Count | Share |
|---|---|---|
| existing | 14 | 48.3% |
| capacity-constrained best match | 1 | 3.4% |
| childcare as a decisive requirement | 1 | 3.4% |
| couple versus individual preference | 1 | 3.4% |
| duplicate pending join request | 1 | 3.4% |
| existing active membership | 1 | 3.4% |
| forming-group opportunity, no engagement history | 1 | 3.4% |
| geographic tradeoff | 1 | 3.4% |
| intentionally empty recommendation | 1 | 3.4% |
| mixed online and in-person, multiple campuses | 1 | 3.4% |
| online-first behavior | 1 | 3.4% |
| returning after disengagement | 1 | 3.4% |
| serving schedule conflict | 1 | 3.4% |
| sparse engagement history | 1 | 3.4% |
| stated preference versus observed behavior | 1 | 3.4% |
| strong schedule constraint | 1 | 3.4% |

**Original-label preservation:** 14 of 14 original labels are present with their original member, expected group and accepted alternates (checked against `seed/stable_ids.json`). They are all `ranking` labels with `top1` or `top1_or_alternates`. V2 corrected five added (non-original) labels whose `top1_or_alternates` declaration named no reachable alternate (e13, e18, e19, e22, e23); they are now `top1`.

| Label | Scenario family | Outcome type | Defensible | Detail |
|---|---|---|---|---|
| e01 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e02 | existing | ranking | yes | passes filters; expected at shortlist rank 4 of 6 |
| e03 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e04 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e05 | existing | ranking | yes | passes filters; expected at shortlist rank 3 of 6 |
| e06 | existing | ranking | yes | passes filters; expected at shortlist rank 2 of 6 |
| e07 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e08 | existing | ranking | yes | passes filters; expected at shortlist rank 2 of 6 |
| e09 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6; accepted alternates present 1/1 |
| e10 | existing | ranking | yes | passes filters; expected at shortlist rank 5 of 6 |
| e11 | existing | ranking | yes | passes filters; expected at shortlist rank 4 of 6; accepted alternates present 1/1 |
| e12 | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| persona | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| persona | existing | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e13 | sparse engagement history | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e15 | stated preference versus observed behavior | ranking | yes | passes filters; expected at shortlist rank 2 of 6 |
| e16 | capacity-constrained best match | ranking | yes | passes filters; expected at shortlist rank 1 of 6; excluded absent true |
| e17 | geographic tradeoff | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e18 | strong schedule constraint | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e19 | childcare as a decisive requirement | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e20 | online-first behavior | ranking | yes | passes filters; expected at shortlist rank 4 of 6 |
| e21 | mixed online and in-person, multiple campuses | ranking | yes | passes filters; expected at shortlist rank 5 of 6 |
| e22 | returning after disengagement | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e23 | couple versus individual preference | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| e24 | serving schedule conflict | excluded | yes | excluded group(s) absent from survivors and shortlist: true; 9 survivors remain |
| e25 | duplicate pending join request | duplicate_pending | yes | pending request exists |
| e27 | forming-group opportunity, no engagement history | ranking | yes | passes filters; expected at shortlist rank 1 of 6 |
| persona_priya | intentionally empty recommendation | empty | yes | survivors=0 |
| persona_ruth | existing active membership | active_member | yes | active member (never matched) |

## 9. Shortlist Recall@6 (offline, observed)
The deterministic stage is the same reference module the app is tested against (`lib/ranking/reference-shortlist.mjs`) running on the generated CSVs in memory; no database behavior is approximated. Features come from `lib/features/person-features.mjs`. Limitation: the production shortlist is `app.recommendation_shortlist()` over `person_features` computed in the database; parity with the reference is verified by `npm run test:recommendations` **after** the load, not here.

- **Shortlist Recall@6 (expected group on the six-group shortlist): 25 of 25 ranking scenarios (100%).**
- Expected or accepted group present: 25 of 25.
- Accepted alternates present on the shortlist: 2 of 2 scenarios that declare alternates.
- Excluded groups absent from survivors and shortlist: 2 of 2 scenarios that declare exclusions.

| Scenario | Expectation | Expected group | Rank on shortlist | Accepted alternates present | Excluded groups absent | Survivors |
|---|---|---|---|---|---|---|
| e01 | top1 | Deep Roots | 1 | n/a | n/a | 12 |
| e02 | top1 | Thursday Women in the Word | 4 | n/a | n/a | 11 |
| e03 | top1 | Midweek Prayer & Worship | 1 | n/a | n/a | 12 |
| e04 | top1 | First Steps | 1 | n/a | n/a | 12 |
| e05 | top1 | Online Thursday Study | 3 | n/a | n/a | 15 |
| e06 | top1 | Sunday Supper Families | 2 | n/a | n/a | 23 |
| e07 | top1 | Men of Iron | 1 | n/a | n/a | 26 |
| e08 | top1 | Tuesday Men's Accountability | 2 | n/a | n/a | 24 |
| e09 | top1_or_alternates | Tuesday Night Dads | 1 | 1/1 | n/a | 23 |
| e10 | top1 | Sunday Lunch D-Group | 5 | n/a | n/a | 23 |
| e11 | top1_or_alternates | New Men's D-Group (forming) | 4 | 1/1 | n/a | 23 |
| e12 | top1 | Deep Roots | 1 | n/a | n/a | 14 |
| persona (Marcus) | top1 | Tuesday Night Dads | 1 | n/a | n/a | 23 |
| persona (Dana) | top1 | First Steps | 1 | n/a | n/a | 11 |
| e13 | top1 | Sunday Supper Families | 1 | n/a | n/a | 21 |
| e15 | top1 | Thursday Twenties | 2 | n/a | n/a | 13 |
| e16 | top1 | Saturday Early Men's Prayer Breakfast | 1 | n/a | yes | 11 |
| e17 | top3 | Women of the Word | 1 | n/a | n/a | 12 |
| e18 | top1 | Saturday Morning Coffee & Scripture | 1 | n/a | n/a | 9 |
| e19 | top1 | Wednesday Moms & Babies (Childcare Provided) | 1 | n/a | n/a | 34 |
| e20 | top1 | Online Thursday Study | 4 | n/a | n/a | 23 |
| e21 | top3 | Winter Garden Hybrid Study | 5 | n/a | n/a | 23 |
| e22 | top1 | Coming Back Table | 1 | n/a | n/a | 10 |
| e23 | top1 | Young Couples | 1 | n/a | n/a | 14 |
| e27 | top3 | New Women's D-Group (forming) | 1 | n/a | n/a | 20 |

## 10. Policy and exclusion scenarios (never sent to LLM ranking)
| Scenario | Outcome type | Result | Observed |
|---|---|---|---|
| e24 | excluded | pass | excluded group(s) absent from survivors and shortlist: true; 9 survivors remain |
| e25 | duplicate_pending | pass | pending request exists |
| persona_priya | empty | pass | survivors=0 |
| persona_ruth | active_member | pass | active member (never matched) |

These are checked deterministically and by policy tests only; `scripts/rank_eval.mjs` skips them and reports the count.

## 11. Semantic-differentiation scenarios (11 selected)
Intent: after hard eligibility and structured scoring, an informed human can explain why one shortlisted group is better than another from the member's confirmed words and the group descriptions. There is **no** required score gap; close scores are acceptable. Each scenario below has its expected group on the shortlist, at least two credible alternatives on the same shortlist, distinct descriptions, and no sensitive claims for a model to infer.

| Scenario | Family | Expected group | Expected rank on shortlist | Contrast groups on shortlist | Result |
|---|---|---|---|---|---|
| e01 | existing | Deep Roots | 1 of 6 | 3/3: First Steps, Thursday Twenties, Online Thursday Study | pass |
| e02 | existing | Thursday Women in the Word | 4 of 6 | 3/3: First Steps, Thursday Twenties, Online Thursday Study | pass |
| e04 | existing | First Steps | 1 of 6 | 3/3: Thursday Twenties, Online Thursday Study, New Group: Thursday Families | pass |
| e05 | existing | Online Thursday Study | 3 of 6 | 3/3: First Steps, Thursday Twenties, New Group: Thursday Families | pass |
| e06 | existing | Sunday Supper Families | 2 of 6 | 3/3: Tuesday Night Dads, Early Riser Men, Sunday Lunch D-Group | pass |
| e08 | existing | Tuesday Men's Accountability | 2 of 6 | 4/4: Fearless Parenting, Online Parent Circle, Winter Garden Hybrid Study, Wednesday Intercessors | pass |
| e11 | existing | New Men's D-Group (forming) | 4 of 6 | 3/3: Tuesday Night Dads, New Group: Young Couples Dinner, Kids in Tow | pass |
| persona (Dana) | existing | First Steps | 1 of 6 | 5/5: Thursday Twenties, Thursday Women in the Word, Online Thursday Study, Deep Roots, New Group: Thursday Families | pass |
| e15 | stated preference versus observed behavior | Thursday Twenties | 2 of 6 | 3/3: Online Thursday Study, First Steps, New Group: Thursday Families | pass |
| e20 | online-first behavior | Online Thursday Study | 4 of 6 | 3/3: Thursday Twenties, First Steps, Deep Roots | pass |
| e22 | returning after disengagement | Coming Back Table | 1 of 6 | 3/3: Questions Welcome, New Group: Wednesday Study, Grief & Hope Circle | pass |

## 12. Named personas
| Persona | Role | Stable id | Household | Profile | Active groups | Pending | Signals (12 wk obs / confidence) |
|---|---|---|---|---|---|---|---|
| Dana Ruiz | member | `0bd3f98c…` | 34786 | yes | 0 | 0 | 10 events: app_geofence:10; 7 wks, high |
| Marcus Hale | member | `511b34cf…` | 34787, 2 kids | yes | 0 | 0 | 113 events: serving_roster:51 kiosk:62; 12 wks, high |
| Priya Shah | member | `058a6b1b…` | 34761, 2 kids | yes | 0 | 0 | 49 events: app_geofence:26 kiosk:14 livestream:9; 7 wks, high |
| Jordan Pike | member | `ee0b516c…` | 34787, 2 kids | no | 0 | 0 | 1 events: livestream:1; 1 wks, medium |
| Ruth Abbott | member | `4014ea76…` | 34787 | yes | 1 | 0 | 95 events: serving_roster:28 app_geofence:67; 12 wks, high |
| Alan Whitfield | manager | `f017cdc0…` | 34787, 2 kids | no | 0 | 0 | 31 events: kiosk:31; 7 wks, high |
| Tom Brennan | leader | `a610aff4…` | 34787, 2 kids | no | 0 (leads 1) | 0 | 66 events: serving_roster:22 kiosk:44; 8 wks, high |
| Grace Okafor | leader | `de492182…` | 34761, 2 kids | no | 0 (leads 1) | 0 | 47 events: serving_roster:47; 11 wks, high |
| Chris Delgado | leader | `d82ec3d1…` | 34787, 2 kids | no | 0 (leads 1) | 0 | 62 events: kiosk:62; 6 wks, high |
| Sam Whitaker | member (not a landing persona) | `816071ae…` | 34787, 2 kids | yes | 0 | 1 | 59 events: app_geofence:35 kiosk:24; 12 wks, high |

Stable-id check: every persona, portal user, named group, original evaluation label and original join-request id matches `seed/stable_ids.json` (66/66 identity checks passed).

## 13. Candidate funnel (reference implementation, offline)
| Persona | Catalog | Open with a seat | Gender fit | Broadly eligible (≤5 mi or online) | Pass every hard filter | Shortlist (≤6) |
|---|---|---|---|---|---|---|
| Dana Ruiz | 140 | 119 | 105 | 24 | 11 | 6 |
| Marcus Hale | 140 | 119 | 98 | 58 | 23 | 6 |
| Priya Shah | 140 | 119 | 105 | 54 | 0 | 0 |
| Jordan (after intake: young_kids, tue/thu eve, men) | 140 | 119 | 98 | 57 | 23 | 6 |

## 14. Dana: funnel and semantic contrast
**Observed funnel:** catalog 140 → open with a seat 119 → gender fit 105 → **broadly eligible 24** → **pass every hard filter 11** → shortlist 6 → three presented later (by the model, not run). The architecture caps the shortlist at 6; the design's "8 to 15" is read as the hard-filter survivors.

**Deterministic shortlist** (2.4 points between #1 and #2, 3.6 between #1 and #3; close scores are acceptable and nothing was tuned to widen them):

| # | Group | Score | Life stage | Kids age | Serving | Consistency (neutral) | Interests | Distance | Status | Slot | Format |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | First Steps | 56.1 | 30.0 | 0.0 | 0.0 | 7.5 | 10.0 | 8.6 | open | wed_eve | in_person |
| 2 | Thursday Twenties | 53.8 | 30.0 | 0.0 | 0.0 | 7.5 | 10.0 | 6.3 | open | thu_eve | in_person |
| 3 | Online Thursday Study | 52.5 | 30.0 | 0.0 | 0.0 | 7.5 | 10.0 | 5.0 | open | thu_eve | online |
| 4 | Thursday Women in the Word | 51.5 | 30.0 | 0.0 | 0.0 | 7.5 | 10.0 | 4.0 | open | thu_eve | in_person |
| 5 | New Group: Thursday Families | 48.6 | 30.0 | 0.0 | 0.0 | 7.5 | 10.0 | 1.1 | forming | thu_eve | in_person |
| 6 | Deep Roots | 46.0 | 30.0 | 0.0 | 0.0 | 7.5 | 0.0 | 8.5 | open | wed_eve | in_person |

**Member narrative supplied to ranking** (`memberPayload`, prompt `rank-v2`: life stage, preference, interests, own words; no name, attendance or address):

```json
{
  "life_stage": "single",
  "group_pref": "mixed",
  "interests": [
    "bible_reading",
    "new_to_faith",
    "prayer"
  ],
  "about_me": "Moved here for work in September. I grew up going to church but never really read the Bible on my own, and I feel a little behind the people around me. I'd like to start, with people who won't judge my questions."
}
```

**Candidate descriptions supplied to ranking** (shortlist order; the depth and preparation labels come from the generator's validation-only metadata and are **not** sent to the model, only the description text is):

1. **First Steps** (open, wed_eve, intro depth, none preparation): A slow walk through the Gospel of John for people who are new to faith or coming back to it. Questions are welcome. No homework, no experience needed, and no one is put on the spot. Each week starts with the basics, so nobody needs to have read the earlier chapters or to know their way around the Bible.
2. **Thursday Twenties** (open, thu_eve, steady depth, light preparation): Singles in their twenties and early thirties. Dinner, a book of the Bible, and real friendship. Most of us grew up in church and already know our way around Scripture, so the conversation moves quickly and assumes some familiarity with the Bible.
3. **Online Thursday Study** (open, thu_eve, steady depth, light preparation): An online video study for people who travel, work shifts, or mostly join services by livestream. Cameras optional. Everyone joins by video, so there is no driving and no hosting. Members read the week's passage on their own and use the call to compare notes, which suits people who are comfortable studying independently.
4. **Thursday Women in the Word** (open, thu_eve, deep depth, moderate preparation): Young professional women reading one book of the Bible each month at a brisk pace, with memory-verse goals. Members finish the week's reading and memorize the verse before we meet; someone who has not read the book yet will feel behind.
5. **New Group: Thursday Families** (forming, thu_eve, intro depth, light preparation): A brand-new group launching this winter. Come help shape how we meet. Meets in a leader's home in the Winter Garden area. Structured: prayer, discussion, then a short application time. No prior Bible knowledge is assumed, and basic questions are welcome. About fifteen minutes of reading before we meet. The first weeks are for getting to know each other, and the study plan is still being decided.
6. **Deep Roots** (open, wed_eve, intensive depth, heavy preparation): Women working chapter by chapter through a systematic theology text. Weekly reading and discussion questions; best for those who have studied the Bible for years. Expect several hours of reading and written notes every week, and a lot of independent work between meetings.

**Intended semantic distinction (human-readable, not a model output):** First Steps is the only shortlisted group that expects no prior experience and says that questions are welcome and nobody is put on the spot. Thursday Twenties assumes some familiarity with Scripture; Thursday Women in the Word expects the reading done and the verse memorized; Online Thursday Study is independent study on a call; the forming group has no track record yet; Deep Roots is an advanced study with heavy weekly preparation. All are eligible on schedule, distance and seats; only one matches how she describes herself.

**Why this is not a scripted outcome:** there is no Dana-specific branch, score or exclusion. Her profile is the same row any member would have; her preference is `mixed`, so women-only groups remain eligible. Every alternative above passes the same hard filters. The generator's only V2 change for her is the text: her own words now say she feels a little behind, and group descriptions state who each group assumes it is talking to. Whether a model orders them as a human would is **not known** until the live evaluation.

Marcus: 1. Tuesday Night Dads (91.5) | 2. Sunday Lunch D-Group (75.5) | 3. Sunday Supper Families (73.9) | 4. Early Riser Men (69.5) | 5. Online Prayer Night (66.5) | 6. Tuesday Men's Accountability (61.3)

Jordan after the Journey 2 intake text (hypothetical, nothing stored): 1. Tuesday Night Dads (76.3) | 2. New Group: Young Couples Dinner (64.7) | 3. Tuesday Men's Accountability (60.1) | 4. New Men's D-Group (forming) (57.1) | 5. Wise Parents Workshop (55.4) | 6. Board Games & Faith (40.4)

### Other semantic scenarios
#### e01 — existing
- **Member says:** "I've read theology for years and want women who will push me on doctrine. Homework is fine."
- **Expected:** Deep Roots (top1)
- **Why an informed reviewer prefers it:** Years of reading and a request for doctrine: Deep Roots is the advanced systematic study; First Steps is pitched at newcomers and Thursday Twenties at a moderate pace.
- **Deterministic shortlist:** 1. Deep Roots (55.4); 2. Online Thursday Study (52.5); 3. First Steps (47.0); 4. Thursday Twenties (44.0); 5. Thursday Women in the Word (41.4); 6. New Group: Thursday Families (39.8)

#### e02 — existing
- **Member says:** "I want to memorize Scripture and move quickly. I'm disciplined and I love a reading plan."
- **Expected:** Thursday Women in the Word (top1)
- **Why an informed reviewer prefers it:** Wants to memorize Scripture and move quickly: Thursday Women in the Word is the brisk memory-verse group; First Steps is gentle and Thursday Twenties is a dinner-and-friendship group.
- **Deterministic shortlist:** 1. First Steps (56.3); 2. Thursday Twenties (53.7); 3. Online Thursday Study (52.5); 4. Thursday Women in the Word (51.7); 5. New Group: Thursday Families (48.9); 6. Deep Roots (45.7)

#### e04 — existing
- **Member says:** "Not sure what I believe yet. A friend invited me and I have a lot of questions."
- **Expected:** First Steps (top1)
- **Why an informed reviewer prefers it:** A seeker with a lot of questions: First Steps welcomes basic questions, while Thursday Twenties assumes familiarity with Scripture and Online Thursday Study is independent study.
- **Deterministic shortlist:** 1. First Steps (56.2); 2. Thursday Twenties (43.4); 3. Online Thursday Study (42.5); 4. New Group: Thursday Families (40.4); 5. The Common Table (38.0); 6. Coming Back Table (17.8)

#### e05 — existing
- **Member says:** "I travel for work half the month, so I'd need to join from wherever I am."
- **Expected:** Online Thursday Study (top1)
- **Why an informed reviewer prefers it:** Needs to join from wherever she is: Online Thursday Study is the only shortlisted group that is entirely on video; the others are hosted in a home.
- **Deterministic shortlist:** 1. First Steps (56.2); 2. Thursday Twenties (54.9); 3. Online Thursday Study (52.5); 4. New Group: Thursday Families (51.1); 5. Thursday Women in the Word (50.0); 6. The Common Table (48.1)

#### e06 — existing
- **Member says:** "My wife and I want to do this together, and our kids need to be included somehow."
- **Expected:** Sunday Supper Families (top1)
- **Why an informed reviewer prefers it:** Wants the whole family included: Sunday Supper Families is for families together with the kids; Tuesday Night Dads, Early Riser Men and Sunday Lunch D-Group are men-only or adult-only.
- **Deterministic shortlist:** 1. Tuesday Night Dads (76.7); 2. Sunday Supper Families (74.4); 3. Early Riser Men (69.5); 4. Newlywed Group (68.9); 5. Sunday Lunch D-Group (65.3); 6. Wise Parents Workshop (56.9)

#### e08 — existing
- **Member says:** "There are some things I need to confess to other men. I need accountability, not a lecture."
- **Expected:** Tuesday Men's Accountability (top1)
- **Why an informed reviewer prefers it:** Asks for accountability, not a lecture: Tuesday Men's Accountability is a committed, confidential men's group; the other shortlisted Tuesday options are parents' groups, a mixed hybrid study and a casual prayer-and-walk group.
- **Deterministic shortlist:** 1. Fearless Parenting (74.4); 2. Tuesday Men's Accountability (61.1); 3. Online Parent Circle (57.5); 4. Winter Garden Hybrid Study (50.8); 5. Wednesday Intercessors (49.5); 6. Online Prayer Night (49.5)

#### e11 — existing
- **Member says:** "New dad. I'd like to start something fresh with other young dads."
- **Expected:** New Men's D-Group (forming) (top1_or_alternates; accepted: Tuesday Night Dads)
- **Why an informed reviewer prefers it:** Wants to start something fresh with other young dads: the forming men's group has no routine yet and invites its first members to set the pace; Tuesday Night Dads is established, and the other forming and family groups are mixed.
- **Deterministic shortlist:** 1. Tuesday Night Dads (77.2); 2. Kids in Tow (67.6); 3. New Group: Young Couples Dinner (65.4); 4. New Men's D-Group (forming) (56.8); 5. Wise Parents Workshop (56.1); 6. Tuesday Men's Accountability (50.9)

#### e15 — stated preference versus observed behavior
- **Member says:** "I've mostly watched online but I'm tired of screens. I want a real in-person group on a weeknight, near Windermere."
- **Expected:** Thursday Twenties (top1)
- **Why an informed reviewer prefers it:** Wants an in-person weeknight group after too much screen time: Thursday Twenties meets in a home; Online Thursday Study is video-only; First Steps is pitched at newcomers.
- **Deterministic shortlist:** 1. First Steps (56.1); 2. Thursday Twenties (54.6); 3. Online Thursday Study (52.5); 4. New Group: Thursday Families (51.3); 5. The Common Table (48.4); 6. Online Wednesday Bible (25.5)

#### e20 — online-first behavior
- **Member says:** "I watch services online and I like it that way. I'd like a group I can join from my couch."
- **Expected:** Online Thursday Study (top1)
- **Why an informed reviewer prefers it:** Prefers to participate from home: Online Thursday Study is video-only and self-paced; the other shortlisted groups meet in a leader's home.
- **Deterministic shortlist:** 1. First Steps (55.8); 2. Thursday Twenties (55.2); 3. Deep Roots (54.7); 4. Online Thursday Study (52.5); 5. New Group: Thursday Families (51.3); 6. New Women's D-Group (forming) (51.1)

#### e22 — returning after disengagement
- **Member says:** "I stepped away from church for a couple of years after we moved. I'd like to ease back in with no pressure."
- **Expected:** Coming Back Table (top1)
- **Why an informed reviewer prefers it:** Returning after time away and wants no pressure: Coming Back Table is built for that; Questions Welcome assumes a seeker, the forming group has no history and Grief & Hope Circle is a recovery group.
- **Deterministic shortlist:** 1. Coming Back Table (55.6); 2. New Group: Wednesday Study (51.3); 3. Questions Welcome (36.3); 4. Grief & Hope Circle (35.3); 5. Wednesday Moms & Babies (Childcare Provided) (24.6); 6. The Well Table (21.0)

## 15. Referential integrity, rules and loader compatibility
| Area | Passed | Total |
|---|---|---|
| identity | 66 | 66 |
| integrity | 38 | 38 |
| loader | 21 | 21 |
| schema | 5 | 5 |
| rules | 15 | 15 |
| determinism | 2 | 2 |
| personas | 12 | 12 |
| fixtures | 3 | 3 |
| labels | 3 | 3 |
| evaluation | 31 | 31 |
| semantic | 13 | 13 |

All integrity, schema and rule checks passed.

## 16. Target-range exceptions
None. Every approved target passed.

## 17. Warnings, design compromises and schema limitations
- **Campuses:** the schema has no campus column. Campuses shape services (4 ministry locations plus an online gathering), which service a household attends, and where leaders live. A group's campus is derived from its leader's household and is recorded only in `_truth_group.csv`, which is never loaded.
- **Shortlist size:** the architecture caps the shortlist at 6, the design asks for 8 to 15. The generator provides 8 to 15 hard-filter survivors for Dana; the shortlist is unchanged.
- **Paused groups** are not representable (status allows forming, open, full, closed, multiplying); closed groups stand in.
- **Hybrid groups** are in-person with a video link; `is_online` is false so the 5-mile rule applies.
- **Weekday-morning groups** exist only at the Clermont location, so the toddler-mom cohort (Priya and five others) is unserved by design (escalation story, Journey 4).
- **Join-request deciders:** accepted/declined history has no `decided_by` because only the 9 personas are portal users.
- **Roles that differ from the design text:** the Design doc (9.2, 9.4) describes Marcus as a leader and Jordan as an existing-membership case. Demo Journeys and `personas.json` define Marcus as a member and Jordan as a new attender with no profile, and the design (9.7) requires preserving portal roles, so the canonical roles were kept.
- **Dana's group preference:** `mixed` (changed from "women" in the first refactor). The women-only value contradicted the canonical expected pick; Demo Journeys never has her ask for a women's group. V2 keeps `mixed`.
- **Men's Accountability** keeps no declared life stage (its canonical description names none); its balanced roster is what scores it. V2 did not alter that.
- **Journey 3 leader personas remain unresolved.** Only Tom, Grace and Chris are persona leaders. The leaders of First Steps and Sunday Lunch D-Group, for example, are not portal personas, so a join request to those groups cannot be viewed from a leader persona. This is a separate decision for the project owner; V2 did not add leader personas.
- **Validation-only metadata is not an application feature:** campus, group format, depth and preparation live in `_truth_group.csv` (never loaded) and are used only to validate the data and to annotate this report.
- **Generated files in git:** 13.2 MB of CSV.

## 18. Known limitations that need the later Lakebase load
- Parity between the reference shortlist and the database function `app.recommendation_shortlist()` over the database-computed `person_features` is **not yet verified** for the expanded data; it is checked by `npm run test:recommendations` after the load.
- The development database still holds the previous seed. Running the database-dependent tests before the load would compare old state with new expectations.
- `docs/Gathered - Data Model & Architecture.md` §9 still states the v0.2 sizes; update it only after the expanded data is approved and loaded.

## 19. Not yet known (requires a model run)
- LLM Top-1, Top-3, stability and fallback rate on the 25 ranking scenarios. `scripts/rank_eval.mjs` is prepared to report them separately; it was **not run**, and no model was called.
- Whether the model orders Dana's shortlist as a human reviewer would (First Steps first). The data now gives a reviewer the evidence; whether the model uses it is a live-evaluation result.

## 20. Readiness for the load-and-evaluate increment
**Ready for review.** All offline checks pass. Remaining steps, none of which were started:
1. Review this report and approve the expanded dataset.
2. Load with `npm run seed:reset` (recomputes `person_features`), then run `npm test` (the scripts are already prepared for the 29-label set).
3. Run `scripts/rank_eval.mjs` explicitly (real OpenRouter calls) and record Top-1, Top-3, stability and fallbacks.
4. Update Architecture §9 sizes after a successful load.
