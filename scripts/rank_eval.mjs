// Gathered: recommendation model evaluation (docs/Gathered - Demo Journeys.md).
// Proves the deterministic shortlist + LLM ranking picks the right group against
// seed/out/eval_label.csv.
//
// Usage: node --env-file=.env.local scripts/rank_eval.mjs [--model=<openrouter-model-id>]
//
// Reads (DATABASE_OWNER_URL, read-only; offline evaluation, not the app): the app schema,
// including app.person_features (run scripts/compute_person_features.mjs first). The
// deterministic stage is lib/ranking/reference-shortlist.mjs and the prompt contract is
// lib/ranking/rank-v2.mjs, the same modules the app is tested against and uses.
//
// Only labels with outcome_type "ranking" are sent to the model. The policy labels (empty, excluded,
// duplicate_pending, active_member) are skipped and reported with a count and reason; their checks live in
// scripts/seed_validate.mjs (offline) and scripts/test_recommendations.mjs (after the load).
//
// Reported separately: Shortlist Recall@6, LLM Top-1, LLM Top-3, stability, fallback count and rate.
//
// Writes: eval/out/rank_eval-<timestamp>.json (gitignored). No writes to Lakebase.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import OpenAI from "openai";
import { readCsv } from "../lib/seed/csv.mjs";
import { parseLabels, partitionLabels, originalLabelMatcher } from "../lib/seed/eval-labels.mjs";
import { emptyStats, recordRun, judgeRun, computeStability, passMark, rate } from "../lib/ranking/eval-metrics.mjs";
import { buildContext, shortlistFor, groupMix, SHORTLIST_SIZE } from "../lib/ranking/reference-shortlist.mjs";
import {
  PROMPT_VERSION, SYSTEM_PROMPT, memberPayload, shortlistPayload, parseRanking, scoreOrderFallback,
} from "../lib/ranking/rank-v2.mjs";

const ROOT = path.join(import.meta.dirname, "..");
const RUNS_PER_VARIANT = 3;
const SHUFFLE_SEED = 1337;

// ---------------------------------------------------------------- env / CLI

const modelArg = process.argv.slice(2).find((a) => a.startsWith("--model="));
const MODEL = modelArg ? modelArg.slice("--model=".length) : process.env.OPENROUTER_MODEL_FAST;

for (const key of ["DATABASE_OWNER_URL", "OPENROUTER_API_KEY"]) {
  if (!process.env[key]) { console.error(`${key} is not set (expected in .env.local)`); process.exit(1); }
}
if (!MODEL) {
  console.error("OPENROUTER_MODEL_FAST is not set (expected in .env.local), and no --model=<id> was passed");
  process.exit(1);
}
const openai = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });

// ---------------------------------------------------------------- load context

const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
const q = async (sql) => (await client.query(sql)).rows;
const ctx = buildContext({
  persons: await q("select * from app.person"),
  households: await q("select * from app.household"),
  profiles: await q("select * from app.member_profile"),
  groups: await q("select * from app.grp"),
  tags: await q("select * from app.group_tag"),
  leaders: await q("select * from app.group_leader"),
  activeMemberships: await q("select * from app.group_membership where status = 'active'"),
  features: await q("select * from app.person_features"),
});
await client.end();

if (ctx.featuresByPerson && Object.keys(ctx.featuresByPerson).length === 0) {
  console.error("app.person_features is empty. Run scripts/compute_person_features.mjs first.");
  process.exit(1);
}
const groupName = (id) => ctx.groups.find((g) => g.group_id === id)?.name ?? id;

// Only "ranking" labels are evaluated; policy labels are skipped with a count and reason.
const allLabels = parseLabels(readCsv("eval_label.csv"));
const { ranking: evalLabels, policy: skippedLabels, policyByType } = partitionLabels(allLabels);
const { isOriginal } = originalLabelMatcher();
console.log(`labels: ${allLabels.length} total; ${evalLabels.length} ranking scenarios evaluated; ${skippedLabels.length} policy scenarios skipped ` +
  `(${Object.entries(policyByType).map(([t, ls]) => `${t} ${ls.length}`).join(", ")}): they never reach the ranking model`);

// ---------------------------------------------------------------- shortlist items for the prompt

function toItems(shortlist) {
  return shortlist.map((g) => ({
    group_id: g.group_id, name: g.name, description: g.description, tags: ctx.tagsByGroup[g.group_id] ?? [],
    meeting_slot: g.meeting_slot, gender_focus: g.gender_focus, life_stage_focus: g.life_stage_focus,
    childcare: g.childcare, is_online: g.is_online, status: g.status,
    open_seats: Math.max(0, g.capacity_max - (ctx.activeMembersByGroup[g.group_id] ?? []).length),
    group_mix: groupMix(ctx, g.group_id), score: g.total,
  }));
}

// ---------------------------------------------------------------- LLM call with one retry, then score order

async function callLLM(payload) {
  const t0 = Date.now();
  const resp = await openai.chat.completions.create({
    model: MODEL, temperature: 0, response_format: { type: "json_object" },
    messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: JSON.stringify(payload) }],
  });
  return { raw: resp.choices[0].message.content, latency: Date.now() - t0, usage: resp.usage };
}

async function rankWithRetry(payload, shortlistIdList, n) {
  const shortlistIds = new Set(shortlistIdList);
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { raw, latency, usage } = await callLLM(payload);
    try {
      const parsed = parseRanking(raw, shortlistIds, n);
      return { ordered: parsed.orderedIds, internal_rationale: parsed.internal_rationale, confidence: parsed.confidence, latency, usage, fallback: false, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt === 2) {
        return {
          ordered: scoreOrderFallback(shortlistIdList, n),
          internal_rationale: `Fallback: LLM output invalid after retry (${lastErr.message})`,
          confidence: "low", latency, usage, fallback: true, attempts: attempt, raw_response: raw.slice(0, 500),
        };
      }
    }
  }
}

// ---------------------------------------------------------------- main loop

// "core" = the 14 original labels (the original pass mark); "all" = every ranking scenario.
const mkScope = () => ({ A: emptyStats(), B: emptyStats(), C: emptyStats() });
const stats = { core: mkScope(), all: mkScope() };
const record = (label, variant, run) => { recordRun(stats.all[variant], run); if (isOriginal(label)) recordRun(stats.core[variant], run); };
const results = [];
let recallExpected = 0, recallExpectedOrAccepted = 0, excludedViolations = 0;

for (const label of evalLabels) {
  const profile = ctx.profilesByPerson[label.person_id];
  if (!profile || !ctx.personsById[label.person_id]) {
    console.warn(`skip ${label.label_key}: no person/profile found for ${label.person_id}`);
    continue;
  }
  const shortlist = shortlistFor(ctx, label.person_id);
  const items = toItems(shortlist);
  const idList = shortlist.map((g) => g.group_id);
  const recallStrict = idList.includes(label.expected_group_id);
  const recall = idList.some((id) => label.acceptableOrExpected.includes(id));
  if (recallStrict) recallExpected++;
  if (recall) recallExpectedOrAccepted++;
  const excludedPresent = label.excluded.filter((id) => idList.includes(id));
  excludedViolations += excludedPresent.length;
  const n = Math.min(3, shortlist.length);

  const cRanked = scoreOrderFallback(idList, n);
  const cJudge = judgeRun(label, cRanked);
  record(label, "C", cJudge);

  const labelRecord = {
    label_key: label.label_key, person_id: label.person_id, expectation: label.expectation, original: isOriginal(label),
    expected_group_id: label.expected_group_id, expected_group_name: label.expected_group_name,
    acceptable_group_ids: label.acceptable, excluded_group_ids: label.excluded, cue: label.cue,
    shortlist: shortlist.map((g) => ({ group_id: g.group_id, name: g.name, score: Math.round(g.total * 10) / 10, breakdown: g.breakdown })),
    shortlist_recall: recallStrict, shortlist_recall_expected_or_accepted: recall, excluded_present: excludedPresent,
    variants: { A: { runs: [] }, B: { runs: [] }, C: { ranked: cRanked, top1_hit: cJudge.top1, top3_hit: cJudge.top3 } },
  };
  if (n === 0) { console.warn(`${label.label_key}: empty shortlist, nothing to rank`); results.push(labelRecord); continue; }

  for (const variant of ["A", "B"]) {
    const payload = {
      member: memberPayload(profile),
      shortlist: shortlistPayload(items, { includeScore: variant === "A", shuffleSeed: variant === "B" ? SHUFFLE_SEED : undefined }),
    };
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const out = await rankWithRetry(payload, idList, n);
      const j = judgeRun(label, out.ordered);
      record(label, variant, { ...j, fallback: out.fallback, latency: out.latency, usage: out.usage });
      labelRecord.variants[variant].runs.push({
        run, ranked: out.ordered, internal_rationale: out.internal_rationale, confidence: out.confidence,
        fallback: out.fallback, attempts: out.attempts, latency_ms: out.latency, usage: out.usage,
        top1_hit: j.top1, top3_hit: j.top3,
      });
    }
  }
  results.push(labelRecord);

  console.log(`\n${label.label_key} [${label.expectation}] expected=${label.expected_group_name}  shortlist_recall=${recallStrict ? "yes" : "NO"}`);
  console.log(`  shortlist: ${shortlist.map((g) => `${g.name} (${g.total.toFixed(1)})`).join(", ")}`);
  for (const variant of ["A", "B"]) {
    for (const r of labelRecord.variants[variant].runs) {
      console.log(`  [${variant}${r.run}] ${r.top1_hit ? "HIT " : r.top3_hit ? "top3" : "miss"}  ${r.ranked.map(groupName).join(" > ")}  (${r.confidence}${r.fallback ? ", FALLBACK" : ""})`);
    }
  }
  console.log(`  [C]  ${cJudge.top1 ? "HIT " : cJudge.top3 ? "top3" : "miss"}  ${cRanked.map(groupName).join(" > ")}`);
}

// ---------------------------------------------------------------- summary (metrics reported separately)

const coreRecords = results.filter((r) => r.original);
const stability = {
  core: { A: computeStability(coreRecords, "A"), B: computeStability(coreRecords, "B") },
  all: { A: computeStability(results, "A"), B: computeStability(results, "B") },
};
const N = results.length;
const pc = (n, d) => `${n}/${d} (${(rate(n, d) * 100).toFixed(0)}%)`;

console.log("\n" + "=".repeat(70) + `\nSUMMARY (${PROMPT_VERSION}, model ${MODEL})\n` + "=".repeat(70));
console.log(`ranking scenarios evaluated: ${N}; policy scenarios skipped: ${skippedLabels.length}`);
console.log(`\nShortlist Recall@${SHORTLIST_SIZE} (deterministic stage): expected on shortlist ${pc(recallExpected, N)}; expected or accepted ${pc(recallExpectedOrAccepted, N)}`);
console.log(`Excluded groups present on a shortlist: ${excludedViolations} (must be 0)`);

function printScope(scopeName, title) {
  console.log(`\n--- ${title} ---`);
  for (const variant of ["A", "B"]) {
    const s = stats[scopeName][variant], st = stability[scopeName][variant];
    const label = variant === "A" ? "A (scored shortlist)" : "B (shuffled, no scores)";
    console.log(`Variant ${label}: ${s.runs} runs`);
    console.log(`  LLM Top-1:          ${pc(s.top1, s.top1Runs)}   (accepted alternates counted: ${pc(s.top1Accepted, s.top1Runs)})`);
    console.log(`  LLM Top-3:          ${pc(s.top3, s.runs)}`);
    console.log(`  stability:          ${st.stable}/${st.total} labels (>=2 of ${RUNS_PER_VARIANT} runs agree on the first group)`);
    console.log(`  fallbacks:          ${s.fallback}/${s.runs} (${(rate(s.fallback, s.runs) * 100).toFixed(1)}%)`);
    console.log(`  avg latency:        ${s.runs ? (s.latencyTotal / s.runs).toFixed(0) : 0} ms; avg tokens prompt ${s.runs ? (s.promptTokens / s.runs).toFixed(0) : 0}, completion ${s.runs ? (s.completionTokens / s.runs).toFixed(0) : 0}; cost $${s.costUsd.toFixed(4)}`);
  }
  const c = stats[scopeName].C;
  console.log(`Variant C (score order, no LLM): Top-1 ${pc(c.top1, c.top1Runs)}, Top-3 ${pc(c.top3, c.runs)}`);
}
printScope("core", `the ${coreRecords.length} original labels (the original pass mark)`);
printScope("all", `all ${N} ranking scenarios (informational; same proportional thresholds)`);

const passes = {};
for (const scope of ["core", "all"]) {
  passes[scope] = {};
  for (const variant of ["A", "B"]) {
    const m = passMark(stats[scope][variant], stability[scope][variant]);
    passes[scope][variant] = m;
    console.log(`Pass mark, ${scope === "core" ? "original 14" : "all ranking"}, variant ${variant}: ${m.ok ? "PASS" : "FAIL"}  (Top-1 ${(m.top1Rate * 100).toFixed(0)}% >= 71%, Top-3 ${(m.top3Rate * 100).toFixed(0)}% >= 93%, fallbacks ${(m.fallbackRate * 100).toFixed(1)}%, every label stable)`);
  }
}

const outDir = path.join(ROOT, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `rank_eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(), model: MODEL, prompt_version: PROMPT_VERSION,
  n_labels_total: allLabels.length, n_ranking: N,
  skipped_policy: {
    count: skippedLabels.length, reason: "outcome_type is not ranking; these scenarios never reach the ranking model",
    by_type: Object.fromEntries(Object.entries(policyByType).map(([t, ls]) => [t, ls.map((l) => l.label_key)])),
  },
  shortlist_recall: { at: SHORTLIST_SIZE, expected_on_shortlist: recallExpected, expected_or_accepted: recallExpectedOrAccepted, of: N, excluded_present: excludedViolations },
  summary: { core: { ...stats.core, stability: stability.core }, all: { ...stats.all, stability: stability.all } },
  pass_mark: passes, labels: results,
}, null, 2));
console.log(`\nFull results written to ${path.relative(ROOT, outPath)}`);
