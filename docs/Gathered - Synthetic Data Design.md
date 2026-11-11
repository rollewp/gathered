# Gathered: Synthetic Data Design

## 1. Purpose

The Gathered synthetic dataset represents a large, multi-campus church with enough people, groups, engagement history, and overlapping opportunities to demonstrate why an AI-assisted recommendation system is useful.

The dataset must demonstrate a problem that cannot be addressed adequately through simple filtering alone. A small church with a limited group catalog could reasonably rely on basic filters, staff familiarity, pastoral judgment, manual review, and direct conversation. Gathered is intended for organizations operating at a scale where those approaches remain valuable but are no longer sufficient by themselves.

The synthetic data must demonstrate how Gathered combines:

1. deterministic eligibility and policy rules
2. geographic, schedule, capacity, and life-stage constraints
3. stated member preferences
4. observed engagement and attendance signals
5. contextual LLM ranking among credible candidates
6. explainability, auditability, and human control

The dataset is a product-demonstration and evaluation asset, not merely a collection of database fixtures.

---

## 2. Layered Recommendation Design

Gathered uses three distinct decision layers. The synthetic data must make the contribution of each layer visible.

### 2.1 Layer 1: Hard eligibility

Database and policy logic remove groups that cannot or should not be recommended because of constraints such as:

- distance
- meeting schedule
- group status
- capacity
- existing active membership
- duplicate pending request
- gender or life-stage requirement where explicitly applicable
- other canonical policy rules

This layer answers: **Which groups are valid possibilities?**

### 2.2 Layer 2: Deterministic relevance and shortlisting

Structured features rank the valid possibilities and reduce them to a controlled shortlist. Relevant features may include:

- stated availability
- stated interests
- life-stage alignment
- distance
- capacity
- attendance and engagement patterns
- online versus in-person behavior
- signal confidence
- other approved `person_features`

This layer answers: **Which valid groups are objectively plausible enough to examine closely?**

### 2.3 Layer 3: Contextual LLM ranking

The LLM ranks only groups already admitted to the deterministic shortlist. It reasons over semantic differences that would be costly or brittle to represent as an ever-expanding set of database fields.

Examples include:

- whether a group welcomes people with little Bible-study experience
- whether independent preparation is expected
- whether questions and uncertainty are welcomed
- whether a group is community-oriented or academically intensive
- whether the group description aligns with the member's confirmed narrative

This layer answers: **Which credible options best fit the person's stated situation and the groups' meaningful narrative characteristics?**

The LLM must not:

- select a group outside the shortlist
- override hard eligibility rules
- invent group facts
- diagnose a member psychologically or pastorally
- expose hidden member information to leaders
- treat behavioral inference as unquestionable truth

### 2.4 Evaluation principle

Deterministic scoring is responsible for **shortlist quality**, not final semantic ordering.

Close deterministic scores among credible shortlist candidates are acceptable, and may be desirable, when the candidates differ meaningfully in narrative characteristics that require contextual interpretation.

Evaluation must therefore separate:

- **Shortlist Recall@6**: whether the deterministic shortlist contains the expected best group and accepted alternatives while excluding hard-ineligible groups
- **LLM Top-1**: whether the model selects the expected best group
- **LLM Top-3**: whether expected and accepted alternatives appear in the top three
- **Stability**: whether repeated runs produce an acceptable consistent result
- **Fallback rate**: how often deterministic fallback is required

The design does not require a fixed deterministic score gap between the first and second candidates.

---

## 3. Design Goals

### 3.1 Demonstrate organizational scale

The population and group catalog must be large enough that manually reviewing every possible opportunity for each member would be impractical.

### 3.2 Produce meaningful candidate sets

A recommendation persona should usually have multiple initially plausible opportunities, not only one or two obvious database matches.

### 3.3 Demonstrate layered value

The data should show:

1. the catalog being reduced by eligibility rules
2. credible candidates being retrieved by deterministic scoring
3. semantic distinctions being resolved through contextual ranking
4. recommendations being persisted and reused
5. people retaining control over the final action

### 3.4 Avoid artificial outcomes

The dataset must not special-case a named persona inside the scoring algorithm or manipulate facts solely to create attractive numbers.

### 3.5 Remain deterministic and testable

The same generator version, configuration, and random seed must produce the same synthetic world, identifiers, scenarios, and expected relationships.

---

## 4. Approved Organizational Scale

Gathered models a large church serving Winter Garden, Florida and surrounding communities.

| Entity | Approved target |
|---|---:|
| Adults | Approximately 4,500 |
| Children | Approximately 1,500 to 2,500 |
| Households | Approximately 2,500 to 3,200 |
| Groups | Approximately 140 |
| Active group memberships | Approximately 900 to 1,400 |
| Recommendation-ready profiles | Approximately 1,200 to 2,000 |
| Weekly worship services | 6 to 10 |
| Engagement history | 52 weeks |
| Evaluation scenarios | Approximately 28 to 30 |
| Typical hard-filter survivors for a primary persona | Approximately 8 to 15 |
| Deterministic shortlist cap | 6, per canonical architecture |
| Presented recommendations | Typically 3 |
| Deterministic RNG seed | 516 |

Exact counts may vary within approved ranges when required for coherent distributions and referential integrity.

---

## 5. Geography and Multi-Campus Representation

### 5.1 Geographic area

Preserve the current Winter Garden-area scope:

- 34787
- 34786
- 34761
- 34734
- 34711

Households must use synthetic approximate coordinates derived from ZIP centroids plus deterministic random offsets. No real street addresses may be used.

### 5.2 Campus representation

The current application schema does not contain a first-class campus column. Until the architecture is intentionally changed, campuses may be represented only through supported data such as:

- services
- service attendance
- leader household geography
- group geography
- validation-only truth metadata

Campus must not be presented as a production application feature when it exists only in validation metadata.

---

## 6. Population Design

The population must be generated from coherent archetypes rather than independent random field assignments.

### 6.1 Household types

Include:

- single adults living alone
- unrelated adult housemates
- married couples without children
- couples with young children
- couples with school-age children
- couples with teenagers
- single-parent households
- multigenerational households
- empty-nest couples
- retired individuals and couples
- young adults living with parents
- households with mixed church participation

Household composition may influence life stage, childcare needs, schedule, and group preferences. It must not automatically determine spiritual interests.

### 6.2 Adult age bands

Include meaningful representation across:

- 18 to 22
- 23 to 29
- 30 to 39
- 40 to 49
- 50 to 59
- 60 to 69
- 70 and older

The distribution should resemble a large family-oriented suburban church rather than an even random distribution.

### 6.3 Church tenure

Include:

- first-time guests
- recent visitors
- people with less than one year of history
- people with one to three years of history
- established members
- long-tenured members
- people returning after disengagement

Tenure influences the quantity and confidence of historical data. It must not be treated as a direct measure of spiritual maturity.

### 6.4 Profile adoption

Target approximately 30 to 45 percent of adults with usable recommendation profiles, including:

- highly detailed profiles
- sparse profiles
- people with history but no completed profile
- new people with a profile but little behavioral history

### 6.5 Profile coherence

Generate profiles through archetypes such as:

- new believer seeking foundational guidance
- experienced member seeking deeper study
- parent needing childcare
- young adult seeking community
- online-first participant
- person returning after disengagement
- person seeking prayer and support
- person interested in serving
- person whose stated preference differs from observed behavior

Intentional conflicts must be evaluation scenarios, not accidental noise.

---

## 7. Engagement History

Generate 52 weeks of supported engagement history.

### 7.1 Supported sources

Where represented by the current schema, include:

- worship-service attendance
- online-service participation
- group meeting attendance
- event attendance
- serving assignments
- previous group membership
- join requests
- group departures
- profile information and updates

### 7.2 Behavioral patterns

Generate recognizable patterns:

- consistent weekly attendance
- twice-monthly attendance
- monthly attendance
- seasonal attendance
- recent increase in participation
- recent decline in participation
- online-first participation
- mixed online and in-person participation
- attendance concentrated on a particular day or service
- interrupted participation
- sparse history
- no history for new participants

### 7.3 Signal confidence

The data should support high-, medium-, and low-confidence behavioral signals, plus profile-only and history-only cases.

Stated preferences and observed behavior may differ for legitimate reasons. The system must treat that difference as context, not proof that the stated preference is wrong.

---

## 8. Group Catalog Design

Generate approximately 140 groups with meaningful overlap.

### 8.1 Group families

Include controlled variations of:

- foundational and new-to-faith groups
- young-adult groups
- men's discipleship
- women's discipleship
- couples groups
- young-family groups
- parenting groups
- empty-nest groups
- mature-adult groups
- prayer groups
- Bible-study groups
- theology and advanced-study groups
- recovery and support groups
- serving-oriented groups
- interest-based groups
- online groups
- hybrid groups
- forming groups

### 8.2 Meaningful differentiation

Groups within a family should vary across supported dimensions:

- meeting day and time
- location and distance
- gender focus
- life-stage focus
- childcare
- format
- content emphasis
- formation depth
- preparation expectations
- discussion style
- group culture
- status
- capacity and occupancy
- frequency, where supported

Descriptions must express legitimate semantic distinctions that the LLM can reason over after structured filtering.

### 8.3 Semantic contrast scenarios

For selected evaluation scenarios, create groups that are structurally similar but semantically distinct.

Example pattern:

- a foundational group where questions are encouraged and no prior study is expected
- a peer-community group with optional preparation
- an intensive study requiring independent weekly preparation

All may pass hard filters. Their descriptions and the member's confirmed narrative should make one option contextually preferable without requiring a persona-specific rule.

### 8.4 Capacity ranges

| Group type | Typical capacity |
|---|---:|
| Intensive discipleship | 6 to 10 |
| General home group | 8 to 16 |
| Couples group | 8 to 16 people |
| Class or larger study | 15 to 30 |
| Online group | 12 to 25 |
| Forming group | 0 to 6 current members |

Include forming, under-enrolled, healthy open, nearly full, full, and closed groups. The schema does not currently represent paused as a distinct status, so paused must not be claimed as an application state unless the architecture changes.

---

## 9. Named Personas

Named personas retain stable UUIDs, portal identities, roles, and security expectations.

### 9.1 Dana

Dana is the primary Journey 1 recommendation persona.

Preserve her core scenario:

- relatively new to the church or area
- limited independent Bible-study experience
- wants a supportive and nonjudgmental environment
- available Wednesday and Thursday evenings
- interested in Bible reading, prayer, and learning
- not currently an active member of a conflicting group
- no canonical requirement for a women-only group

Dana's group preference should remain `mixed` unless the canonical Demo Journey explicitly changes her stated preference.

Target Dana's funnel:

- approximately 15 to 25 broadly eligible groups
- approximately 8 to 15 groups passing hard filters
- 6 deterministic shortlist candidates
- 3 presented recommendations

Dana should have:

- one strongly defensible contextual best match
- credible alternatives
- at least one structurally plausible but semantically weaker option

The expected top result should emerge from ordinary data, shortlist logic, and semantic ranking. No code may check Dana's identity or grant her a special score.

### 9.2 Priya

Priya supports a valid no-recommendation or empty-run outcome. The system must not force a poor recommendation.

### 9.3 Jordan

Jordan remains the canonical new-attender/intake scenario defined by Demo Journeys and `personas.json`. Do not redefine him as an existing-member exclusion case unless the canonical product documents change.

### 9.4 Marcus

Marcus remains the canonical member persona defined by Demo Journeys and `personas.json`. Do not redefine him as a leader unless the canonical product documents change.

### 9.5 Ruth

Ruth continues to support the established active-membership or eligibility scenario defined by the evaluation suite.

### 9.6 Leaders and Manager

Leader personas must see only appropriate join-request information and must not see hidden recommendation rationale or sensitive behavioral details.

The Manager persona supports auditability, provenance, safeguards, and separation of member-, leader-, and Manager-visible information.

Any missing Journey 3 leader persona remains a separate product/design decision and must not be silently invented during seed generation.

---

## 10. Evaluation Suite

Preserve the original evaluation labels and stable IDs unless an approved canonical change requires revision.

Expand toward approximately 28 to 30 scenarios.

### 10.1 Ranking scenarios

Include:

- new-faith/questions fit
- theology depth
- disciplined study
- prayer emphasis
- online access
- family inclusion
- mature men's theology
- accountability
- fathers
- post-service timing
- forming-group preference
- sparse history
- no history
- stated versus observed behavior
- capacity tradeoff
- geographic tradeoff
- schedule constraint
- decisive childcare
- online-first behavior
- mixed online and in-person behavior
- returning after disengagement
- multiple-location behavior
- couple versus individual preference
- low-confidence signals
- semantically distinct but structurally similar candidates

### 10.2 Policy scenarios

Include:

- active-membership exclusion
- duplicate pending request
- intentionally empty result
- hard-rule exclusion
- serving conflict, where supported by canonical rules

### 10.3 Label fields

Evaluation labels may include:

- `purpose`
- `outcome_type`
- `excluded_group_ids`
- `scenario_family`
- expected top group
- accepted alternatives

Evaluation and test scripts must select scenarios by `outcome_type` rather than assuming every label is a ranking case.

---

## 11. Synthetic-Data Realism and Safety

### 11.1 No real personal information

Do not use real member data, real addresses, real personal contact details, real pastoral-care notes, or real sensitive histories.

### 11.2 Sensitive scenarios

Recovery, family, spiritual-development, or support scenarios may appear only as synthetic contexts. Avoid stigmatizing or unnecessarily graphic details.

### 11.3 Coherence over randomness

Randomness creates variation within coherent archetypes. It must not create unexplained contradictions solely for volume.

### 11.4 Controlled imperfection

The data may contain missing fields, sparse histories, changing availability, stale preferences, incomplete engagement, and nearly full groups. Imperfection must be controlled and explainable.

---

## 12. Determinism and Stable IDs

### 12.1 Random seed

The deterministic random seed is `516`.

### 12.2 Stable records

Stable UUIDs are required for:

- named personas
- portal users
- named groups used by journeys or tests
- evaluation members
- evaluation groups
- original join-request fixtures
- any record referenced directly by canonical documentation or tests

`seed/stable_ids.json` records and validates these identities.

### 12.3 Source of truth

`seed/generate_seed.py` is the executable source of truth.

Files in `seed/out/` are generated artifacts and must not be manually maintained.

### 12.4 Reproducibility

Two runs using the same generator version, configuration, and RNG seed must produce byte-equivalent outputs where the validation contract requires it.

---

## 13. Generator Design Principles

### 13.1 Configuration

Scale assumptions must be explicit and inspectable rather than buried in procedural logic.

Example structure:

```python
SCALE = {
    "adult_population": 4500,
    "history_weeks": 52,
    "target_groups": 140,
    "profile_rate": 0.35,
    "active_membership_rate": 0.28,
}
```

The exact implementation may differ, but the key scale decisions must remain visible.

### 13.2 Templates and archetypes

Use reusable structures for:

- household archetypes
- member archetypes
- group families
- attendance patterns
- membership distributions
- named-persona overlays
- evaluation-scenario overlays

### 13.3 Persona overlays

Explicit deterministic overlays may set named personas' profiles, household facts, attendance patterns, group history, candidate geography, or expected evaluation relationships.

An overlay must not change scoring logic or bypass normal application rules.

### 13.4 Loader compatibility

Preserve the generated CSV file set, columns, and headers expected by `scripts/load_seed.mjs` unless an approved migration changes the contract.

### 13.5 Truth and validation files

Validation-only files such as `_truth_group.csv` may describe facts not represented in the production schema. They must not be presented as production application features.

---

## 14. Compatibility Requirements

The expanded dataset must remain compatible with:

- existing CSV loaders
- Lakebase migrations
- foreign-key constraints
- row-level security
- persona selection
- `withPersona`
- `person_features` production
- deterministic shortlist generation
- recommendation-run persistence
- recommendation evaluation
- join-request workflows
- audit logging
- local development
- future Databricks feature production

A seed change must not silently redefine application architecture.

If an approved data requirement cannot be represented by the schema, stop and raise a separate architecture decision rather than hiding it in truth metadata or seed logic.

---

## 15. Performance Expectations

### 15.1 Generation

Generation and validation must remain practical for local development. The current expanded implementation demonstrates that approximately 13 MB of CSV output can be generated in seconds and validated deterministically without connecting to Lakebase.

### 15.2 Database reset

`npm run seed:reset` must remain usable after the load increment. Its measured duration must be recorded after the expanded data is loaded.

### 15.3 Recommendation latency

The LLM must never receive the full 140-group catalog. Total catalog size should primarily affect filtering and shortlist computation, while the LLM receives no more than the canonical shortlist cap.

### 15.4 Evaluation cost

Normal automated tests must use stubs and make no external calls. Controlled live evaluation must report model, prompt version, calls, attempts, token usage, approximate cost, Top-1, Top-3, fallback rate, and stability.

---

## 16. Validation and Acceptance Criteria

### 16.1 Generation

- RNG seed 516 is preserved.
- Generation is deterministic.
- Stable IDs remain unchanged.
- All expected CSV files are generated.
- No manual CSV edits are required.

### 16.2 Integrity

- primary keys are unique
- required foreign keys resolve
- memberships reference valid people and groups
- meetings reference valid groups
- attendance references valid people and meetings or services
- join requests reference valid people and groups
- portal users reference valid personas
- evaluation labels reference valid records
- occupancy and membership facts are consistent

### 16.3 Scale

- adults are approximately 4,500
- children are within 1,500 to 2,500
- households are within 2,500 to 3,200
- groups are approximately 140
- active memberships are within 900 to 1,400
- recommendation-ready profiles are within 1,200 to 2,000
- engagement history covers 52 weeks
- evaluation scenarios are approximately 28 to 30

### 16.4 Distribution

- schedules are meaningfully distributed
- geography is meaningfully distributed
- occupancy includes forming, open, nearly full, full, and closed groups
- profile and behavioral archetypes are coherent
- histories include new, sparse, consistent, mixed, rising, declining, and disengaged patterns

### 16.5 Deterministic layer

For curated ranking scenarios:

- the expected best group appears in the six-candidate shortlist
- accepted alternatives appear where intended
- hard-ineligible groups are excluded
- shortlist recall is measured separately from final ordering

The target is effectively 100 percent Shortlist Recall@6 for approved curated scenarios unless a scenario explicitly tests exclusion or no result.

### 16.6 LLM layer

For curated semantic-ranking scenarios:

- Top-1 and Top-3 are measured
- results are tested across repeated runs
- no group outside the shortlist is accepted
- fallback behavior remains valid
- semantic distinctions are supported by supplied member and group facts
- rationale remains internal and role-restricted

### 16.7 Dana

Dana's scenario must show:

- a credible need for layered recommendation
- multiple hard-filter survivors
- six credible deterministic shortlist candidates
- a defensible contextual best match
- credible alternatives
- semantic distinctions that ordinary structured filters do not fully resolve
- no persona-specific scoring exception

Close deterministic scores are acceptable. The acceptance test is whether First Steps, or another approved best match, is retrieved by the shortlist and correctly preferred by the contextual ranking contract for defensible reasons.

Report:

- broad eligibility count
- hard-filter survivor count
- shortlist IDs, order, scores, and internal score breakdowns
- model order
- internal rationale
- member-visible explanation
- Top-1, Top-3, and stability results

### 16.8 Application compatibility

After the load increment:

- CSV loading succeeds
- `person_features` computation succeeds
- tests handle ranking and non-ranking evaluation labels correctly
- recommendation tests pass
- TypeScript validation passes
- application build passes
- Journey 1 works with the expanded data
- security boundaries remain intact

---

## 17. Implementation Sequence

1. Maintain this document as the approved synthetic-world specification.
2. Generate and validate the expanded CSVs offline.
3. Review the distribution report and named scenarios.
4. Strengthen semantic differentiation for selected ranking scenarios without changing scoring weights.
5. Run offline generation and validation again.
6. Update test and evaluation scripts to support ranking and non-ranking `outcome_type` values.
7. Load the approved expanded CSVs into the single development Lakebase database.
8. Recompute `person_features`.
9. Run stubbed recommendation and policy tests.
10. Measure Shortlist Recall@6 separately from LLM ranking.
11. Inspect Dana and representative semantic-ranking scenarios.
12. Run controlled live LLM evaluation.
13. Test Journey 1 against the expanded dataset.
14. Measure generation, reset, recommendation, and evaluation performance.
15. Update canonical architecture documentation with approved final scale facts.

Do not change deterministic scoring weights during steps 1 through 11.

After step 11, a scoring change may be considered only if the deterministic layer fails to retrieve expected candidates or admits inappropriate candidates. Any scoring change becomes a new scoring version with its own evaluation.

---

## 18. Document Responsibilities

This document is canonical for:

- synthetic organizational scale
- population assumptions
- group-catalog assumptions
- named persona data design
- evaluation coverage
- generation principles
- synthetic-data acceptance criteria

`Gathered - Data Model & Architecture.md` is canonical for:

- application architecture
- schema
- Lakebase and Databricks responsibilities
- RLS and security
- recommendation lifecycle
- scoring and ranking contracts
- auditability

`Gathered - Demo Journeys.md` is canonical for:

- user behavior
- screens
- product flows
- demo scenarios

`Gathered - Build Tracker.md` is canonical for:

- implementation status
- current and next work
- dependencies
- sequencing
- deferred work
- cut decisions

`seed/generate_seed.py` is the executable source for generating the synthetic dataset.

`seed/SYNTHETIC_DATA_REPORT.md` is a generated validation report, not a manually maintained source of truth.

---

## 19. Approved Current Targets and Clarifications

| Decision | Approved position |
|---|---|
| Adult population | Approximately 4,500 |
| Group count | Approximately 140 |
| Engagement history | 52 weeks |
| Evaluation scenarios | Approximately 28 to 30 |
| RNG seed | 516 |
| Canonical shortlist cap | 6 |
| Dana's group preference | Mixed, unless Demo Journeys explicitly changes it |
| Dana deterministic score gap | No fixed minimum |
| Deterministic success metric | Shortlist Recall@6 and policy compliance |
| LLM success metrics | Top-1, Top-3, stability, fallback rate |
| Ranking weights during expansion | Unchanged |
| Campus support | Represent only through supported schema and validation metadata |
| Paused group status | Not supported by current schema; do not claim it as an application state |
| Marcus role | Preserve canonical member role |
| Jordan role | Preserve canonical new-attender/intake role |
| Missing Journey 3 leader persona | Separate unresolved product decision |

These decisions must not be changed silently inside the generator or evaluation scripts.
