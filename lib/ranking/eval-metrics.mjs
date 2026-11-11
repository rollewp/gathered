// Gathered: pure metric helpers for the ranking evaluation (scripts/rank_eval.mjs). No I/O, no model
// calls, so the arithmetic can be tested offline (scripts/test_eval_metrics.mjs).
//
// Metrics, kept separate on purpose:
//   Shortlist Recall@6   deterministic stage only: the expected (or accepted) group is on the six-group shortlist
//   LLM Top-1            the first ranked group is the expected group (strict). Counted only for labels whose
//                        expectation is top1 or top1_or_alternates; `top3` labels have no Top-1 expectation.
//   LLM Top-1 (accepted) like Top-1, but for top1_or_alternates labels an accepted alternate also counts
//   LLM Top-3            the expected or an accepted group is among the three ranked groups
//   Stability            a label is stable when at least 2 of its runs agree on the first-ranked group
//   Fallbacks            runs that fell back to score order after invalid model output (count and rate)

export function emptyStats() {
  return { runs: 0, top1Runs: 0, top1: 0, top1Accepted: 0, top3: 0, fallback: 0, latencyTotal: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}

/** One ranking run (or the deterministic score-order variant) judged against a label. */
export function judgeRun(label, ordered) {
  const top1Applies = label.expectation === "top1" || label.expectation === "top1_or_alternates";
  const expectedOrAccepted = new Set(label.acceptableOrExpected);
  return {
    top1Applies,
    top1: ordered[0] === label.expected_group_id,
    top1Accepted: label.expectation === "top1_or_alternates" ? expectedOrAccepted.has(ordered[0]) : ordered[0] === label.expected_group_id,
    top3: ordered.some((id) => expectedOrAccepted.has(id)),
  };
}

export function recordRun(stats, { top1Applies, top1, top1Accepted, top3, fallback = false, latency = 0, usage }) {
  stats.runs++;
  if (top1Applies) { stats.top1Runs++; if (top1) stats.top1++; if (top1Accepted) stats.top1Accepted++; }
  if (top3) stats.top3++;
  if (fallback) stats.fallback++;
  stats.latencyTotal += latency;
  if (usage) {
    stats.promptTokens += usage.prompt_tokens ?? 0;
    stats.completionTokens += usage.completion_tokens ?? 0;
    stats.totalTokens += usage.total_tokens ?? 0;
    stats.costUsd += usage.cost ?? 0;
  }
}

export const rate = (n, d) => (d ? n / d : 0);

/** records: [{ variants: { A: { runs: [{ ranked: [...] }] } } }] */
export function computeStability(records, variant) {
  let stable = 0, total = 0;
  for (const rec of records) {
    const picks = (rec.variants[variant]?.runs ?? []).map((r) => r.ranked[0]);
    if (picks.length === 0) continue;
    total++;
    const counts = {};
    for (const p of picks) counts[p] = (counts[p] ?? 0) + 1;
    if (Math.max(...Object.values(counts)) >= 2) stable++;
  }
  return { stable, total };
}

/**
 * Pass mark. The original suite's mark (14 labels: Top-1 >= 10, Top-3 >= 13, no fallbacks, every label stable)
 * is applied as proportions: Top-1 rate >= 10/14, Top-3 rate >= 13/14. For the 14 original labels this is
 * exactly the original mark.
 */
export const PASS = { top1: 10 / 14, top3: 13 / 14 };
export function passMark(stats, stability) {
  const top1Rate = rate(stats.top1, stats.top1Runs), top3Rate = rate(stats.top3, stats.runs);
  return {
    top1Rate, top3Rate, fallbackRate: rate(stats.fallback, stats.runs),
    ok: stats.runs > 0 && top1Rate >= PASS.top1 - 1e-9 && top3Rate >= PASS.top3 - 1e-9 && stats.fallback === 0 && stability.stable === stability.total,
  };
}
