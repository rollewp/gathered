// Gathered: the ranking contract, version rank-v2. Single source for the app
// (lib/ranking/llm.ts) and the evaluation script (scripts/rank_eval.mjs), so what is evaluated
// is what ships. Pure module: no I/O, no secrets.
//
// rank-v2 = rank-v1 plus each shortlisted group's `status` and `open_seats` (the fix suggested by
// the rank-v1 evaluation, where variant B picked an established group over a forming one).
//
// Output size: the model returns BETWEEN 1 AND 3 groups, never padded to three. A group is
// included only when the member's own words and stated preferences, read against that group's
// public facts, positively support it. Fewer than three is a valid, complete answer.
import { z } from "zod";

export const PROMPT_VERSION = "rank-v2";

// The first five sentences are the architecture's prompt contract (§5.5). The last two pin the
// output shape: response_format json_object constrains transport only, not the shape.
export const SYSTEM_PROMPT = [
  "You choose up to three small groups for a church member from a shortlist the church already filtered for schedule, distance, gender focus and open seats.",
  "Use only group_ids from the shortlist.",
  "Base the choice on the member's own words and stated preferences compared with each group's description and tags. Each group also shows its status (forming or open) and its open_seats.",
  "Do not infer or mention anything about the member's spiritual state, marriage, health or struggles beyond what they wrote, and never describe the member's personal circumstances.",
  "The rationale is an internal audit note for the groups pastor: refer to group facts and the member's stated preferences.",
  'Respond with a single JSON object only, no other text, no markdown, matching exactly this shape: {"ranked": [{"group_id": <uuid from the shortlist>, "rank": <integer 1 to 3>}], "internal_rationale": <string, 60 words or fewer>, "confidence": "high" | "medium" | "low"}.',
  "The ranked array holds between 1 and 3 items, best first. Include a group only if you can positively support it from the member's own words and stated preferences together with that group's public facts. Do not add a group just to reach three: returning fewer than three is correct when fewer fit. Always return at least the single best-supported group.",
].join(" ");

export const OutputSchema = z.object({
  ranked: z.array(z.object({ group_id: z.uuid(), rank: z.number().int().min(1).max(3) })).min(1).max(3),
  internal_rationale: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});

/** Member side of the prompt input: stated preferences and own words only. No name, attendance or address. */
export function memberPayload(profile) {
  return { life_stage: profile.life_stage, group_pref: profile.group_pref, interests: profile.interests, about_me: profile.about_me };
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rand = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @param {object[]} items shortlist items with group_id, name, description, tags, meeting_slot,
 *   gender_focus, life_stage_focus, childcare, is_online, status, open_seats, group_mix, score
 * @param {{includeScore:boolean, shuffleSeed?:number}} opts
 */
export function shortlistPayload(items, { includeScore, shuffleSeed }) {
  const list = shuffleSeed === undefined ? items : seededShuffle(items, shuffleSeed);
  return list.map((g) => ({
    group_id: g.group_id, name: g.name, description: g.description, tags: g.tags,
    meeting_slot: g.meeting_slot, gender_focus: g.gender_focus, life_stage_focus: g.life_stage_focus,
    childcare: g.childcare, is_online: g.is_online, status: g.status, open_seats: g.open_seats,
    group_mix: g.group_mix,
    ...(includeScore ? { score: Math.round(Number(g.score) * 10) / 10 } : {}),
  }));
}

export function stripCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

/**
 * Throws unless the parsed output is a valid ordered subset of the shortlist with between 1 and
 * `max` items (max = min(3, shortlist size)). Fewer than `max` is valid: nothing forces a fill.
 */
export function validateSemantics(parsed, shortlistIds, max) {
  const n = parsed.ranked.length;
  if (n < 1 || n > max) throw new Error(`expected between 1 and ${max} ranked items, got ${n}`);
  const ids = parsed.ranked.map((r) => r.group_id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate group_id in ranked list");
  if (!ids.every((id) => shortlistIds.has(id))) throw new Error("ranked group_id not in shortlist");
  const ranks = parsed.ranked.map((r) => r.rank).sort((a, b) => a - b);
  const expected = Array.from({ length: n }, (_, i) => i + 1);
  if (JSON.stringify(ranks) !== JSON.stringify(expected)) throw new Error(`rank values are not a 1..${n} permutation`);
}

/** Parse and validate a raw model response; returns 1..max ranked group ids in rank order. */
export function parseRanking(raw, shortlistIds, max) {
  const parsed = OutputSchema.parse(JSON.parse(stripCodeFences(raw)));
  validateSemantics(parsed, shortlistIds, max);
  const orderedIds = [...parsed.ranked].sort((a, b) => a.rank - b.rank).map((r) => r.group_id);
  return { orderedIds, internal_rationale: parsed.internal_rationale, confidence: parsed.confidence };
}

export function scoreOrderFallback(shortlistIds, n) {
  return shortlistIds.slice(0, n);
}
