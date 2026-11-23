// Gathered: the Manager schedule-conflict review contract (architecture §7 "Escalation review",
// §8 AI-reviewed #1 "Hidden schedule conflict"). Pure: no database, no network, so the prompt,
// the output schema and the grounding check are testable offline.
//
// The model's job is narrow: given ONE pending group request, the group's public schedule and
// description, and the requester's supported serving-schedule facts, say whether there is a
// concrete recurring schedule conflict worth showing the Manager. It is advisory. Its output is
// never trusted until it passes this module's validation, and nothing it says is stored unless
// it validates.
import { z } from "zod";

export const REVIEW_PROMPT_VERSION = "schedule-conflict-v1";
export const REVIEW_KIND = "schedule_conflict";
export const SEVERITIES = ["low", "medium", "high"];

/**
 * What each slot code means. This is the application's vocabulary for the codes it sends, not a
 * fact about any person. Times are the Winter Garden campus's Sunday services (service table).
 */
export const SLOT_LEGEND = {
  sun_9: "Sunday first service (9:00)",
  sun_11: "Sunday second service (11:00)",
  sun_pm: "Sunday afternoon, after the services",
};
const DAY = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };
const PART = { am: "morning", pm: "afternoon", eve: "evening" };
export function slotMeaning(slot) {
  if (SLOT_LEGEND[slot]) return SLOT_LEGEND[slot];
  const [d, p] = String(slot).split("_");
  return DAY[d] && PART[p] ? `${DAY[d]} ${PART[p]}` : String(slot);
}

export const REVIEW_SYSTEM_PROMPT = [
  "You help a church's groups pastor review one pending request to join a small group.",
  "Decide whether the supplied facts show a concrete, recurring schedule conflict that is worth the pastor's attention.",
  "Use only the supplied facts. Do not invent service times, durations, travel times or any other schedule detail; if a time is not in the supplied facts, do not state one.",
  "Do not diagnose motives, feelings or personal circumstances, and do not draw conclusions about the person beyond their schedule.",
  "Identify a conflict only when the evidence supports one. A typical case: the person is scheduled to serve at a service, and the group's description says it meets right after that service, so they may routinely arrive late or miss the start.",
  "If the evidence is missing, unclear or does not show a conflict, return raise false. Prefer raise false when unsure.",
  "Write advisory language (for example 'may arrive late'). Do not recommend accepting, declining or changing anything: the pastor decides.",
  'Respond with a single JSON object only, with these keys: "raise" (boolean), "kind" (always "schedule_conflict"), "severity" ("low", "medium" or "high"), "summary" (one or two plain sentences, under 300 characters), "evidence" (an array of 1 to 4 short statements, each restating a supplied fact, each under 240 characters).',
  'When raise is false, give a one-sentence reason in "summary", use "low" for severity, and return an empty "evidence" array.',
].join(" ");

export const ReviewSchema = z.object({
  raise: z.boolean(),
  kind: z.literal(REVIEW_KIND),
  severity: z.enum(SEVERITIES),
  summary: z.string().trim().min(1).max(300),
  evidence: z.array(z.string().trim().min(1).max(240)).max(4),
});

/** The only facts the model is shown for a candidate. Built from stored rows, never from model output. */
export function reviewFacts(c) {
  return {
    task: "Is there a concrete recurring schedule conflict between this person's serving schedule and the group's meeting time?",
    request: { requester_first_name: c.first_name, request_note: c.member_note ?? null },
    group: {
      name: c.group_name,
      description: c.group_description,
      meeting_slot: c.meeting_slot,
      meeting_slot_meaning: slotMeaning(c.meeting_slot),
    },
    requester_schedule: {
      serving_slots: (c.busy_slots ?? []).map((s) => ({ slot: s, meaning: slotMeaning(s) })),
      serving_areas: c.serving_areas ?? [],
      about_me: c.about_me ?? null,
    },
  };
}

// Numbers (times, minutes) in the model's wording must come from the supplied facts. This catches
// invented service or travel times such as "30-40 minutes" that nothing supplied.
const NUMBER = /\d+(?::\d+)?/g;
export function ungroundedNumbers(texts, facts) {
  const haystack = JSON.stringify(facts);
  const bad = [];
  for (const t of texts) for (const n of t.match(NUMBER) ?? []) if (!haystack.includes(n)) bad.push(n);
  return bad;
}

/**
 * Parse and validate one model reply against the supplied facts. Throws on anything that is not
 * a well-formed, grounded result; the caller treats a throw as an invalid attempt.
 */
export function parseReview(raw, facts) {
  let json;
  try {
    json = JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    throw new Error("review output is not valid JSON");
  }
  const parsed = ReviewSchema.parse(json);
  if (parsed.raise && parsed.evidence.length === 0) throw new Error("a raised review needs at least one evidence statement");
  if (!parsed.raise && parsed.evidence.length > 0) throw new Error("a review that is not raised must have no evidence");
  const bad = ungroundedNumbers([parsed.summary, ...parsed.evidence], facts);
  if (bad.length) throw new Error(`review states numbers that were not supplied: ${[...new Set(bad)].join(", ")}`);
  return parsed;
}
