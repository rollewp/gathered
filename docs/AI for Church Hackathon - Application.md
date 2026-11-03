# AI for Church Hackathon 2026 — Application
**Track:** Care & Community · **Drafted:** 2026-10-29 · **Description length:** 2,983 / 3,000 characters

## Project name
Gathered

## Description
As a church grows, a few pastors can't personally disciple everyone. Small groups carry that weight, and the D-Group model Robby Gallaty describes in Growing Up (6 to 8 people, often same-gender, bearing each other's burdens) works best when the people in the group fit each other's season of life. Today that fit often depends on what one staff member remembers, and new attenders who never connect tend to drift.

Gathered helps church staff place each person in the group where they are most likely to belong.

A care pastor asks a question in plain language, inside the workplace tools the staff already use: "Who started attending in the last 90 days and isn't in a group yet? Suggest a group for each." Gathered returns up to three groups per person, with a plain-English reason for each one. For example: "Meets Tuesdays near his neighborhood, two other dads with kids under five, the leader also serves in children's ministry, two open seats." It drafts a warm invitation for the group leader to personalize and send.

How it works:
- A data platform brings each person's engagement into one profile: attendance consistency, serving history, life stage, stated interests, availability and group participation.
- Matching is deterministic and explainable. It scores how well a group fits a person: meeting night, distance, life stage, shared serving areas and open seats. It enforces the D-Group size cap.
- An LLM writes the explanation and drafts the invitation from that structured result. It does not decide the match.
- A copilot-style interface in the staff's existing workplace tools presents the recommendations.

Guardrails:
- Gathered scores how well a group fits a person. It never ranks, labels or rates a person.
- Only people who opted in to group connection are included.
- Nothing is inferred about anyone's spiritual state, marriage, health or struggles. Matching uses only what a person shared or what the church already records about participation.
- Giving data is excluded from matching and masked from every role.
- Permissions are enforced where the data lives, not in the chat window. A small-group leader asking the same question as the care pastor sees only their own group. The demo shows both roles.
- Gathered never contacts anyone. A person reviews every suggestion and sends every invitation.
- The demo uses a fictional seeded church. No real congregant data is used.

What gets built during the window: the synthetic church dataset, the unified engagement profile, the matching logic, the LLM explanation and invitation layer, role-based data policies, and the copilot interface, plus a short match-quality evaluation against the seeded data.

Beyond one church: the same pattern of one profile and an explainable next connection fits ministries, member associations and brands that host enthusiast communities. Gathered starts with the local church.

Gathered uses AI to introduce people to each other. The discipleship happens in the group.
