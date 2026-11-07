// Gathered: person_features formulas.
//
// BOOTSTRAP IMPLEMENTATION of the Databricks output contract (architecture §3b). This module is
// the single definition of the formulas for local development and recovery; it is not the
// deployed analytical architecture. Databricks remains the intended producer, and must reach
// schema and value parity with this module on the synthetic dataset before cutover.
//
// Pure functions: no I/O, no clock. "As of" is derived from the data (latest service date), so
// the same inputs always give the same output and a rerun never changes unchanged rows.
//
// Matching-relevant columns, used by the shortlist: busy_slots, serving_areas, kids_age_bands.
// The attendance-derived columns are written per the architecture §3b contract. The Slice 1
// scorer keeps the consistency factor neutral (7.5), as the evaluation did.
//
// Bootstrap definitions (to be confirmed against the Databricks job at parity):
//   observed_weeks_12w   distinct weeks in the last 12 with at least one attendance signal
//   attendance_rate_12w  observed_weeks_12w / 12
//   consistency_score    longest run of consecutive observed weeks in the last 12, / 12
//   online_share_12w     livestream-signal weeks / observed weeks (null if none observed)
//   signal_confidence    high: kiosk/app signal in last 8 weeks, or weekly server with a roster
//                        signal in last 8; medium: livestream or occasional serving in last 12;
//                        low: otherwise
//   busy_slots           every schedule_slot the person is assigned to serve
//   serving_areas        the areas of the ministries the person serves in
//   kids_age_bands       age bands of the children in the person's household
//   tenure_months        whole months from first_attended_on to the as-of date

export const KID_BANDS = [[0, 4], [5, 12], [13, 18]];
const DAY_MS = 86_400_000;
const ymd = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));

export function bandFor(age) {
  for (const [lo, hi] of KID_BANDS) if (age >= lo && age <= hi) return `${lo}-${hi}`;
  return null;
}

const round4 = (x) => Math.round(x * 10000) / 10000;
const sortedArray = (set) => [...set].sort();

/**
 * @param {object} src
 * @param {object[]} src.people            person.csv rows (person_id, household_id, household_role, birth_year, first_attended_on)
 * @param {object[]} src.servingAssignments serving_assignment.csv rows
 * @param {object[]} src.ministries        ministry.csv rows
 * @param {object[]} src.services          service.csv rows
 * @param {object[]} src.attendance        attendance_event.csv rows
 * @returns {{asOf:string, rows:Map<string,object>}} one row per adult, keyed by person_id
 */
export function computePersonFeatures({ people, servingAssignments, ministries, services, attendance }) {
  const asOfMs = Math.max(...services.map((s) => ymd(s.service_date)));
  const asOf = new Date(asOfMs).toISOString().slice(0, 10);
  const asOfYear = new Date(asOfMs).getUTCFullYear();
  const serviceDate = Object.fromEntries(services.map((s) => [s.service_id, s.service_date]));
  const weekIndex = (date) => Math.floor((asOfMs - ymd(date)) / (7 * DAY_MS));

  const kidBandsByHousehold = {};
  for (const p of people) {
    if (p.household_role !== "child") continue;
    const b = bandFor(asOfYear - Number(p.birth_year));
    if (b) (kidBandsByHousehold[p.household_id] ??= new Set()).add(b);
  }

  const areaByMinistry = Object.fromEntries(ministries.map((m) => [m.ministry_id, m.area]));
  const busy = {}, areas = {}, weeklyServer = new Set();
  for (const a of servingAssignments) {
    (busy[a.person_id] ??= new Set()).add(a.schedule_slot);
    const area = areaByMinistry[a.ministry_id];
    if (area) (areas[a.person_id] ??= new Set()).add(area);
    if (a.frequency === "weekly") weeklyServer.add(a.person_id);
  }

  // A kiosk row counts for the adult who checked the child in; a livestream session counts as
  // attended at 20+ minutes (architecture §3b).
  const signals = {};
  for (const e of attendance) {
    const date = serviceDate[e.service_id];
    if (!date) continue;
    let adult;
    if (e.channel === "kiosk") adult = e.checked_in_by;
    else if (e.channel === "livestream") adult = Number(e.minutes_watched) >= 20 ? e.person_id : null;
    else adult = e.person_id;
    if (adult) (signals[adult] ??= []).push({ channel: e.channel, date, week: weekIndex(date) });
  }

  const rows = new Map();
  for (const p of people) {
    if (p.household_role !== "adult") continue;
    const sig = signals[p.person_id] ?? [];
    const in12 = sig.filter((s) => s.week >= 0 && s.week < 12);
    const in8 = in12.filter((s) => s.week < 8);

    const weeks = new Set(in12.map((s) => s.week));
    const liveWeeks = new Set(in12.filter((s) => s.channel === "livestream").map((s) => s.week));
    let streak = 0, best = 0;
    for (let w = 0; w < 12; w++) { streak = weeks.has(w) ? streak + 1 : 0; best = Math.max(best, streak); }

    const has8 = (...ch) => in8.some((s) => ch.includes(s.channel));
    const confidence = has8("kiosk", "app_geofence") || (weeklyServer.has(p.person_id) && has8("serving_roster"))
      ? "high"
      : in12.some((s) => s.channel === "livestream" || s.channel === "serving_roster") ? "medium" : "low";

    let tenure = null;
    if (p.first_attended_on) {
      const f = new Date(ymd(p.first_attended_on)), a = new Date(asOfMs);
      tenure = (a.getUTCFullYear() - f.getUTCFullYear()) * 12 + (a.getUTCMonth() - f.getUTCMonth())
        - (a.getUTCDate() < f.getUTCDate() ? 1 : 0);
    }

    rows.set(p.person_id, {
      person_id: p.person_id,
      observed_weeks_12w: weeks.size,
      attendance_rate_12w: round4(weeks.size / 12),
      signal_sources: sortedArray(new Set(in12.map((s) => s.channel))),
      signal_confidence: confidence,
      online_share_12w: weeks.size ? round4(liveWeeks.size / weeks.size) : null,
      consistency_score: round4(best / 12),
      busy_slots: sortedArray(busy[p.person_id] ?? []),
      serving_areas: sortedArray(areas[p.person_id] ?? []),
      kids_age_bands: sortedArray(kidBandsByHousehold[p.household_id] ?? []),
      tenure_months: tenure,
      last_attended_on: sig.length ? sig.reduce((m, s) => (s.date > m ? s.date : m), "0000-00-00") : null,
    });
  }
  return { asOf, rows };
}

/** Column order of the app.person_features contract (computed_at is set on write). */
export const FEATURE_COLUMNS = [
  "person_id", "observed_weeks_12w", "attendance_rate_12w", "signal_sources", "signal_confidence",
  "online_share_12w", "consistency_score", "busy_slots", "serving_areas", "kids_age_bands",
  "tenure_months", "last_attended_on",
];
