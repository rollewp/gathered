# AI for Church Hackathon 2026: Submission Deliverables
**Project:** Gathered · **Track:** Care & Community · **Captured:** 2026-10-29
**Companion file:** `AI for Church Hackathon - Application.md` (registration name, description and tagline)

**Purpose:** The final submission form opens 2026-10-30. Every field below is a build deliverable, not something to write the night before. Check this file at each weekly checkpoint.

**Tagline:** Gathered helps church staff match each new person to the small group where they're most likely to belong, and a human sends every invitation.
*(Short version: Gathered matches new people to the small group where they're most likely to belong.)*

---

## Key dates
| Date | What |
|---|---|
| Oct 30 | Build window opens. Only work done from here on is judged |
| ~Nov 2 | Start the data-platform trial so it lasts past the Dec 1 showcase |
| Nov 16 | Copilot-surface checkpoint: if it isn't working, fall back to the platform's built-in app UI |
| ~Nov 20 | Re-scan the competing projects at aiforchurch.com/hackathon/projects |
| **Nov 24 (Tue)** | **Target submission.** Thanksgiving is Nov 26 |
| Nov 27, 11:59 PM ET | Hard deadline. Edits lock automatically |
| Nov 28–30 | Judging and public voting (People's Choice, Hacker's Choice) |
| Dec 1, 12:00 PM ET | Live showcase and winners at aiforchurch.com/live |

## Judging weights (write every field toward these)
Ministry Impact 30% · Execution & Quality 25% · Innovation 20% · Faithfulness & Responsible AI 15% · Presentation (video and write-up) 10%

---

## Form fields

### 1. Description (required, 250 words max)
*What is it and how does it work? For a tool or feature inside an existing project, clearly separate the work done Oct 30–Nov 27 from earlier work.*
- **Pre-existing work:** none. Gathered is a new, standalone build. Say so explicitly in one sentence. Do **not** reuse code from `IP/redemption-connections-app` or RSA; only reuse patterns.
- **Source:** condense the registration description (about 2,980 characters) to 250 words or fewer.
- **Must include:** the staff question, top three groups with reasons, the drafted invitation, and that a human sends.
- **Status:** ☐ Draft ☐ Word count checked ☐ Final

### 2. Problem it solves for churches (required)
- **Core point:** as churches grow, pastors can't disciple everyone. Small groups and D-Groups (6–8 people; Robby Gallaty, *Growing Up*) carry that weight, but placement depends on staff memory, and new attenders who never connect drift.
- **Evidence to add:** one named, dated source on assimilation or small-group participation, if one can be verified. No uncited "most churches" claims (style guide).
- **Status:** ☐ Draft ☐ Source verified ☐ Final

### 3. How AI is used (required)
- **Be precise about who does what.** Matching is deterministic and explainable, and the data platform scores how well a group fits a person. The LLM handles the natural-language question, writes the explanation, and drafts the invitation. **The LLM does not decide the match.**
- **Name the copilot interface** in the staff's existing workplace tools.
- **Status:** ☐ Draft ☐ Matches what was actually built ☐ Final

### 4. Responsible AI safeguards (required): privacy, accuracy, theological care, human oversight
Each safeguard is a **build requirement**, not just copy. Check it off only once it works in the demo.

| Area | Commitment | Built? | Shown in demo? |
|---|---|---|---|
| Privacy | Only people who opted in to group connection are included | ☐ | ☐ |
| Privacy | Giving data is not collected or modeled (decided 2026-11-02) | ☐ | ☐ |
| Privacy | Permissions enforced at the data layer: a group leader sees only their own group; meeting attendance visible to the Manager only | ☐ | ☐ (two-role clip) |
| Privacy | Fictional seeded church only; no real congregant data | ☐ | ☐ |
| Accuracy | Recommendations surface no reasoning about the person; the member validates fit from public group facts. Score breakdowns kept for Manager audit (decided 2026-11-02) | ☐ | ☐ |
| Accuracy | Match-quality evaluation against the seeded data (report a real number, e.g. "X of Y") | ☐ | ☐ |
| Theological care | Nothing inferred about spiritual state, marriage, health or struggles | ☐ | ☐ |
| Theological care | Scores group fit, never ranks, labels or rates a person | ☐ | ☐ |
| Theological care | Invitation drafts stay pastoral; the leader personalizes them | ☐ | ☐ |
| Human oversight | Gathered never contacts anyone; a person reviews every suggestion and sends every invite | ☐ | ☐ |
| Human oversight | D-Group size cap enforced | ☐ | ☐ |

### 5. Tech stack / tools used (required)
- **Public framing:** a data platform, LLM integration, and a copilot or recommendation UI. Name the real products in this field once they're settled; the description stays generic.
- **Current working plan** (may change): Snowflake (data and governance policies) · Cortex Agent with a Claude model · Microsoft Teams surface via Entra sign-in · Claude Code for the build · synthetic data generator.
- **LLM routing (decided 2026-10-29):**
  - **Copilot path:** the LLM runs inside the data platform (Cortex), billed to the trial balance. AI features need a credit card on file. No separate LLM key is needed.
  - **Public live demo:** a Lovable app (100 free hackathon credits plus Lovable's 4-credit monthly AI grant) reading a snapshot of the precomputed matches.
  - **Precompute** the explanations and invite drafts in the data platform, so judging traffic doesn't burn credits.
  - **OpenRouter is backup only,** called from a backend function with the key stored as a secret. The trial blocks outbound calls from the data platform.
- **Walt's M365 Copilot license** means the same agent can also appear in Microsoft 365 Copilot, not only Teams.
- **Also list** build tools (Claude Code, any Lovable use) and data-generation tooling.
- **Status:** ☐ Final stack confirmed ☐ Field written

### 6. Demo video link (required: ≤5 minutes, on YouTube, Vimeo or Loom)
- **Host:** Walt's ongoing YouTube channel. Set it to public or unlisted **before** submitting, and check that the link works signed out.
- **Proposed run order (about 4:30):**
  1. Problem (0:30)
  2. Care pastor asks in the copilot (1:30)
  3. Why each group was matched, plus the leader's invitation draft (1:00)
  4. Same question as a group leader; giving data masked (1:00)
  5. How it's built (0:30)
- **Reuse:** cut a 60-second version of the two-role permission demo for LinkedIn.
- **Status:** ☐ Script ☐ Recorded ☐ Uploaded ☐ Link tested

### 7. Live demo link (optional, but strengthens Execution & Quality)
- **Constraint:** a Teams or copilot surface inside Walt's tenant **is not publicly reachable** by judges. Decide by the Nov 16 checkpoint whether to stand up a public, read-only recommendation UI over the seeded data (e.g. the data platform's built-in app) as the live link.
- **Keep it running** through judging (Nov 28–30) and the Dec 1 showcase. Watch trial expiry and any auto-sleep on the app.
- **Status:** ☐ Decision ☐ Deployed ☐ Tested signed out

### 8. Optional test/demo account
- **Only if the live demo needs sign-in.** Create a judge-only account scoped to the fictional church, read-only, with no admin rights. Keep the credentials in the submission form only, never in the repo or on LinkedIn.
- **Status:** ☐ Needed? ☐ Created ☐ Tested

### 9. Optional code repository
- **Decision needed:** public repo (helps Hacker's Choice and the engineering-credibility story) or private (protects reusable IP for the commercial version). Entrants keep full IP either way.
- **If public:** README with architecture, safeguards, how to seed the fictional church, and a clear note that the work started Oct 30. No secrets or keys, and seeded data only.
- **Status:** ☐ Decision ☐ Repo ready

### 10. Logo (optional)
- A simple, original mark for "Gathered." Check the name isn't an existing church product before final use; backups are Belonging and Tablefit.
- **Status:** ☐ Name checked ☐ Logo

### 11. Up to 5 screenshots
Suggested set:
1. The care pastor's question and the top-three group results
2. A recommendation's "why" explanation
3. Drafted invitation awaiting the leader's edit and send
4. Same query as a group leader: restricted view, giving masked
5. Architecture or safeguards diagram

- **Status:** ☐ Captured ☐ No real names or data visible

---

## Reuse after submission (commercial bridge)
- Two-role permission clip → LinkedIn post and outreach asset for association and agency prospects
- Architecture diagram → a "same engine for publishers and associations" post after Dec 1
- Phase 2: the Focus on the Family "next best resource" version via Data 360 zero-copy (see Roadmap & Ideas Backlog)
- Success test: shipped demo plus two conversations with someone who controls a budget, by Dec 15
