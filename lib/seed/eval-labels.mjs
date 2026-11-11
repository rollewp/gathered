// Gathered: the evaluation-label model (seed/out/eval_label.csv), shared by the offline validator,
// the stubbed tests and the ranking evaluation so all three read a label the same way.
//
// eval_label.csv is an offline answer key. It is never loaded into the database.
//
// outcome_type (controlled vocabulary, one execution behavior each):
//   ranking            deterministic shortlist AND LLM ranking are evaluated; `expectation` sets how strictly
//   empty              no group may pass the hard filters; never sent to the ranking model
//   excluded           the listed groups must be absent from the shortlist; never sent to the ranking model
//   duplicate_pending  a second request to a group with a pending request is blocked; not ranked
//   active_member      an active member is never matched; not ranked
//
// expectation (ranking only):
//   top1                expected group must be ranked first
//   top1_or_alternates  expected group first; the listed acceptable groups are also acceptable in the top 3
//   top3                expected group must be among the three presented groups
import fs from "node:fs";
import path from "node:path";

export const OUTCOME_TYPES = ["ranking", "empty", "excluded", "duplicate_pending", "active_member"];
export const EXPECTATIONS = ["top1", "top1_or_alternates", "top3"];
const split = (s) => (s ? s.split("|").filter(Boolean) : []);

/** Parse one raw CSV row into a label with array fields. */
export function parseLabel(r) {
  return {
    ...r,
    acceptable: split(r.acceptable_group_ids),
    excluded: split(r.excluded_group_ids),
    contrast: split(r.contrast_group_ids),
    acceptableOrExpected: [r.expected_group_id, ...split(r.acceptable_group_ids)].filter(Boolean),
  };
}
export const parseLabels = (rows) => rows.map(parseLabel);

/** Split into the labels that go through ranking and the policy labels, which never reach the model. */
export function partitionLabels(labels) {
  const ranking = labels.filter((l) => l.outcome_type === "ranking");
  const policy = labels.filter((l) => l.outcome_type !== "ranking");
  const policyByType = {};
  for (const l of policy) (policyByType[l.outcome_type] ??= []).push(l);
  return { ranking, policy, policyByType };
}

/** The original 14 labels, recognized by (label_key, person_id) against seed/stable_ids.json. */
export function originalLabelMatcher(stablePath = path.join(import.meta.dirname, "..", "..", "seed", "stable_ids.json")) {
  const stable = JSON.parse(fs.readFileSync(stablePath, "utf8"));
  const entries = Object.entries(stable.eval_labels).map(([k, v]) => ({ key: k.startsWith("persona|") ? "persona" : k, ...v }));
  return {
    entries,
    isOriginal: (l) => entries.some((e) => e.key === l.label_key && e.person_id === l.person_id),
  };
}

/** Structural problems with a label set, as human-readable strings (empty when the set is consistent). */
export function validateLabelSchema(labels, groupIds, personIds) {
  const problems = [];
  const seen = new Set();
  for (const l of labels) {
    const where = `${l.label_key}/${l.person_id.slice(0, 8)}`;
    const id = `${l.label_key}|${l.person_id}`;
    if (seen.has(id)) problems.push(`${where}: duplicate label`);
    seen.add(id);
    if (!OUTCOME_TYPES.includes(l.outcome_type)) problems.push(`${where}: unknown outcome_type "${l.outcome_type}"`);
    if (!personIds.has(l.person_id)) problems.push(`${where}: person does not exist`);
    for (const g of [l.expected_group_id, ...l.acceptable, ...l.excluded, ...l.contrast].filter(Boolean)) if (!groupIds.has(g)) problems.push(`${where}: unknown group ${g}`);
    if (l.outcome_type === "ranking") {
      if (!EXPECTATIONS.includes(l.expectation)) problems.push(`${where}: ranking label needs expectation in ${EXPECTATIONS.join("|")}`);
      if (!l.expected_group_id) problems.push(`${where}: ranking label needs expected_group_id`);
      if (l.expectation === "top1_or_alternates" && l.acceptable.length === 0) problems.push(`${where}: top1_or_alternates needs acceptable_group_ids`);
      if (l.expectation !== "top1_or_alternates" && l.acceptable.length > 0) problems.push(`${where}: acceptable_group_ids only allowed with top1_or_alternates`);
      if (l.excluded.includes(l.expected_group_id)) problems.push(`${where}: expected group is also excluded`);
    } else {
      if (l.expectation) problems.push(`${where}: expectation is only for ranking labels`);
      if (l.acceptable.length) problems.push(`${where}: acceptable_group_ids is only for ranking labels`);
      if (l.contrast.length || l.semantic_contrast) problems.push(`${where}: semantic contrast is only for ranking labels`);
    }
    if (l.outcome_type === "empty" && (l.expected_group_id || l.excluded.length)) problems.push(`${where}: empty label must not name groups`);
    if (l.outcome_type === "excluded" && l.excluded.length === 0) problems.push(`${where}: excluded label must list excluded_group_ids`);
    if (l.outcome_type === "duplicate_pending" && !l.expected_group_id) problems.push(`${where}: duplicate_pending label must name the group with the pending request`);
    if (l.outcome_type === "active_member" && (l.expected_group_id || l.excluded.length)) problems.push(`${where}: active_member label must not name groups`);
    if (!!l.semantic_contrast !== (l.contrast.length > 0)) problems.push(`${where}: semantic_contrast and contrast_group_ids must both be set or both be empty`);
  }
  return problems;
}
