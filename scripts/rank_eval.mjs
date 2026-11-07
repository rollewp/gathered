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
// Writes: eval/out/rank_eval-<timestamp>.json (gitignored). No writes to Lakebase.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import OpenAI from "openai";
import { readCsv } from "../lib/seed/csv.mjs";
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

const evalLabels = readCsv("eval_label.csv").map((r) => ({
  ...r,
  acceptable_group_ids: r.acceptable_group_ids ? r.acceptable_group_ids.split("|").filter(Boolean) : [],
}));

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

// ---------------------------------------------------------------- stats

function emptyStats() {
  return { runs: 0, top1: 0, top3: 0, fallback: 0, latencyTotal: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: 0 };
}
function recordRun(stats, { top1, top3, fallback, latency = 0, usage }) {
  stats.runs++;
  if (top1) stats.top1++;
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

// ---------------------------------------------------------------- main loop

const stats = { A: emptyStats(), B: emptyStats(), C: emptyStats() };
const results = [];
let shortlistRecallHits = 0;

for (const label of evalLabels) {
  const profile = ctx.profilesByPerson[label.person_id];
  if (!profile || !ctx.personsById[label.person_id]) {
    console.warn(`skip ${label.label_key}: no person/profile found for ${label.person_id}`);
    continue;
  }
  const shortlist = shortlistFor(ctx, label.person_id);
  const items = toItems(shortlist);
  const idList = shortlist.map((g) => g.group_id);
  const expectedOrAlt = new Set([label.expected_group_id, ...label.acceptable_group_ids]);
  const recall = idList.some((id) => expectedOrAlt.has(id));
  if (recall) shortlistRecallHits++;
  const n = Math.min(3, shortlist.length);

  const cRanked = scoreOrderFallback(idList, n);
  const cTop1 = cRanked[0] === label.expected_group_id;
  const cTop3 = cRanked.some((id) => expectedOrAlt.has(id));
  recordRun(stats.C, { top1: cTop1, top3: cTop3, fallback: false });

  const labelRecord = {
    label_key: label.label_key, person_id: label.person_id,
    expected_group_id: label.expected_group_id, expected_group_name: label.expected_group_name,
    acceptable_group_ids: label.acceptable_group_ids, cue: label.cue,
    shortlist: shortlist.map((g) => ({ group_id: g.group_id, name: g.name, score: Math.round(g.total * 10) / 10, breakdown: g.breakdown })),
    shortlist_recall: recall,
    variants: { A: { runs: [] }, B: { runs: [] }, C: { ranked: cRanked, top1_hit: cTop1, top3_hit: cTop3 } },
  };
  if (n === 0) { console.warn(`${label.label_key}: empty shortlist, nothing to rank`); results.push(labelRecord); continue; }

  for (const variant of ["A", "B"]) {
    const payload = {
      member: memberPayload(profile),
      shortlist: shortlistPayload(items, { includeScore: variant === "A", shuffleSeed: variant === "B" ? SHUFFLE_SEED : undefined }),
    };
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const out = await rankWithRetry(payload, idList, n);
      const top1 = out.ordered[0] === label.expected_group_id;
      const top3 = out.ordered.some((id) => expectedOrAlt.has(id));
      recordRun(stats[variant], { top1, top3, fallback: out.fallback, latency: out.latency, usage: out.usage });
      labelRecord.variants[variant].runs.push({
        run, ranked: out.ordered, internal_rationale: out.internal_rationale, confidence: out.confidence,
        fallback: out.fallback, attempts: out.attempts, latency_ms: out.latency, usage: out.usage,
        top1_hit: top1, top3_hit: top3,
      });
    }
  }
  results.push(labelRecord);

  console.log(`\n${label.label_key}  expected=${label.expected_group_name}  shortlist_recall=${recall ? "yes" : "NO"}`);
  console.log(`  shortlist: ${shortlist.map((g) => `${g.name} (${g.total.toFixed(1)})`).join(", ")}`);
  for (const variant of ["A", "B"]) {
    for (const r of labelRecord.variants[variant].runs) {
      console.log(`  [${variant}${r.run}] ${r.top1_hit ? "HIT " : r.top3_hit ? "top3" : "miss"}  ${r.ranked.map(groupName).join(" > ")}  (${r.confidence}${r.fallback ? ", FALLBACK" : ""})`);
    }
  }
  console.log(`  [C]  ${cTop1 ? "HIT " : cTop3 ? "top3" : "miss"}  ${cRanked.map(groupName).join(" > ")}`);
}

// ---------------------------------------------------------------- stability, summary, pass mark

function computeStability(variant) {
  let stable = 0, total = 0;
  for (const rec of results) {
    const picks = rec.variants[variant].runs.map((r) => r.ranked[0]);
    if (picks.length === 0) continue;
    total++;
    const counts = {};
    for (const p of picks) counts[p] = (counts[p] ?? 0) + 1;
    if (Math.max(...Object.values(counts)) >= 2) stable++;
  }
  return { stable, total };
}
const stabilityA = computeStability("A");
const stabilityB = computeStability("B");
const N_LABELS = evalLabels.length;

console.log("\n" + "=".repeat(70) + `\nSUMMARY (${PROMPT_VERSION})\n` + "=".repeat(70));
console.log(`shortlist recall: ${shortlistRecallHits}/${N_LABELS}`);
function printVariantSummary(name, s, stability) {
  console.log(`\nVariant ${name} (${s.runs} runs over ${s.runs / RUNS_PER_VARIANT} labels):`);
  console.log(`  top-1 hits:   ${s.top1}/${s.runs}  (${(s.top1 / s.runs * 100).toFixed(0)}%)`);
  console.log(`  top-3 hits:   ${s.top3}/${s.runs}  (${(s.top3 / s.runs * 100).toFixed(0)}%)`);
  console.log(`  fallbacks:    ${s.fallback}/${s.runs}`);
  console.log(`  avg latency:  ${(s.latencyTotal / s.runs).toFixed(0)} ms`);
  console.log(`  avg tokens:   prompt ${(s.promptTokens / s.runs).toFixed(0)}, completion ${(s.completionTokens / s.runs).toFixed(0)}`);
  console.log(`  cost:         total $${s.costUsd.toFixed(4)}`);
  console.log(`  stable top-1: ${stability.stable}/${stability.total} labels (>=2 of ${RUNS_PER_VARIANT} runs agree)`);
}
printVariantSummary("A (scored shortlist)", stats.A, stabilityA);
printVariantSummary("B (shuffled, no scores)", stats.B, stabilityB);
console.log(`\nVariant C (score order, no LLM): top-1 ${stats.C.top1}/${N_LABELS}  top-3 ${stats.C.top3}/${N_LABELS}`);

function passMark(name, s, stability) {
  const top1 = (s.top1 / s.runs) * N_LABELS, top3 = (s.top3 / s.runs) * N_LABELS;
  const ok = top1 >= 10 && top3 >= 13 && s.fallback === 0 && stability.stable === stability.total;
  console.log(`\nPass mark, variant ${name}: ${ok ? "PASS" : "FAIL"}  (top-1 ${top1.toFixed(1)}/14 >=10, top-3 ${top3.toFixed(1)}/14 >=13, fallbacks ${s.fallback}, stable ${stability.stable}/${stability.total})`);
  return ok;
}
const passA = passMark("A", stats.A, stabilityA);
const passB = passMark("B", stats.B, stabilityB);

const outDir = path.join(ROOT, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `rank_eval-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(), model: MODEL, prompt_version: PROMPT_VERSION, n_labels: N_LABELS,
  shortlist_recall: { hits: shortlistRecallHits, of: N_LABELS },
  summary: { A: stats.A, B: stats.B, C: stats.C, stability: { A: stabilityA, B: stabilityB } },
  pass_mark: { A: passA, B: passB }, labels: results,
}, null, 2));
console.log(`\nFull results written to ${path.relative(ROOT, outPath)}`);
