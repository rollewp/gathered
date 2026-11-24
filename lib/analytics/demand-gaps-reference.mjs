// Gathered: reference implementation of the demand-gap cohorts (databricks/sql/demand_gaps.sql).
//
// Used ONLY to reconcile the Databricks output against the seed CSVs with independent code
// (databricks/demand.mjs and scripts/test_demand_gaps.mjs). Pure, no I/O. It restates the rules:
//   population  adults with an opt-in profile and a life stage, and no active group membership
//   demand      per (life_stage, slot): people who listed the slot and are not rostered to serve in it
//   supply      groups open/forming with open seats, meeting in the slot, life_stage_focus empty or equal
//   reach       the app's hard filters on top: gender focus and, for in-person groups, <= 5 miles
import { miles, RADIUS_MI } from "../ranking/reference-shortlist.mjs";

export const MIN_PEOPLE = 5;
export const PRESSURE_HIGH = 4;
export const GAP_CLASSES = ["No current group", "High demand", "Limited reach"];

const parseArr = (s) => (s ?? "").replace(/[{}"]/g, "").split(",").filter(Boolean);

export function classify({ people, groups, seats, unreachable }) {
  if (people < MIN_PEOPLE) return "Not a gap";
  if (groups === 0) return "No current group";
  if (people / seats >= PRESSURE_HIGH) return "High demand";
  if (unreachable >= MIN_PEOPLE && unreachable / people >= 0.5) return "Limited reach";
  return "Served";
}

export function demandGapCohorts({ profiles, people, households, memberships, groups, busySlotsByPerson }) {
  const personById = Object.fromEntries(people.map((p) => [p.person_id, p]));
  const hhById = Object.fromEntries(households.map((h) => [h.household_id, h]));
  const active = {};
  const grouped = new Set();
  for (const m of memberships) if (m.status === "active") { active[m.group_id] = (active[m.group_id] ?? 0) + 1; grouped.add(m.person_id); }

  const open = groups
    .map((g) => ({ ...g, seats: Number(g.capacity_max) - (active[g.group_id] ?? 0) }))
    .filter((g) => ["open", "forming"].includes(g.status) && g.seats > 0);

  const cohorts = new Map(); // key life_stage|slot
  for (const pr of profiles) {
    const p = personById[pr.person_id];
    if (!p || p.household_role !== "adult" || !pr.opted_in_at || !pr.life_stage || grouped.has(pr.person_id)) continue;
    const hh = hhById[p.household_id];
    const busy = new Set(busySlotsByPerson[pr.person_id] ?? []);
    for (const slot of parseArr(pr.available_slots)) {
      if (busy.has(slot)) continue;
      const compatible = open.filter((g) => g.meeting_slot === slot && (!g.life_stage_focus || g.life_stage_focus === pr.life_stage));
      const reachable = compatible.filter((g) => {
        const genderOk = !g.gender_focus || ["mixed", "couples"].includes(g.gender_focus)
          || (g.gender_focus === "men" && p.gender === "M") || (g.gender_focus === "women" && p.gender === "F");
        const nearOk = g.is_online === "True" || miles([Number(hh.lat_approx), Number(hh.lng_approx)], [Number(g.lat_approx), Number(g.lng_approx)]) <= RADIUS_MI;
        return genderOk && nearOk;
      });
      const key = `${pr.life_stage}|${slot}`;
      const c = cohorts.get(key) ?? { life_stage: pr.life_stage, available_slot: slot, people: 0, noCatalog: 0, unreachable: 0, groups: new Set(), seats: 0 };
      c.people++;
      if (compatible.length === 0) c.noCatalog++;
      if (reachable.length === 0) c.unreachable++;
      for (const g of compatible) c.groups.add(g.group_id);
      cohorts.set(key, c);
    }
  }
  // supply is a property of the cohort (every person in it sees the same compatible groups)
  const out = [];
  for (const c of cohorts.values()) {
    const sup = open.filter((g) => g.meeting_slot === c.available_slot && (!g.life_stage_focus || g.life_stage_focus === c.life_stage));
    const seats = sup.reduce((a, g) => a + g.seats, 0);
    out.push({
      life_stage: c.life_stage, available_slot: c.available_slot, opted_in_ungrouped_count: c.people,
      serving_group_count: sup.length, available_seat_count: seats,
      people_without_group_in_catalog: c.noCatalog, people_without_reachable_group: c.unreachable,
      gap_classification: classify({ people: c.people, groups: sup.length, seats, unreachable: c.unreachable }),
    });
  }
  return out.sort((a, b) => (a.life_stage + a.available_slot < b.life_stage + b.available_slot ? -1 : 1));
}
