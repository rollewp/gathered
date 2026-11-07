// Gathered: reference (JavaScript) implementation of the deterministic stage: hard filters,
// weighted score and shortlist (architecture §5.2–5.4).
//
// The deployed implementation is app.recommendation_shortlist() in migration 0004. This module is
// the reference used by the evaluation script (scripts/rank_eval.mjs) and by the parity test
// (scripts/test_recommendations.mjs), which fails if the two ever disagree.
//
// Inputs are rows from the app schema, with person_features as the single source of busy slots,
// serving areas and kids-age bands (no formulas are re-derived here).

export const RADIUS_MI = 5;
export const SHORTLIST_SIZE = 6;
export const NEUTRAL_CONSISTENCY = 7.5; // consistency factor is neutral until Databricks parity (architecture §3b)

export function miles(a, b) {
  const [la1, lo1] = a, [la2, lo2] = b;
  const p = Math.PI / 180;
  const d = 0.5 - Math.cos((la2 - la1) * p) / 2
    + Math.cos(la1 * p) * Math.cos(la2 * p) * (1 - Math.cos((lo2 - lo1) * p)) / 2;
  return 7917.5 * Math.asin(Math.sqrt(d));
}

const overlaps = (a, b) => { const s = new Set(a); return b.some((x) => s.has(x)); };

export function buildContext({ persons, households, profiles, groups, tags, leaders, activeMemberships, features }) {
  const ctx = {
    groups,
    personsById: Object.fromEntries(persons.map((p) => [p.person_id, p])),
    householdsById: Object.fromEntries(households.map((h) => [h.household_id, h])),
    profilesByPerson: Object.fromEntries(profiles.map((p) => [p.person_id, p])),
    featuresByPerson: Object.fromEntries(features.map((f) => [f.person_id, f])),
    tagsByGroup: {}, leadersByGroup: {}, activeMembersByGroup: {},
  };
  for (const t of tags) (ctx.tagsByGroup[t.group_id] ??= []).push(t.tag);
  for (const l of leaders) (ctx.leadersByGroup[l.group_id] ??= []).push(l.person_id);
  for (const m of activeMemberships) (ctx.activeMembersByGroup[m.group_id] ??= []).push(m.person_id);
  return ctx;
}

const feat = (ctx, pid) => ctx.featuresByPerson[pid] ?? { busy_slots: [], serving_areas: [], kids_age_bands: [] };
const homeOf = (ctx, person) => {
  const h = ctx.householdsById[person.household_id];
  return [Number(h.lat_approx), Number(h.lng_approx)];
};

export function passesHardFilters(ctx, person, profile, group) {
  if (!["open", "forming"].includes(group.status)) return false;
  if ((ctx.activeMembersByGroup[group.group_id] ?? []).length >= group.capacity_max) return false;
  if (group.gender_focus === "men" && person.gender !== "M") return false;
  if (group.gender_focus === "women" && person.gender !== "F") return false;
  if (!profile.available_slots.includes(group.meeting_slot)) return false;
  if (feat(ctx, person.person_id).busy_slots.includes(group.meeting_slot)) return false;
  if (!group.is_online && miles(homeOf(ctx, person), [Number(group.lat_approx), Number(group.lng_approx)]) > RADIUS_MI) return false;
  return true;
}

export function scoreGroup(ctx, person, profile, group) {
  const members = ctx.activeMembersByGroup[group.group_id] ?? [];
  const breakdown = {};

  breakdown.life_stage = group.life_stage_focus
    ? (profile.life_stage === group.life_stage_focus ? 30 : 0)
    : (() => {
        const profs = members.map((pid) => ctx.profilesByPerson[pid]).filter(Boolean);
        if (profs.length === 0) return 15;
        return Math.round((profs.filter((m) => m.life_stage === profile.life_stage).length / profs.length) * 30);
      })();

  const groupBands = members.flatMap((pid) => feat(ctx, pid).kids_age_bands);
  breakdown.kids_age = overlaps(feat(ctx, person.person_id).kids_age_bands, groupBands) ? 20 : 0;

  const groupAreas = [...members, ...(ctx.leadersByGroup[group.group_id] ?? [])].flatMap((pid) => feat(ctx, pid).serving_areas);
  breakdown.serving_area = overlaps(feat(ctx, person.person_id).serving_areas, groupAreas) ? 15 : 0;

  breakdown.consistency = NEUTRAL_CONSISTENCY;
  breakdown.interests = overlaps(profile.interests ?? [], ctx.tagsByGroup[group.group_id] ?? []) ? 10 : 0;

  breakdown.distance = group.is_online
    ? 5
    : Math.max(0, 10 * (1 - miles(homeOf(ctx, person), [Number(group.lat_approx), Number(group.lng_approx)]) / RADIUS_MI));

  return { total: Object.values(breakdown).reduce((a, b) => a + b, 0), breakdown };
}

export function groupMix(ctx, groupId) {
  const mix = {};
  for (const pid of ctx.activeMembersByGroup[groupId] ?? []) {
    const stage = ctx.profilesByPerson[pid]?.life_stage;
    if (stage) mix[stage] = (mix[stage] ?? 0) + 1;
  }
  return mix;
}

/** Hard filters, score, order (score desc, distance asc, group_id asc) and cut to the shortlist size. */
export function shortlistFor(ctx, personId) {
  const person = ctx.personsById[personId];
  const profile = ctx.profilesByPerson[personId];
  if (!person || !profile) return [];
  return ctx.groups
    .filter((g) => passesHardFilters(ctx, person, profile, g))
    .map((g) => {
      const { total, breakdown } = scoreGroup(ctx, person, profile, g);
      const dist = g.is_online ? Infinity : miles(homeOf(ctx, person), [Number(g.lat_approx), Number(g.lng_approx)]);
      return { ...g, total, breakdown, _dist: dist };
    })
    .sort((a, b) => (b.total - a.total) || (a._dist - b._dist) || (a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : 0))
    .slice(0, SHORTLIST_SIZE);
}
