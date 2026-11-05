// Gathered: Slice -1 ranking test (docs/Gathered - Demo Journeys.md).
// Proves the deterministic shortlist + LLM ranking picks the right group against
// seed/out/eval_label.csv before any UI is built.
//
// Usage: node --env-file=.env.local scripts/rank_eval.mjs [--model=<openrouter-model-id>]
//
// Reads: Lakebase app schema (DATABASE_OWNER_URL, read-only -- doc explicitly sanctions the
// owner URL here since this predates the app layer) for person/household/member_profile/grp/
// group_tag/group_leader/group_membership; seed/out/serving_assignment.csv + ministry.csv
// directly (those tables are Databricks/Delta-side per D1, not in Lakebase) for busy slots and
// serving areas; seed/out/eval_label.csv for the 14-label answer key.
//
// Writes: eval/out/rank_eval-<timestamp>.json (gitignored). No writes to Lakebase at all.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { z } from "zod";
import OpenAI from "openai";

const ROOT = path.join(import.meta.dirname, "..");
const SEED_DIR = path.join(ROOT, "seed", "out");
const RADIUS_MI = 5;
const KID_BANDS = [[0, 4], [5, 12], [13, 18]];
const PROMPT_VERSION = "rank-v1";
const RUNS_PER_VARIANT = 3;
const SHORTLIST_SIZE = 6;
const SHUFFLE_SEED = 1337;

// ---------------------------------------------------------------- env / CLI

const args = process.argv.slice(2);
const modelArg = args.find((a) => a.startsWith("--model="));
const MODEL = modelArg ? modelArg.slice("--model=".length) : process.env.OPENROUTER_MODEL_FAST;

for (const key of ["DATABASE_OWNER_URL", "OPENROUTER_API_KEY"]) {
  if (!process.env[key]) {
    console.error(`${key} is not set (expected in .env.local)`);
    process.exit(1);
  }
}
if (!MODEL) {
  console.error("OPENROUTER_MODEL_FAST is not set (expected in .env.local), and no --model=<id> was passed");
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: "https://openrouter.ai/api/v1" });

// ---------------------------------------------------------------- tiny RFC4180 CSV parser

function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    } else {
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ",") { row.push(field); field = ""; i++; continue; }
      if (c === "\r") { i++; continue; }
      if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
      field += c; i++; continue;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readCsv(file) {
  const rows = parseCsv(fs.readFileSync(path.join(SEED_DIR, file), "utf8"));
  const header = rows[0];
  return rows.slice(1)
    .filter((r) => r.length > 1 || r[0] !== "")
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ---------------------------------------------------------------- distance (mirrors generate_seed.py's miles())

function miles(a, b) {
  const [la1, lo1] = a, [la2, lo2] = b;
  const p = Math.PI / 180;
  const d = 0.5 - Math.cos((la2 - la1) * p) / 2
    + Math.cos(la1 * p) * Math.cos(la2 * p) * (1 - Math.cos((lo2 - lo1) * p)) / 2;
  return 7917.5 * Math.asin(Math.sqrt(d));
}

// ---------------------------------------------------------------- deterministic shuffle (variant B)

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------- load context

const client = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl: { rejectUnauthorized: false } });
await client.connect();

const personsRows = (await client.query("select * from app.person")).rows;
const householdsRows = (await client.query("select * from app.household")).rows;
const profilesRows = (await client.query("select * from app.member_profile")).rows;
const groupsRows = (await client.query("select * from app.grp")).rows;
const tagsRows = (await client.query("select * from app.group_tag")).rows;
const leadersRows = (await client.query("select * from app.group_leader")).rows;
const membershipRows = (await client.query("select * from app.group_membership where status = 'active'")).rows;

await client.end();

const personsById = Object.fromEntries(personsRows.map((p) => [p.person_id, p]));
const householdsById = Object.fromEntries(householdsRows.map((h) => [h.household_id, h]));
// available_slots/interests arrive as real JS arrays already -- node-postgres parses Postgres
// text[] columns natively.
const profilesByPerson = Object.fromEntries(profilesRows.map((p) => [p.person_id, p]));
const tagsByGroup = {};
for (const t of tagsRows) (tagsByGroup[t.group_id] ??= []).push(t.tag);
const leadersByGroup = {};
for (const l of leadersRows) (leadersByGroup[l.group_id] ??= []).push(l);
const activeMembersByGroup = {};
for (const m of membershipRows) (activeMembersByGroup[m.group_id] ??= []).push(m.person_id);

const childrenByHousehold = {};
for (const p of personsRows) {
  if (p.household_role === "child") (childrenByHousehold[p.household_id] ??= []).push(p.birth_year);
}

const servingAssignments = readCsv("serving_assignment.csv");
const ministries = readCsv("ministry.csv");
const ministryAreaById = Object.fromEntries(ministries.map((m) => [m.ministry_id, m.area]));

const busySlotsByPerson = {};
const servingAreasByPerson = {};
for (const row of servingAssignments) {
  (busySlotsByPerson[row.person_id] ??= new Set()).add(row.schedule_slot);
  const area = ministryAreaById[row.ministry_id];
  if (area) (servingAreasByPerson[row.person_id] ??= new Set()).add(area);
}

const evalLabelsRaw = readCsv("eval_label.csv");

// ---------------------------------------------------------------- kids-age bands

const CURRENT_YEAR = new Date().getFullYear();
function bandFor(age) {
  for (const [lo, hi] of KID_BANDS) if (age >= lo && age <= hi) return `${lo}-${hi}`;
  return null;
}
function kidBandsOfHousehold(householdId) {
  const bands = new Set();
  for (const birthYear of childrenByHousehold[householdId] ?? []) {
    const b = bandFor(CURRENT_YEAR - birthYear);
    if (b) bands.add(b);
  }
  return bands;
}
function kidBandsOfGroup(groupId) {
  const bands = new Set();
  for (const pid of activeMembersByGroup[groupId] ?? []) {
    const person = personsById[pid];
    if (!person) continue;
    for (const b of kidBandsOfHousehold(person.household_id)) bands.add(b);
  }
  return bands;
}
function groupServingAreas(groupId) {
  const areas = new Set();
  const people = [...(activeMembersByGroup[groupId] ?? []), ...(leadersByGroup[groupId] ?? []).map((l) => l.person_id)];
  for (const pid of people) for (const a of servingAreasByPerson[pid] ?? []) areas.add(a);
  return areas;
}
function hasOverlap(setA, iterableB) {
  for (const x of iterableB) if (setA.has(x)) return true;
  return false;
}

// ---------------------------------------------------------------- hard filters (mirrors generate_seed.py's eligible())

function passesHardFilters(person, profile, group) {
  if (!["open", "forming"].includes(group.status)) return false;
  if ((activeMembersByGroup[group.group_id] ?? []).length >= group.capacity_max) return false;
  if (group.gender_focus === "men" && person.gender !== "M") return false;
  if (group.gender_focus === "women" && person.gender !== "F") return false;
  if (!profile.available_slots.includes(group.meeting_slot)) return false;
  if ((busySlotsByPerson[person.person_id] ?? new Set()).has(group.meeting_slot)) return false;
  if (!group.is_online) {
    const d = miles([householdsById[person.household_id].lat_approx, householdsById[person.household_id].lng_approx],
      [group.lat_approx, group.lng_approx]);
    if (d > RADIUS_MI) return false;
  }
  return true;
}

// ---------------------------------------------------------------- weighted score (spec §5, with documented
// fallbacks where person_features is empty -- see the plan's "Design decisions" section)

function scoreGroup(person, profile, group) {
  const breakdown = {};

  breakdown.life_stage = group.life_stage_focus
    ? (profile.life_stage === group.life_stage_focus ? 30 : 0)
    : (() => {
        const members = (activeMembersByGroup[group.group_id] ?? []).map((pid) => profilesByPerson[pid]).filter(Boolean);
        if (members.length === 0) return 15; // no signal either way
        const matching = members.filter((m) => m.life_stage === profile.life_stage).length;
        return Math.round((matching / members.length) * 30);
      })();

  breakdown.kids_age = hasOverlap(kidBandsOfHousehold(person.household_id), kidBandsOfGroup(group.group_id)) ? 20 : 0;
  breakdown.serving_area = hasOverlap(servingAreasByPerson[person.person_id] ?? new Set(), groupServingAreas(group.group_id)) ? 15 : 0;
  breakdown.consistency = 7.5; // person_features has zero rows; neutral per the spec's own low-confidence guardrail

  const tags = tagsByGroup[group.group_id] ?? [];
  breakdown.interests = hasOverlap(new Set(profile.interests), tags) ? 10 : 0;

  if (group.is_online) {
    breakdown.distance = 5; // exempt from the filter, but not given full in-person credit
  } else {
    const d = miles([householdsById[person.household_id].lat_approx, householdsById[person.household_id].lng_approx],
      [group.lat_approx, group.lng_approx]);
    breakdown.distance = Math.max(0, 10 * (1 - d / RADIUS_MI));
  }

  const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { total, breakdown };
}

function buildGroupMix(groupId) {
  const mix = {};
  for (const pid of activeMembersByGroup[groupId] ?? []) {
    const p = profilesByPerson[pid];
    if (p?.life_stage) mix[p.life_stage] = (mix[p.life_stage] ?? 0) + 1;
  }
  return mix;
}

// ---------------------------------------------------------------- prompt contract rank-v1

// The five sentences are the doc's prompt contract verbatim. response_format:"json_object" only
// constrains the transport-level format -- it doesn't tell the model what shape to produce, and
// without that instruction the model answers in prose/markdown instead (confirmed: every call
// fell back on the first real run until this line was added). So an explicit output-shape
// instruction is appended, matching the contract's own output schema.
const SYSTEM_PROMPT = [
  "You choose up to three small groups for a church member from a shortlist the church already filtered for schedule, distance, gender focus and open seats.",
  "Use only group_ids from the shortlist.",
  "Base the choice on the member's own words and stated preferences compared with each group's description and tags.",
  "Do not infer or mention anything about the member's spiritual state, marriage, health or struggles beyond what they wrote, and never describe the member's personal circumstances.",
  "The rationale is an internal audit note for the groups pastor: refer to group facts and the member's stated preferences.",
  'Respond with a single JSON object only, no other text, no markdown, matching exactly this shape: {"ranked": [{"group_id": <uuid from the shortlist>, "rank": <integer 1 to 3>}], "internal_rationale": <string, 60 words or fewer>, "confidence": "high" | "medium" | "low"}.',
  "The ranked array must contain exactly 3 items when the shortlist has 3 or more groups (or exactly as many as the shortlist has, if fewer) -- always include a third-ranked choice even if it is a weaker fit, never fewer than 3.",
].join(" ");

const OutputSchema = z.object({
  ranked: z.array(z.object({ group_id: z.uuid(), rank: z.number().int().min(1).max(3) })).min(1).max(3),
  internal_rationale: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

function memberPayload(profile) {
  return { life_stage: profile.life_stage, group_pref: profile.group_pref, interests: profile.interests, about_me: profile.about_me };
}
function shortlistPayload(shortlist, { includeScore, shuffle }) {
  const list = shuffle ? seededShuffle(shortlist, SHUFFLE_SEED) : shortlist;
  return list.map((g) => ({
    group_id: g.group_id, name: g.name, description: g.description, tags: tagsByGroup[g.group_id] ?? [],
    meeting_slot: g.meeting_slot, gender_focus: g.gender_focus, life_stage_focus: g.life_stage_focus,
    childcare: g.childcare, is_online: g.is_online, group_mix: buildGroupMix(g.group_id),
    ...(includeScore ? { score: Math.round(g.total * 10) / 10 } : {}),
  }));
}

function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function validateSemantics(parsed, shortlistIds, n) {
  if (parsed.ranked.length !== n) throw new Error(`expected ${n} ranked items, got ${parsed.ranked.length}`);
  const ids = parsed.ranked.map((r) => r.group_id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate group_id in ranked list");
  if (!ids.every((id) => shortlistIds.has(id))) throw new Error("ranked group_id not in shortlist");
  const ranks = parsed.ranked.map((r) => r.rank).sort((a, b) => a - b);
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  if (JSON.stringify(ranks) !== JSON.stringify(expected)) throw new Error(`rank values are not a 1..${n} permutation`);
}

async function callLLM(payload) {
  const t0 = Date.now();
  const resp = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(payload) },
    ],
  });
  return { raw: resp.choices[0].message.content, latency: Date.now() - t0, usage: resp.usage };
}

function scoreOrderFallback(shortlist, n) {
  return shortlist.slice(0, n).map((g, i) => ({ group_id: g.group_id, rank: i + 1 }));
}

async function rankWithRetry(payload, shortlist, shortlistIds, n) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { raw, latency, usage } = await callLLM(payload);
    try {
      const parsed = OutputSchema.parse(JSON.parse(stripCodeFences(raw)));
      validateSemantics(parsed, shortlistIds, n);
      return { ...parsed, latency, usage, fallback: false, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt === 2) {
        return {
          ranked: scoreOrderFallback(shortlist, n),
          internal_rationale: `Fallback: LLM output invalid after retry (${lastErr.message})`,
          confidence: "low",
          latency, usage, fallback: true, attempts: attempt,
          raw_response: raw.slice(0, 500), // kept only on fallback, for diagnosing a bad prompt/model response later
        };
      }
    }
  }
}

// ---------------------------------------------------------------- main loop

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
    stats.costUsd += usage.cost ?? 0; // OpenRouter returns real USD cost per call in usage.cost
  }
}

const evalLabels = evalLabelsRaw.map((r) => ({
  ...r,
  acceptable_group_ids: r.acceptable_group_ids ? r.acceptable_group_ids.split("|").filter(Boolean) : [],
}));

const stats = { A: emptyStats(), B: emptyStats(), C: emptyStats() };
const results = [];
let shortlistRecallHits = 0;

for (const label of evalLabels) {
  const profile = profilesByPerson[label.person_id];
  const person = personsById[label.person_id];
  if (!profile || !person) {
    console.warn(`skip ${label.label_key}: no person/profile found for ${label.person_id}`);
    continue;
  }

  const scored = groupsRows
    .filter((g) => passesHardFilters(person, profile, g))
    .map((g) => {
      const { total, breakdown } = scoreGroup(person, profile, g);
      const d = g.is_online ? null : miles(
        [householdsById[person.household_id].lat_approx, householdsById[person.household_id].lng_approx],
        [g.lat_approx, g.lng_approx]
      );
      return { ...g, total, breakdown, _dist: d ?? Infinity };
    })
    .sort((a, b) => (b.total - a.total) || (a._dist - b._dist) || a.group_id.localeCompare(b.group_id));

  const shortlist = scored.slice(0, SHORTLIST_SIZE);
  const shortlistIds = new Set(shortlist.map((g) => g.group_id));
  const expectedOrAlt = new Set([label.expected_group_id, ...label.acceptable_group_ids]);
  const recall = shortlist.some((g) => expectedOrAlt.has(g.group_id));
  if (recall) shortlistRecallHits++;

  const n = Math.min(3, shortlist.length);

  // variant C: deterministic score order, no LLM call
  const cRanked = scoreOrderFallback(shortlist, n);
  const cTop1 = cRanked[0]?.group_id === label.expected_group_id;
  const cTop3 = cRanked.some((r) => expectedOrAlt.has(r.group_id));
  recordRun(stats.C, { top1: cTop1, top3: cTop3, fallback: false });

  const labelRecord = {
    label_key: label.label_key,
    person_id: label.person_id,
    expected_group_id: label.expected_group_id,
    expected_group_name: label.expected_group_name,
    acceptable_group_ids: label.acceptable_group_ids,
    cue: label.cue,
    shortlist: shortlist.map((g) => ({ group_id: g.group_id, name: g.name, score: Math.round(g.total * 10) / 10, breakdown: g.breakdown })),
    shortlist_recall: recall,
    variants: {
      A: { runs: [] },
      B: { runs: [] },
      C: { ranked: cRanked, top1_hit: cTop1, top3_hit: cTop3 },
    },
  };

  if (n === 0) {
    console.warn(`${label.label_key}: empty shortlist, nothing to rank`);
    results.push(labelRecord);
    continue;
  }

  for (const variant of ["A", "B"]) {
    const payload = {
      member: memberPayload(profile),
      shortlist: shortlistPayload(shortlist, { includeScore: variant === "A", shuffle: variant === "B" }),
    };
    for (let run = 1; run <= RUNS_PER_VARIANT; run++) {
      const out = await rankWithRetry(payload, shortlist, shortlistIds, n);
      const top1 = out.ranked[0]?.group_id === label.expected_group_id;
      const top3 = out.ranked.some((r) => expectedOrAlt.has(r.group_id));
      recordRun(stats[variant], { top1, top3, fallback: out.fallback, latency: out.latency, usage: out.usage });
      labelRecord.variants[variant].runs.push({
        run, ranked: out.ranked, internal_rationale: out.internal_rationale, confidence: out.confidence,
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
      const names = r.ranked.map((x) => groupsRows.find((g) => g.group_id === x.group_id)?.name ?? x.group_id).join(" > ");
      console.log(`  [${variant}${r.run}] ${r.top1_hit ? "HIT " : r.top3_hit ? "top3" : "miss"}  ${names}  (${r.confidence}${r.fallback ? ", FALLBACK" : ""})`);
      console.log(`         "${r.internal_rationale}"`);
    }
  }
  console.log(`  [C]  ${cTop1 ? "HIT " : cTop3 ? "top3" : "miss"}  ${cRanked.map((x) => groupsRows.find((g) => g.group_id === x.group_id)?.name ?? x.group_id).join(" > ")}`);
}

// ---------------------------------------------------------------- stability (per label, per variant)

function computeStability(variant) {
  let stable = 0;
  const perLabel = [];
  for (const rec of results) {
    const picks = rec.variants[variant].runs.map((r) => r.ranked[0]?.group_id);
    if (picks.length === 0) continue;
    const counts = {};
    for (const p of picks) counts[p] = (counts[p] ?? 0) + 1;
    const maxCount = Math.max(...Object.values(counts));
    const isStable = maxCount >= 2;
    if (isStable) stable++;
    perLabel.push({ label_key: rec.label_key, stable: isStable });
  }
  return { stable, total: perLabel.length, perLabel };
}

const stabilityA = computeStability("A");
const stabilityB = computeStability("B");

// ---------------------------------------------------------------- summary + pass mark

const N_LABELS = evalLabels.length;
console.log("\n" + "=".repeat(70));
console.log("SUMMARY");
console.log("=".repeat(70));
console.log(`shortlist recall: ${shortlistRecallHits}/${N_LABELS}`);

function printVariantSummary(name, s, stability) {
  const runsPerLabel = RUNS_PER_VARIANT;
  const labelCount = s.runs / runsPerLabel;
  console.log(`\nVariant ${name} (${s.runs} runs over ${labelCount} labels):`);
  console.log(`  top-1 hits:        ${s.top1}/${s.runs}  (${(s.top1 / s.runs * 100).toFixed(0)}%)`);
  console.log(`  top-3 hits:        ${s.top3}/${s.runs}  (${(s.top3 / s.runs * 100).toFixed(0)}%)`);
  console.log(`  fallbacks:         ${s.fallback}/${s.runs}`);
  console.log(`  avg latency:       ${(s.latencyTotal / s.runs).toFixed(0)} ms`);
  console.log(`  avg tokens:        prompt ${(s.promptTokens / s.runs).toFixed(0)}, completion ${(s.completionTokens / s.runs).toFixed(0)}, total ${(s.totalTokens / s.runs).toFixed(0)}`);
  console.log(`  avg cost:          $${(s.costUsd / s.runs).toFixed(6)}  (total $${s.costUsd.toFixed(4)})`);
  if (stability) console.log(`  stable top-1:      ${stability.stable}/${stability.total} labels (>=2 of ${runsPerLabel} runs agree)`);
}
printVariantSummary("A (scored shortlist)", stats.A, stabilityA);
printVariantSummary("B (shuffled, no scores)", stats.B, stabilityB);
console.log(`\nVariant C (deterministic score order, baseline, no LLM call):`);
console.log(`  top-1 hits: ${stats.C.top1}/${N_LABELS}  top-3 hits: ${stats.C.top3}/${N_LABELS}`);

// pass mark, per label-count (not per-run): top-1/top-3 use the per-label rate across all 3 runs
// averaged -- report against /N_LABELS scaled from the per-run hit rate for readability.
function passMark(name, s, stability) {
  const top1PerLabel = (s.top1 / s.runs) * N_LABELS;
  const top3PerLabel = (s.top3 / s.runs) * N_LABELS;
  const top1Pass = top1PerLabel >= 10;
  const top3Pass = top3PerLabel >= 13;
  const fallbackPass = s.fallback === 0;
  const stabilityPass = stability.stable === stability.total;
  const allPass = top1Pass && top3Pass && fallbackPass && stabilityPass;
  console.log(`\nPass mark -- variant ${name}: ${allPass ? "PASS" : "FAIL"}`);
  console.log(`  top-1 >= 10/14:          ${top1Pass ? "PASS" : "FAIL"}  (${top1PerLabel.toFixed(1)}/14 equivalent)`);
  console.log(`  top-3 >= 13/14:          ${top3Pass ? "PASS" : "FAIL"}  (${top3PerLabel.toFixed(1)}/14 equivalent)`);
  console.log(`  0 fallbacks after retry: ${fallbackPass ? "PASS" : "FAIL"}  (${s.fallback} fallback(s))`);
  console.log(`  stable top-1 all labels: ${stabilityPass ? "PASS" : "FAIL"}  (${stability.stable}/${stability.total})`);
  return allPass;
}
const passA = passMark("A", stats.A, stabilityA);
const passB = passMark("B", stats.B, stabilityB);

// ---------------------------------------------------------------- write full results to disk

const outDir = path.join(ROOT, "eval", "out");
fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(outDir, `rank_eval-${ts}.json`);
fs.writeFileSync(outPath, JSON.stringify({
  generated_at: new Date().toISOString(),
  model: MODEL,
  prompt_version: PROMPT_VERSION,
  n_labels: N_LABELS,
  shortlist_recall: { hits: shortlistRecallHits, of: N_LABELS },
  summary: { A: stats.A, B: stats.B, C: stats.C, stability: { A: stabilityA, B: stabilityB } },
  pass_mark: { A: passA, B: passB },
  labels: results,
}, null, 2));
console.log(`\nFull results written to ${path.relative(ROOT, outPath)}`);
