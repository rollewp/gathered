// Gathered: OFFLINE validation of the synthetic seed (no Lakebase, no OpenRouter, no network).
//
//   node scripts/seed_validate.mjs [--dir seed/out] [--determinism] [--no-report]
//
//   --determinism   regenerate twice into temp folders with seed/generate_seed.py and compare every file
//                   byte for byte with each other and with the checked output
//   --no-report     print results only; by default seed/SYNTHETIC_DATA_REPORT.md is (re)written
//
// Checks identity, referential integrity, scale targets, distributions, named personas and the evaluation
// suite. Candidate analysis uses the real reference implementation of the deterministic stage
// (lib/ranking/reference-shortlist.mjs) and the bootstrap feature formulas (lib/features/person-features.mjs)
// on the CSVs in memory. Exit code 1 if any integrity or identity check fails.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseCsv } from "../lib/seed/csv.mjs";
import { computePersonFeatures } from "../lib/features/person-features.mjs";
import { buildContext, shortlistFor, passesHardFilters, scoreGroup, miles, groupMix, RADIUS_MI, SHORTLIST_SIZE } from "../lib/ranking/reference-shortlist.mjs";
import { memberPayload, shortlistPayload, PROMPT_VERSION } from "../lib/ranking/rank-v2.mjs";
import { parseLabels, partitionLabels, originalLabelMatcher, validateLabelSchema, OUTCOME_TYPES } from "../lib/seed/eval-labels.mjs";

const t0 = Date.now();
const ROOT = path.join(import.meta.dirname, "..");
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const DIR = path.resolve(arg("--dir") ?? path.join(ROOT, "seed", "out"));
const DO_DET = process.argv.includes("--determinism");
const WRITE_REPORT = !process.argv.includes("--no-report");

const read = (f, dir = DIR) => {
  const rows = parseCsv(fs.readFileSync(path.join(dir, f), "utf8"));
  const header = rows[0];
  return rows.slice(1).filter((r) => r.length > 1 || r[0] !== "").map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
};
const arr = (s) => (s && s !== "{}" ? s.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : []);
const bool = (s) => s === "True" || s === "true" || s === "t";
const count = (xs, f = (x) => x) => { const m = {}; for (const x of xs) { const k = f(x); m[k] = (m[k] ?? 0) + 1; } return m; };
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const sortedEntries = (o) => Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

// ------------------------------------------------------------------ load
const FILES = ["household", "person", "member_profile", "portal_user", "service", "attendance_event", "ministry", "serving_assignment", "grp",
  "group_tag", "group_leader", "group_membership", "group_meeting", "meeting_attendance", "join_request", "escalation", "audit_log", "eval_label",
  "_truth_household", "_truth_person", "_truth_group"];
const T = Object.fromEntries(FILES.map((f) => [f, read(`${f}.csv`)]));
const personas = JSON.parse(fs.readFileSync(path.join(DIR, "personas.json"), "utf8"));
const stable = JSON.parse(fs.readFileSync(path.join(ROOT, "seed", "stable_ids.json"), "utf8"));
const genSrc = fs.readFileSync(path.join(ROOT, "seed", "generate_seed.py"), "utf8");
const genVersion = (genSrc.match(/GENERATOR_VERSION = "([^"]+)"/) ?? [])[1] ?? "unknown";

const byId = (rows, k) => Object.fromEntries(rows.map((r) => [r[k], r]));
const person = byId(T.person, "person_id"), hh = byId(T.household, "household_id"), grp = byId(T.grp, "group_id");
const profile = byId(T.member_profile, "person_id");
const adultsList = T.person.filter((p) => p.household_role === "adult");
const childrenList = T.person.filter((p) => p.household_role === "child");

// ------------------------------------------------------------------ check harness
const results = []; // {area, name, ok, detail}
const check = (area, name, ok, detail = "") => results.push({ area, name, ok: !!ok, detail: ok ? "" : String(detail) });
const uniq = (rows, keys) => { const s = new Set(); let dup = 0; for (const r of rows) { const k = keys.map((c) => r[c]).join("|"); if (s.has(k)) dup++; s.add(k); } return dup; };
const fk = (rows, col, set, allowBlank = false) => rows.filter((r) => !(allowBlank && r[col] === "") && !set.has(r[col])).length;

// ---- identity
check("identity", "RNG seed is 516 in the generator", /^SEED = 516$/m.test(genSrc));
for (const [k, id] of Object.entries(stable.personas)) check("identity", `persona ${k} keeps its id`, person[id], id);
for (const p of personas) check("identity", `personas.json ${p.key} resolves to a person with role ${p.role}`, person[p.person_id] && stable.personas[p.key] === p.person_id, p.person_id);
for (const [email, id] of Object.entries(stable.portal_users)) check("identity", `portal user ${email} keeps its id`, T.portal_user.some((u) => u.user_id === id && u.email === email));
for (const [name, id] of Object.entries(stable.groups)) check("identity", `group "${name}" keeps its id`, grp[id]?.name === name, name);
for (const [k, v] of Object.entries(stable.eval_labels)) {
  const row = T.eval_label.find((r) => r.person_id === v.person_id && (k.startsWith("persona|") ? r.label_key === "persona" : r.label_key === k));
  check("identity", `evaluation label ${k.split("|")[0]} preserved (member, expected group, alternates)`, row && row.expected_group_id === v.expected_group_id && row.acceptable_group_ids === v.acceptable_group_ids, k);
}
for (const id of stable.join_requests) check("identity", `join request ${id.slice(0, 8)} keeps its id`, T.join_request.some((r) => r.request_id === id));

// ---- referential integrity
const ids = {
  household: new Set(T.household.map((r) => r.household_id)), person: new Set(T.person.map((r) => r.person_id)), grp: new Set(T.grp.map((r) => r.group_id)),
  meeting: new Set(T.group_meeting.map((r) => r.meeting_id)), service: new Set(T.service.map((r) => r.service_id)), ministry: new Set(T.ministry.map((r) => r.ministry_id)),
  user: new Set(T.portal_user.map((r) => r.user_id)),
};
const PK = [["household", ["household_id"]], ["person", ["person_id"]], ["member_profile", ["person_id"]], ["portal_user", ["user_id"]], ["service", ["service_id"]],
  ["ministry", ["ministry_id"]], ["grp", ["group_id"]], ["group_tag", ["group_id", "tag"]], ["group_leader", ["group_id", "person_id"]],
  ["group_membership", ["group_id", "person_id"]], ["group_meeting", ["meeting_id"]], ["meeting_attendance", ["meeting_id", "person_id"]], ["join_request", ["request_id"]]];
for (const [t, keys] of PK) check("integrity", `${t}: primary key unique`, uniq(T[t], keys) === 0, `${uniq(T[t], keys)} duplicates`);
const FKS = [["person.household_id", T.person, "household_id", ids.household], ["member_profile.person_id", T.member_profile, "person_id", ids.person],
  ["portal_user.person_id", T.portal_user, "person_id", ids.person], ["group_tag.group_id", T.group_tag, "group_id", ids.grp],
  ["group_leader.group_id", T.group_leader, "group_id", ids.grp], ["group_leader.person_id", T.group_leader, "person_id", ids.person],
  ["group_membership.group_id", T.group_membership, "group_id", ids.grp], ["group_membership.person_id", T.group_membership, "person_id", ids.person],
  ["group_meeting.group_id", T.group_meeting, "group_id", ids.grp], ["meeting_attendance.meeting_id", T.meeting_attendance, "meeting_id", ids.meeting],
  ["meeting_attendance.person_id", T.meeting_attendance, "person_id", ids.person], ["attendance_event.person_id", T.attendance_event, "person_id", ids.person],
  ["attendance_event.service_id", T.attendance_event, "service_id", ids.service], ["serving_assignment.person_id", T.serving_assignment, "person_id", ids.person],
  ["serving_assignment.ministry_id", T.serving_assignment, "ministry_id", ids.ministry], ["join_request.person_id", T.join_request, "person_id", ids.person],
  ["join_request.group_id", T.join_request, "group_id", ids.grp], ["eval_label.person_id", T.eval_label, "person_id", ids.person],
  ["_truth_household.household_id", T._truth_household, "household_id", ids.household], ["_truth_person.person_id", T._truth_person, "person_id", ids.person],
  ["_truth_group.group_id", T._truth_group, "group_id", ids.grp]];
for (const [name, rows, col, set] of FKS) check("integrity", `${name} resolves`, fk(rows, col, set) === 0, `${fk(rows, col, set)} dangling`);
check("integrity", "attendance_event.checked_in_by resolves to an adult in the child's household",
  T.attendance_event.filter((e) => e.checked_in_by).every((e) => person[e.checked_in_by]?.household_id === person[e.person_id]?.household_id && person[e.checked_in_by].household_role === "adult"));
check("integrity", "eval_label expected / alternate / excluded groups resolve",
  T.eval_label.every((l) => [l.expected_group_id, ...l.acceptable_group_ids.split("|"), ...l.excluded_group_ids.split("|")].filter(Boolean).every((g) => ids.grp.has(g))));
check("integrity", "portal users: one per persona, roles match personas.json",
  T.portal_user.length === personas.length && personas.every((p) => T.portal_user.some((u) => u.person_id === p.person_id && u.role === p.role)));
check("integrity", "member_profile belongs to adults only", T.member_profile.every((m) => person[m.person_id]?.household_role === "adult"));

// ---- loader and consumer compatibility (headers must match name for name and in order: COPY uses HEADER MATCH)
{
  const loader = fs.readFileSync(path.join(ROOT, "scripts", "load_seed.mjs"), "utf8");
  const tables = [...loader.matchAll(/\{ table: "(\w+)", file: "([\w.]+)",\s*columns: \[([^\]]*)\]/g)].map((m) => ({ table: m[1], file: m[2], cols: [...m[3].matchAll(/"(\w+)"/g)].map((x) => x[1]) }));
  check("loader", "scripts/load_seed.mjs table list was parsed", tables.length === 13, `parsed ${tables.length}`);
  for (const { table, file, cols } of tables) {
    const header = parseCsv(fs.readFileSync(path.join(DIR, file), "utf8"))[0];
    check("loader", `${file}: header equals the loader's column list`, JSON.stringify(header) === JSON.stringify(cols), header.join(","));
  }
  const need = { "person.csv": ["person_id", "household_id", "household_role", "birth_year", "first_attended_on"], "serving_assignment.csv": ["person_id", "ministry_id", "schedule_slot", "frequency"],
    "ministry.csv": ["ministry_id", "area"], "service.csv": ["service_id", "service_date", "slot", "livestreamed"], "attendance_event.csv": ["person_id", "service_id", "channel", "checked_in_by", "minutes_watched"],
    "eval_label.csv": ["person_id", "label_key", "expected_group_id", "expected_group_name", "acceptable_group_ids", "cue"], "household.csv": ["household_id", "lat_approx", "lng_approx"] };
  for (const [file, cols] of Object.entries(need)) {
    const header = parseCsv(fs.readFileSync(path.join(DIR, file), "utf8"))[0];
    check("loader", `${file}: columns used by features, evaluation and tests are present`, cols.every((c) => header.includes(c)), header.join(","));
  }
}

// ---- schema constraints (migration 0001) and rules
const LIFE = new Set(["single", "married_no_kids", "young_kids", "school_age_kids", "teens", "empty_nest", "retired"]);
const SLOTS = new Set(["sun_9", "sun_11", "sun_pm", "mon_eve", "tue_am", "tue_eve", "wed_am", "wed_eve", "thu_am", "thu_eve", "sat_am"]);
check("schema", "person.gender in (M, F); is_synthetic true for every person", T.person.every((p) => ["M", "F"].includes(p.gender) && bool(p.is_synthetic)));
check("schema", "member_profile life_stage / group_pref / slots within the allowed values",
  T.member_profile.every((m) => LIFE.has(m.life_stage) && ["", "men", "women", "mixed", "couples"].includes(m.group_pref) && arr(m.available_slots).every((s) => SLOTS.has(s)) && arr(m.available_slots).length > 0));
check("schema", "grp status / gender_focus / life_stage_focus / meeting_slot within the allowed values",
  T.grp.every((g) => ["forming", "open", "full", "closed", "multiplying"].includes(g.status) && ["men", "women", "mixed", "couples"].includes(g.gender_focus) && (g.life_stage_focus === "" || LIFE.has(g.life_stage_focus)) && SLOTS.has(g.meeting_slot)));
check("schema", "group_membership / join_request status within the allowed values",
  T.group_membership.every((m) => ["active", "left"].includes(m.status)) && T.join_request.every((j) => ["requested", "accepted", "declined", "withdrawn", "expired"].includes(j.status)));
check("schema", "at most one open join request per person and group (migration 0006 index)", uniq(T.join_request.filter((j) => j.status === "requested"), ["person_id", "group_id"]) === 0);

const active = T.group_membership.filter((m) => m.status === "active");
const activeBy = {}; for (const m of active) (activeBy[m.group_id] ??= []).push(m.person_id);
const leadersOf = {}; for (const l of T.group_leader) (leadersOf[l.group_id] ??= []).push(l.person_id);
const leaderGroups = count(T.group_leader, (l) => l.person_id);
check("rules", "no group is over capacity", T.grp.every((g) => (activeBy[g.group_id]?.length ?? 0) <= Number(g.capacity_max)), T.grp.filter((g) => (activeBy[g.group_id]?.length ?? 0) > Number(g.capacity_max)).map((g) => g.name).join("; "));
check("rules", "every group marked full has active members at capacity", T.grp.filter((g) => g.status === "full").every((g) => (activeBy[g.group_id]?.length ?? 0) >= Number(g.capacity_max)), T.grp.filter((g) => g.status === "full" && (activeBy[g.group_id]?.length ?? 0) < Number(g.capacity_max)).map((g) => g.name).join("; "));
check("rules", "forming groups have 0 to 6 members", T.grp.filter((g) => g.status === "forming").every((g) => (activeBy[g.group_id]?.length ?? 0) <= 6));
check("rules", "no person is an active member of two groups", Object.values(count(active, (m) => m.person_id)).every((n) => n === 1));
check("rules", "no leader is also an active member", T.group_leader.every((l) => !active.some((m) => m.person_id === l.person_id)));
check("rules", "no leader leads more than 2 groups (escalation rule 4)", Object.values(leaderGroups).every((n) => n <= 2));
check("rules", "every group has a leader, and its location is the leader's household (W11)",
  T.grp.every((g) => leadersOf[g.group_id]?.length >= 1 && leadersOf[g.group_id].some((p) => { const h = hh[person[p].household_id]; return Number(h.lat_approx) === Number(g.lat_approx) && Number(h.lng_approx) === Number(g.lng_approx); })));
check("rules", "left memberships have left_at after joined_at; active ones have none", T.group_membership.every((m) => (m.status === "left" ? m.left_at > m.joined_at : m.left_at === "")));
check("rules", "membership joined_at is not before the person first attended (active and left)",
  T.group_membership.every((m) => m.joined_at.slice(0, 10) >= person[m.person_id].first_attended_on), T.group_membership.filter((m) => m.joined_at.slice(0, 10) < person[m.person_id].first_attended_on).length + " violations");
check("rules", "meeting attendance only for people who were active members on the meeting date", (() => {
  const mem = {}; for (const m of T.group_membership) (mem[`${m.group_id}|${m.person_id}`] = m);
  const meet = byId(T.group_meeting, "meeting_id");
  return T.meeting_attendance.every((a) => { const mt = meet[a.meeting_id]; const m = mem[`${mt.group_id}|${a.person_id}`]; return m && m.joined_at.slice(0, 10) <= mt.met_on && (!m.left_at || mt.met_on < m.left_at.slice(0, 10)); });
})());
check("rules", "accepted join requests with a decision date have a matching active membership or a later departure",
  T.join_request.filter((j) => j.status === "accepted").every((j) => T.group_membership.some((m) => m.group_id === j.group_id && m.person_id === j.person_id)));
check("rules", "app_geofence events only for households that opted in", T.attendance_event.filter((e) => e.channel === "app_geofence").every((e) => bool(hh[person[e.person_id].household_id].checkin_app_opt_in)));
check("rules", "pending requests only reference open, full or forming groups", T.join_request.filter((j) => j.status === "requested").every((j) => ["open", "forming", "full"].includes(grp[j.group_id].status)));
check("rules", "no street-address-like text in group descriptions or member text",
  ![...T.grp.map((g) => g.description), ...T.member_profile.map((m) => m.about_me)].some((t) => /\b\d{2,5}\s+[A-Z][a-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Lane|Dr|Drive|Ct|Court|Way)\b/.test(t)));
check("rules", "no giving data present (W1): no gift/donation/tithe columns", !FILES.some((f) => Object.keys(T[f][0] ?? {}).some((c) => /gift|donat|tithe|giving/i.test(c))));

// ------------------------------------------------------------------ determinism (optional)
let determinism = { ran: false };
if (DO_DET) {
  const sha = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  const genTimes = [];
  const runDir = (tag) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), `gathered-seed-${tag}-`));
    let py = "python";
    try { execFileSync(py, ["--version"], { stdio: "ignore" }); } catch { py = "python3"; }
    const s = Date.now();
    execFileSync(py, [path.join(ROOT, "seed", "generate_seed.py"), "--out", d], { stdio: "ignore" });
    genTimes.push((Date.now() - s) / 1000);
    return d;
  };
  const d1 = runDir("a"), d2 = runDir("b");
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".csv") || f === "personas.json").sort();
  const diffAB = files.filter((f) => sha(path.join(d1, f)) !== sha(path.join(d2, f)));
  const diffCur = files.filter((f) => !fs.existsSync(path.join(d1, f)) || sha(path.join(d1, f)) !== sha(path.join(DIR, f)));
  determinism = { ran: true, files: files.length, runsEqual: diffAB.length === 0, matchesChecked: diffCur.length === 0, diffAB, diffCur, genSeconds: genTimes };
  fs.rmSync(d1, { recursive: true, force: true }); fs.rmSync(d2, { recursive: true, force: true });
  check("determinism", `two consecutive generations are byte-identical (${files.length} files)`, determinism.runsEqual, diffAB.join(", "));
  check("determinism", "regeneration reproduces the checked-in seed/out", determinism.matchesChecked, diffCur.join(", "));
}

// ------------------------------------------------------------------ candidate analysis (reference implementation, in memory)
const featureResult = computePersonFeatures({ people: T.person, servingAssignments: T.serving_assignment, ministries: T.ministry, services: T.service, attendance: T.attendance_event });
const asOf = featureResult.asOf;
const groupsParsed = T.grp.map((g) => ({ ...g, is_online: bool(g.is_online), childcare: bool(g.childcare), capacity_max: Number(g.capacity_max), capacity_min: Number(g.capacity_min), life_stage_focus: g.life_stage_focus || null }));
const profilesParsed = T.member_profile.map((m) => ({ ...m, available_slots: arr(m.available_slots), interests: arr(m.interests) }));
const ctx = buildContext({
  persons: T.person, households: T.household, profiles: profilesParsed, groups: groupsParsed, tags: T.group_tag, leaders: T.group_leader,
  activeMemberships: active, features: [...featureResult.rows.values()],
});
const gname = (id) => grp[id]?.name ?? id;
const nameOf = (pid) => `${person[pid].first_name} ${person[pid].last_name}`;
function funnel(pid, profOverride) {
  const p = person[pid], pr = profOverride ?? ctx.profilesByPerson[pid];
  const home = [Number(hh[p.household_id].lat_approx), Number(hh[p.household_id].lng_approx)];
  const catalog = groupsParsed.length;
  const open = groupsParsed.filter((g) => ["open", "forming"].includes(g.status) && (activeBy[g.group_id]?.length ?? 0) < g.capacity_max);
  const genderOk = open.filter((g) => !((g.gender_focus === "men" && p.gender !== "M") || (g.gender_focus === "women" && p.gender !== "F")));
  const broad = genderOk.filter((g) => g.is_online || miles(home, [Number(g.lat_approx), Number(g.lng_approx)]) <= RADIUS_MI);
  const survivors = pr ? groupsParsed.filter((g) => passesHardFilters(ctx, p, pr, g)) : [];
  let short = [];
  if (pr) {
    const saved = ctx.profilesByPerson[pid]; ctx.profilesByPerson[pid] = pr;
    short = shortlistFor(ctx, pid); ctx.profilesByPerson[pid] = saved;
  }
  return { catalog, open: open.length, genderOk: genderOk.length, broad: broad.length, survivors, short };
}
const fmtShort = (s) => s.map((g, i) => `${i + 1}. ${g.name} (${g.total.toFixed(1)})`).join(" | ");

// persona facts
const PKEYS = ["member_dana", "member_marcus", "member_priya", "member_jordan", "member_ruth", "manager", "leader_tom", "leader_grace", "leader_chris"];
const personaRows = [];
const funnels = {};
for (const k of PKEYS.concat(["sam"])) {
  const pid = stable.personas[k];
  const role = personas.find((p) => p.key === k)?.role ?? "member (not a landing persona)";
  const hhd = hh[person[pid].household_id];
  const kids = T.person.filter((c) => c.household_id === person[pid].household_id && c.household_role === "child").length;
  const f = ctx.profilesByPerson[pid] ? funnel(pid) : null;
  funnels[k] = f;
  const weeks = asOf; const ev = T.attendance_event.filter((e) => e.person_id === pid || e.checked_in_by === pid);
  const channels = count(ev, (e) => e.channel);
  const feat = featureResult.rows.get(pid);
  personaRows.push({
    key: k, name: nameOf(pid), id: pid, role, kids, profile: !!profile[pid], memberships: active.filter((m) => m.person_id === pid).length,
    leads: (leaderGroups[pid] ?? 0), pending: T.join_request.filter((j) => j.person_id === pid && j.status === "requested").length,
    zip: hhd.zip, signals: ev.length, channels: Object.entries(channels).map(([c, n]) => `${c}:${n}`).join(" "),
    obs12: feat?.observed_weeks_12w, conf: feat?.signal_confidence, funnel: f,
  });
}
const P = Object.fromEntries(personaRows.map((r) => [r.key, r]));
const dana = funnels.member_dana, marcus = funnels.member_marcus, priya = funnels.member_priya;
check("personas", "Dana: opted in, no active membership, role member", P.member_dana.profile && P.member_dana.memberships === 0 && P.member_dana.role === "member");
check("personas", "Dana: 15-25 broadly eligible groups", dana.broad >= 15 && dana.broad <= 25, `broad=${dana.broad}`);
check("personas", "Dana: 8-15 groups pass every hard filter", dana.survivors.length >= 8 && dana.survivors.length <= 15, `survivors=${dana.survivors.length}`);
check("personas", "Dana: the shortlist holds the 6 best (architecture cap)", dana.short.length === SHORTLIST_SIZE);
// V2: no numeric gap and no guaranteed order. Success is Recall@6 (First Steps on the shortlist) plus credible, semantically distinct alternatives.
check("personas", "Dana: First Steps is on the six-group shortlist (Recall@6)", dana.short.some((g) => g.group_id === stable.groups["First Steps"]), fmtShort(dana.short));
check("personas", "Priya: zero eligible groups, on purpose (valid empty run)", priya.survivors.length === 0 && priya.short.length === 0, `survivors=${priya.survivors.length}`);
check("personas", "Marcus: Tuesday Night Dads first on the shortlist, Sunday Lunch D-Group among the shortlist",
  marcus.short[0]?.group_id === stable.groups["Tuesday Night Dads"] && marcus.short.some((g) => g.group_id === stable.groups["Sunday Lunch D-Group"]), fmtShort(marcus.short));
check("personas", "Ruth is an active member (never sent through matching); Jordan has no profile; Manager has no profile",
  P.member_ruth.memberships === 1 && !P.member_jordan.profile && !P.manager.profile);
check("personas", "Tom has exactly 2 pending requests (one 9 days old) and Sam has one pending request to Chris's group",
  T.join_request.filter((j) => j.group_id === stable.groups["Tuesday Night Dads"] && j.status === "requested").length === 2 &&
  T.join_request.some((j) => j.person_id === stable.personas.sam && j.group_id === stable.groups["New Men's D-Group (forming)"] && j.status === "requested"));
check("personas", "Chris leads the forming group with no members; Tom/Grace/Chris each lead one group",
  ["leader_tom", "leader_grace", "leader_chris"].every((k) => (leaderGroups[stable.personas[k]] ?? 0) === 1) && (activeBy[stable.groups["New Men's D-Group (forming)"]]?.length ?? 0) === 0);
check("personas", "Marcus serves in Kids Ministry at sun_11 (the hidden-conflict story)", T.serving_assignment.some((s) => s.person_id === stable.personas.member_marcus && s.schedule_slot === "sun_11"));
// legacy fixtures that tests/test_recommendations.mjs relies on after the load
const sl = (k) => new Set(funnels[k].short.map((g) => g.group_id));
check("fixtures", "a group is on Dana's shortlist but not Marcus's (invalidation tests)", [...sl("member_dana")].some((g) => !sl("member_marcus").has(g)));
check("fixtures", "a persona leader's group is on Dana's or Marcus's shortlist (leader-accept test)",
  ["leader_tom", "leader_grace", "leader_chris"].some((lk) => { const g = T.group_leader.find((l) => l.person_id === stable.personas[lk])?.group_id; return sl("member_dana").has(g) || sl("member_marcus").has(g); }));
check("fixtures", "Priya, Ruth, Jordan and the Manager are four distinct non-recommendation fixtures", new Set(["member_priya", "member_ruth", "member_jordan", "manager"].map((k) => stable.personas[k])).size === 4);

// Jordan after the intake demo (Journey 2): a hypothetical profile, nothing is stored
const jordanId = stable.personas.member_jordan;
const jordanProfile = { person_id: jordanId, life_stage: "young_kids", available_slots: ["tue_eve", "thu_eve"], group_pref: "men", interests: ["parenting", "men"] };
const jordanF = funnel(jordanId, jordanProfile);

// the toddler-mom cohort: zero eligible groups on purpose
const cohortIds = T._truth_person.filter((p) => p.archetype === "unmet_demand_cohort").map((p) => ({ person_id: p.person_id }));
const cohortSurvivors = cohortIds.map((p) => funnel(p.person_id).survivors.length);
check("personas", "toddler-mom cohort (unmet-demand story): all 6 weekday-morning moms have zero eligible groups", cohortIds.length === 6 && cohortSurvivors.every((n) => n === 0), `cohort=${cohortIds.length} survivors=${cohortSurvivors.join(",")}`);

// ------------------------------------------------------------------ evaluation suite (V2 label model, lib/seed/eval-labels.mjs)
const labels = parseLabels(T.eval_label);
const { isOriginal } = originalLabelMatcher();
const { ranking: rankingLabels, policy: policyLabels, policyByType } = partitionLabels(labels);
const labelProblems = validateLabelSchema(labels, ids.grp, ids.person);
check("labels", "label schema: controlled outcome_type, expectation rules, group and person references", labelProblems.length === 0, labelProblems.slice(0, 4).join("; "));
check("labels", "all 14 original labels are present and are ranking labels with their original expectations",
  labels.filter(isOriginal).length === 14 && labels.filter(isOriginal).every((l) => l.outcome_type === "ranking" && ["top1", "top1_or_alternates"].includes(l.expectation)),
  `${labels.filter(isOriginal).length} original labels found`);
check("labels", "policy labels are never ranking labels (they cannot reach LLM ranking evaluation)", policyLabels.every((l) => l.outcome_type !== "ranking" && !l.expectation));

const nameList = (idsList) => idsList.map(gname).join(", ");
const evalRows = [];
for (const l of labels) {
  const pid = l.person_id, f = ctx.profilesByPerson[pid] ? funnel(pid) : null;
  const surv = new Set((f?.survivors ?? []).map((g) => g.group_id)), shortIds = (f?.short ?? []).map((g) => g.group_id);
  let ok, detail = "", rank = 0, accepted = null;
  switch (l.outcome_type) {
    case "ranking": {
      rank = shortIds.indexOf(l.expected_group_id) + 1;
      accepted = l.acceptable.filter((a) => shortIds.includes(a));
      ok = surv.has(l.expected_group_id) && rank > 0 && l.excluded.every((e) => !shortIds.includes(e) && !surv.has(e)) && (l.expectation !== "top1_or_alternates" || accepted.length > 0);
      detail = `${surv.has(l.expected_group_id) ? "passes filters" : "FILTERED OUT"}; expected at shortlist rank ${rank || "none"} of ${shortIds.length}` +
        (l.acceptable.length ? `; accepted alternates present ${accepted.length}/${l.acceptable.length}` : "") + (l.excluded.length ? `; excluded absent ${l.excluded.every((e) => !shortIds.includes(e) && !surv.has(e))}` : "");
      break;
    }
    case "excluded":
      ok = shortIds.length > 0 && l.excluded.every((e) => !shortIds.includes(e) && !surv.has(e));
      detail = `excluded group(s) absent from survivors and shortlist: ${l.excluded.every((e) => !shortIds.includes(e) && !surv.has(e))}; ${surv.size} survivors remain`; break;
    case "empty": ok = (f?.survivors.length ?? 0) === 0 && shortIds.length === 0; detail = `survivors=${f?.survivors.length}`; break;
    case "active_member": ok = active.some((m) => m.person_id === pid); detail = "active member (never matched)"; break;
    case "duplicate_pending": ok = T.join_request.some((j) => j.person_id === pid && j.group_id === l.expected_group_id && j.status === "requested"); detail = "pending request exists"; break;
    default: ok = false; detail = `unknown outcome type ${l.outcome_type}`;
  }
  evalRows.push({ l, ok, detail, survivors: f?.survivors.length ?? 0, shortRank: rank, shortlist: f?.short ?? [], accepted });
  check("evaluation", `${l.label_key} (${l.scenario_family}): defensible with the generated data`, ok, detail);
}

// Shortlist Recall@6 over the ranking scenarios, computable offline because the deterministic stage is the same reference module
const rankRows = evalRows.filter((e) => e.l.outcome_type === "ranking");
const recall = {
  n: rankRows.length,
  expected: rankRows.filter((e) => e.shortRank > 0).length,
  expectedOrAccepted: rankRows.filter((e) => e.shortRank > 0 || (e.accepted?.length ?? 0) > 0).length,
  alts: rankRows.filter((e) => e.l.acceptable.length), altsPresent: rankRows.filter((e) => e.l.acceptable.length && e.accepted.length > 0).length,
  exclusionScenarios: labels.filter((l) => l.excluded.length),
};
check("evaluation", "Shortlist Recall@6 is 100% over the ranking scenarios (expected group on the six-group shortlist)", recall.expected === recall.n, `${recall.expected}/${recall.n}`);
check("evaluation", "every excluded group is absent from the hard-filter survivors and the shortlist", recall.exclusionScenarios.every((l) => evalRows.find((e) => e.l === l).ok));

// Semantic differentiation scenarios: an expected group, at least two credible alternatives on the same shortlist, and distinct text
const SENSITIVE = /\b(diagnos|depress|suicid|abus|addict|cancer|affair|bankrupt|trauma|self[- ]harm|crisis)\w*/i;
const semRows = [];
for (const e of evalRows.filter((x) => x.l.semantic_contrast)) {
  const l = e.l, shortIds = e.shortlist.map((g) => g.group_id), prof = profile[l.person_id];
  const alternatives = l.contrast.filter((c) => shortIds.includes(c));
  const descs = [l.expected_group_id, ...l.contrast].map((id) => grp[id].description);
  const distinct = new Set(descs).size === descs.length;
  const sensitive = [prof.about_me, ...descs].filter((t) => SENSITIVE.test(t)).length;
  const ok = e.shortRank > 0 && alternatives.length >= 2 && alternatives.length === l.contrast.length && distinct && prof.about_me.length >= 60 && sensitive === 0 && l.semantic_contrast.length >= 80;
  semRows.push({ l, e, alternatives, ok });
  check("semantic", `${l.label_key === "persona" ? "Dana" : l.label_key}: expected group plus ${l.contrast.length} credible alternatives on the shortlist, distinct text, no sensitive claims`, ok,
    `rank ${e.shortRank}; contrast on shortlist ${alternatives.length}/${l.contrast.length}; distinct ${distinct}; sensitive ${sensitive}`);
}
check("semantic", "8 to 12 ranking scenarios are selected for semantic differentiation, and Dana is one of them", semRows.length >= 8 && semRows.length <= 12 && semRows.some((r) => r.l.person_id === stable.personas.member_dana), `${semRows.length} selected`);
check("semantic", "Dana: she says she feels behind, and First Steps is the only shortlisted group that is intro-depth with no preparation and whose text welcomes questions", (() => {
  const truth = byId(T._truth_group, "group_id");
  const gentle = dana.short.filter((g) => truth[g.group_id].depth === "intro" && truth[g.group_id].prep === "none" && /questions are welcome/i.test(g.description));
  return /feel a little behind/.test(profile[stable.personas.member_dana].about_me) && gentle.length === 1 && gentle[0].group_id === stable.groups["First Steps"];
})(), "see report");

// ------------------------------------------------------------------ distributions
const asOfDate = new Date(asOf + "T00:00:00Z");
const ageOf = (p) => asOfDate.getUTCFullYear() - Number(p.birth_year);
const ageBand = (a) => (a <= 22 ? "18-22" : a <= 29 ? "23-29" : a <= 39 ? "30-39" : a <= 49 ? "40-49" : a <= 59 ? "50-59" : a <= 69 ? "60-69" : "70+");
const tenureMonths = (p) => Math.max(0, Math.floor((asOfDate - new Date(p.first_attended_on + "T00:00:00Z")) / (30.44 * 86400000)));
const tenureBand = (m) => (m < 1 ? "first-time (<1 mo)" : m < 3 ? "recent visitor (1-3 mo)" : m < 6 ? "recent attendee (3-6 mo)" : m < 12 ? "under 1 year" : m < 36 ? "1-3 years" : m < 120 ? "established (3-10 yr)" : "long-tenured (10+ yr)");
const capBand = (c) => (c <= 10 ? "6-10" : c <= 16 ? "11-16" : "17-30");
const occBand = (g) => { const n = activeBy[g.group_id]?.length ?? 0, c = Number(g.capacity_max); const r = n / c; return n === 0 ? "empty" : n < Number(g.capacity_min) ? "below minimum" : r >= 1 ? "full" : r >= 0.8 ? "nearly full" : r >= 0.5 ? "healthy" : "under-enrolled"; };
const truthGroup = byId(T._truth_group, "group_id");
const evTypes = count(T.attendance_event, (e) => e.channel);
const adultProfiled = adultsList.filter((a) => profile[a.person_id]);
const detailed = T.member_profile.filter((m) => m.about_me.length > 60 && m.interests !== "{}"), sparse = T.member_profile.filter((m) => m.group_pref === "" || m.interests === "{}");
const D = {
  adultAge: count(adultsList, (p) => ageBand(ageOf(p))), hhType: count(T._truth_household, (h) => h.archetype), tenure: count(adultsList, (p) => tenureBand(tenureMonths(p))),
  family: count(T._truth_group, (g) => g.family), status: count(T.grp, (g) => g.status), format: count(T._truth_group, (g) => g.format), campus: count(T._truth_group, (g) => g.campus),
  slot: count(T.grp, (g) => g.meeting_slot), capacity: count(T.grp, (g) => capBand(Number(g.capacity_max))), occupancy: count(T.grp, occBand), freq: count(T.grp, (g) => g.frequency),
  zip: count(T.household, (h) => h.zip), hhCampus: count(T._truth_household, (h) => h.campus), pattern: count(T._truth_household, (h) => h.pattern), mode: count(T._truth_household, (h) => h.online_mode),
  memb: count(adultsList, (a) => String(active.filter((m) => m.person_id === a.person_id).length)), perLeader: count(Object.values(leaderGroups), (n) => String(n)),
  evalPurpose: count(T.eval_label, (l) => l.outcome_type), evalFamily: count(T.eval_label, (l) => l.scenario_family),
};
// membership count per person without the O(n^2) filter above
{ const per = count(active, (m) => m.person_id); D.memb = count(adultsList, (a) => String(per[a.person_id] ?? 0)); }
const elig = adultProfiled.filter((a) => !active.some((m) => m.person_id === a.person_id));
const eligCounts = {};
for (const a of elig) { const n = funnel(a.person_id).survivors.length; const k = n === 0 ? "0" : n <= 2 ? "1-2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : "11+"; eligCounts[k] = (eligCounts[k] ?? 0) + 1; }
const histWeeks = new Set(T.service.filter((s) => s.slot !== "wed_eve").map((s) => s.service_date)).size;
const firstSvc = T.service.map((s) => s.service_date).sort()[0];
const sundayServices = T.service.filter((s) => s.service_date === asOf).length;
const attendedPeople = new Set(T.attendance_event.map((e) => (e.channel === "kiosk" ? e.checked_in_by : e.person_id))).size;
const meetingEvents = T.meeting_attendance.length;
const left = T.group_membership.filter((m) => m.status === "left").length;

// ------------------------------------------------------------------ targets
const judge = (v, lo, hi, tol = 0.12) => (v >= lo && v <= hi ? "pass" : v >= lo * (1 - tol) && v <= hi * (1 + tol) ? "variance" : "fail");
const targets = [
  ["Adults (approx. 4,500)", adultsList.length, "4,500", judge(adultsList.length, 4300, 4700)],
  ["Children (1,500 to 2,500)", childrenList.length, "1,500-2,500", judge(childrenList.length, 1500, 2500)],
  ["Households (2,500 to 3,200)", T.household.length, "2,500-3,200", judge(T.household.length, 2500, 3200)],
  ["Groups (approx. 140)", T.grp.length, "140", judge(T.grp.length, 135, 145)],
  ["Active group memberships (900 to 1,400)", active.length, "900-1,400", judge(active.length, 900, 1400)],
  ["Recommendation-ready profiles (1,200 to 2,000)", T.member_profile.length, "1,200-2,000", judge(T.member_profile.length, 1200, 2000)],
  ["Profile adoption (30 to 45 percent of adults)", `${(100 * T.member_profile.length / adultsList.length).toFixed(1)}%`, "30-45%", judge(100 * T.member_profile.length / adultsList.length, 30, 45)],
  ["Weekly worship services (6 to 10)", sundayServices + 1, "6-10", judge(sundayServices + 1, 6, 10, 0)],
  ["Engagement history (52 weeks)", histWeeks, "52", histWeeks === 52 ? "pass" : "fail"],
  ["Evaluation scenarios (approx. 28)", T.eval_label.length, "28", judge(T.eval_label.length, 26, 30)],
  ["Dana: broadly eligible groups (15 to 25)", dana.broad, "15-25", judge(dana.broad, 15, 25, 0)],
  ["Dana: groups passing every hard filter (8 to 15)", dana.survivors.length, "8-15", judge(dana.survivors.length, 8, 15, 0)],
  ["Dana: presented recommendations", "3 (shortlist of up to 6, architecture)", "3", "pass"],
  ["RNG seed 516", "516", "516", /^SEED = 516$/m.test(genSrc) ? "pass" : "fail"],
];
const failedChecks = results.filter((r) => !r.ok);

// ------------------------------------------------------------------ console
const byArea = {};
for (const r of results) (byArea[r.area] ??= []).push(r);
for (const [area, rs] of Object.entries(byArea)) {
  console.log(`\n${area}: ${rs.filter((r) => r.ok).length}/${rs.length} passed`);
  for (const r of rs.filter((x) => !x.ok)) console.log(`  FAIL  ${r.name}${r.detail ? "  [" + r.detail + "]" : ""}`);
}
console.log("\nTargets:");
for (const [n, v, , s] of targets) console.log(`  ${s.toUpperCase().padEnd(8)} ${n}: ${v}`);
console.log(`\nDana: catalog ${dana.catalog} -> open+seat ${dana.open} -> gender ${dana.genderOk} -> broad (<=5 mi or online) ${dana.broad} -> hard survivors ${dana.survivors.length} -> shortlist ${dana.short.length}`);
console.log("  " + fmtShort(dana.short));
console.log("Marcus: " + fmtShort(marcus.short));
console.log("Jordan after intake: " + fmtShort(jordanF.short));
console.log(`\n${failedChecks.length === 0 ? "ALL CHECKS PASSED" : failedChecks.length + " CHECK(S) FAILED"} (${results.length} checks, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ------------------------------------------------------------------ report
if (WRITE_REPORT) {
  const tbl = (head, rows) => `| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.join(" | ")} |`).join("\n")}\n`;
  const dist = (o, label = "Value") => tbl([label, "Count", "Share"], sortedEntries(o).map(([k, v]) => [k, v, pct(v, Object.values(o).reduce((a, b) => a + b, 0))]));
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".csv")).sort();
  const inv = files.map((f) => [`\`${f}\``, T[f.replace(".csv", "")]?.length ?? "", (fs.statSync(path.join(DIR, f)).size / 1024).toFixed(0) + " KB"]);
  const totalMb = (files.reduce((a, f) => a + fs.statSync(path.join(DIR, f)).size, 0) / 1048576).toFixed(1);
  const dur = ((Date.now() - t0) / 1000).toFixed(1);
  const tgt = tbl(["Target", "Actual", "Range", "Result"], targets.map(([n, v, r, s]) => [n, v, r, s === "pass" ? "passed" : s === "variance" ? "**passed with variance**" : "**FAILED**"]));
  const personaTbl = tbl(["Persona", "Role", "Stable id", "Household", "Profile", "Active groups", "Pending", "Signals (12 wk obs / confidence)"],
    personaRows.map((r) => [r.name, r.role, `\`${r.id.slice(0, 8)}…\``, `${r.zip}${r.kids ? `, ${r.kids} kids` : ""}`, r.profile ? "yes" : "no", r.memberships + (r.leads ? ` (leads ${r.leads})` : ""), r.pending, `${r.signals} events: ${r.channels || "none"}; ${r.obs12 ?? "-"} wks, ${r.conf ?? "-"}`]));
  const funnelTbl = tbl(["Persona", "Catalog", "Open with a seat", "Gender fit", "Broadly eligible (≤5 mi or online)", "Pass every hard filter", "Shortlist (≤6)"],
    ["member_dana", "member_marcus", "member_priya"].map((k) => { const f = funnels[k]; return [P[k].name, f.catalog, f.open, f.genderOk, f.broad, f.survivors.length, f.short.length]; })
      .concat([["Jordan (after intake: young_kids, tue/thu eve, men)", jordanF.catalog, jordanF.open, jordanF.genderOk, jordanF.broad, jordanF.survivors.length, jordanF.short.length]]));
  const gap = (s) => (s.length > 1 ? `${(s[0].total - s[1].total).toFixed(1)} points between #1 and #2` + (s.length > 2 ? `, ${(s[0].total - s[2].total).toFixed(1)} between #1 and #3` : "") : "n/a");
  const evalTbl = tbl(["Label", "Scenario family", "Outcome type", "Defensible", "Detail"], evalRows.map((e) => [e.l.label_key, e.l.scenario_family, e.l.outcome_type, e.ok ? "yes" : "**NO**", e.detail]));
  let gitRev = "unknown";
  try {
    gitRev = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim()) gitRev += " (working tree has uncommitted changes)";
  } catch { /* no git available */ }
  const genSecs = determinism.ran ? `${determinism.genSeconds.map((x) => x.toFixed(1)).join(" s and ")} s (two runs, measured by the determinism check)` : "not measured in this pass (run `npm run seed:check`)";
  const bd = (b) => ["life_stage", "kids_age", "serving_area", "consistency", "interests", "distance"].map((k) => Number(b[k]).toFixed(1));
  const toItems = (sl) => sl.map((g) => ({
    group_id: g.group_id, name: g.name, description: g.description, tags: ctx.tagsByGroup[g.group_id] ?? [], meeting_slot: g.meeting_slot,
    gender_focus: g.gender_focus, life_stage_focus: g.life_stage_focus, childcare: g.childcare, is_online: g.is_online, status: g.status,
    open_seats: Math.max(0, g.capacity_max - (ctx.activeMembersByGroup[g.group_id] ?? []).length), group_mix: groupMix(ctx, g.group_id), score: g.total,
  }));
  const danaId = stable.personas.member_dana;
  const danaRow = semRows.find((r) => r.l.person_id === danaId);
  const danaPayload = { member: memberPayload(ctx.profilesByPerson[danaId]), shortlist: shortlistPayload(toItems(dana.short), { includeScore: true }) };
  const danaTbl = tbl(["#", "Group", "Score", "Life stage", "Kids age", "Serving", "Consistency (neutral)", "Interests", "Distance", "Status", "Slot", "Format"],
    dana.short.map((g, i) => [i + 1, g.name, g.total.toFixed(1), ...bd(g.breakdown), g.status, g.meeting_slot, g.is_online ? "online" : (byId(T._truth_group, "group_id")[g.group_id].format)]));
  const danaDescs = dana.short.map((g, i) => `${i + 1}. **${g.name}** (${g.status}, ${g.meeting_slot}, ${(byId(T._truth_group, "group_id")[g.group_id].depth)} depth, ${(byId(T._truth_group, "group_id")[g.group_id].prep)} preparation): ${g.description}`).join("\n");
  const nameShort = (e) => e.shortlist.map((g, i) => `${i + 1}. ${g.name} (${g.total.toFixed(1)})${g.group_id === e.l.expected_group_id ? " **← expected**" : e.l.acceptable.includes(g.group_id) ? " ← accepted alternate" : e.l.contrast.includes(g.group_id) ? " ← contrast" : ""}`).join("<br>");
  const semTbl = tbl(["Scenario", "Family", "Expected group", "Expected rank on shortlist", "Contrast groups on shortlist", "Result"],
    semRows.map((r) => [r.l.label_key === "persona" ? "persona (Dana)" : r.l.label_key, r.l.scenario_family, r.l.expected_group_name, `${r.e.shortRank} of ${r.e.shortlist.length}`, `${r.alternatives.length}/${r.l.contrast.length}: ${nameList(r.l.contrast)}`, r.ok ? "pass" : "**FAIL**"]));
  const semDetail = semRows.filter((r) => r.l.person_id !== danaId).map((r) => `#### ${r.l.label_key} — ${r.l.scenario_family}\n- **Member says:** "${r.l.cue}"\n- **Expected:** ${r.l.expected_group_name} (${r.l.expectation}${r.l.acceptable.length ? `; accepted: ${nameList(r.l.acceptable)}` : ""})\n- **Why an informed reviewer prefers it:** ${r.l.semantic_contrast}\n- **Deterministic shortlist:** ${r.e.shortlist.map((g, i) => `${i + 1}. ${g.name} (${g.total.toFixed(1)})`).join("; ")}\n`).join("\n");
  const policyTbl = tbl(["Scenario", "Outcome type", "Result", "Observed"], evalRows.filter((e) => e.l.outcome_type !== "ranking").map((e) => [e.l.label_key, e.l.outcome_type, e.ok ? "pass" : "**FAIL**", e.detail]));
  const byFamily = count(labels, (l) => l.scenario_family);
  const typeFamilyTbl = tbl(["Outcome type", "Scenarios", "Executed as"], OUTCOME_TYPES.map((t) => [t, labels.filter((l) => l.outcome_type === t).length,
    { ranking: "deterministic shortlist and LLM ranking", empty: "deterministic only (no survivors expected)", excluded: "deterministic only (excluded groups absent)", duplicate_pending: "policy only (request blocked)", active_member: "policy only (never matched)" }[t]]));
  const rankTbl = tbl(["Scenario", "Expectation", "Expected group", "Rank on shortlist", "Accepted alternates present", "Excluded groups absent", "Survivors"],
    rankRows.map((e) => [e.l.label_key === "persona" ? `persona (${nameOf(e.l.person_id).split(" ")[0]})` : e.l.label_key, e.l.expectation, e.l.expected_group_name, e.shortRank || "**none**",
      e.l.acceptable.length ? `${e.accepted.length}/${e.l.acceptable.length}` : "n/a", e.l.excluded.length ? (e.ok ? "yes" : "**NO**") : "n/a", e.survivors]));
  const nOrig = labels.filter(isOriginal).length;

  const md = `# Synthetic data report (V2)

> **Generated file. Do not edit.** Produced by \`node scripts/seed_validate.mjs\` from \`seed/out/\`; \`seed/generate_seed.py\` remains the source of truth. Regenerate with \`npm run seed:check\`.

## 1. Generator and run metadata
- **Report version:** V2 (semantic differentiation, controlled label model, offline Shortlist Recall@6).
- Generator: \`seed/generate_seed.py\` **${genVersion}**, RNG seed **516**. Repository revision: \`${gitRev}\`.
- Report generated: ${new Date().toISOString()} (report metadata, not seed content).
- Generation duration: ${genSecs}. Validation duration: ${dur} s${determinism.ran ? " (includes the two full regenerations)" : ""}.
- **Lakebase and OpenRouter were not touched.** This validator reads CSV files only. It runs the generator and \`git\` as local processes; it opens no database connection, makes no network call and invokes no model. The development database is unchanged.
- **Observed versus expected:** everything below is an observed offline fact about the generated CSVs unless a sentence says it is a later expectation. Nothing here is a model result (see section 19).
- Features and shortlists below use the reference implementations in \`lib/features/person-features.mjs\` and \`lib/ranking/reference-shortlist.mjs\` on the CSVs in memory (as-of ${asOf}). No database, no network, no model calls.

## 2. Result at a glance
- Checks: **${results.length - failedChecks.length} of ${results.length} passed**${failedChecks.length ? `; failing: ${failedChecks.map((f) => f.name).join("; ")}` : ""}.
- Determinism: ${determinism.ran ? (determinism.runsEqual && determinism.matchesChecked ? `**passed.** Two consecutive generations are byte-identical across ${determinism.files} files and match \`seed/out\`.` : `**FAILED** (${[...determinism.diffAB, ...determinism.diffCur].join(", ")})`) : "not run in this pass (use \`npm run seed:check\`)."}

${tgt}

## 3. File inventory
${tbl(["File", "Rows", "Size"], inv)}
Total: ${totalMb} MB. \`personas.json\` is the persona picker input. \`_truth_*.csv\` are validation controls and are never loaded.

## 4. Population
${tbl(["Measure", "Value"], [["Adults", adultsList.length], ["Children", childrenList.length], ["Households", T.household.length], ["People", T.person.length], ["Adults with a profile", `${adultProfiled.length} (${pct(adultProfiled.length, adultsList.length)})`], ["Detailed profiles (free text and interests)", detailed.length], ["Sparse profiles (missing preference or interests)", sparse.length], ["Adults with engagement signals in the history", attendedPeople]])}
**Adult age bands**

${dist(D.adultAge, "Age band")}
**Household types**

${dist(D.hhType, "Archetype")}
**Church tenure**

${dist(D.tenure, "Tenure band")}
**Households by ZIP** (synthetic centroid + jitter)

${dist(D.zip, "ZIP")}
**Households by home campus**

${dist(D.hhCampus, "Campus")}

## 5. Group catalog
${tbl(["Measure", "Value"], [["Groups", T.grp.length], ["Leaders (distinct)", Object.keys(leaderGroups).length], ["Group tags", T.group_tag.length]])}
**By family**

${dist(D.family, "Family")}
**By status**

${dist(D.status, "Status")}
**By format** (the schema has \`is_online\` only; hybrid groups are in-person with a video link and are subject to the distance rule)

${dist(D.format, "Format")}
**By campus / ministry location** (derived from the leader's household; the schema has no campus column)

${dist(D.campus, "Campus")}
**By meeting slot**

${dist(D.slot, "Slot")}
**By capacity band**

${dist(D.capacity, "Capacity")}
**By meeting frequency**

${dist(D.freq, "Frequency")}

## 6. Membership and occupancy
${tbl(["Measure", "Value"], [["Active memberships", active.length], ["Historical memberships (left)", left], ["Join requests (all statuses)", T.join_request.length], ["Pending requests", T.join_request.filter((j) => j.status === "requested").length]])}
**Occupancy**

${dist(D.occupancy, "Occupancy")}
**Active group memberships per adult**

${dist(D.memb, "Memberships")}
**Groups per leader**

${dist(D.perLeader, "Groups led")}
**Eligible-group reach of opted-in members who are not in a group** (groups passing every hard filter)

${dist(eligCounts, "Eligible groups")}

## 7. Engagement history (${histWeeks} weeks from ${firstSvc} to ${asOf})
${tbl(["Measure", "Value"], [["Weekly services", `${sundayServices + 1} (Sunday ×${sundayServices}, Wednesday night ×1, across 4 campuses plus online)`], ["Service rows", T.service.length], ["Attendance signal events", T.attendance_event.length], ["Group meetings", T.group_meeting.length], ["Group meeting attendance rows", meetingEvents], ["Serving assignments", T.serving_assignment.length]])}
**Signals by channel**

${dist(evTypes, "Channel")}
**Attendance patterns** (household level)

${dist(D.pattern, "Pattern")}
**Online participation**

${dist(D.mode, "Mode")}

## 8. Evaluation suite (${T.eval_label.length} scenarios, V2 label model)
The label file adds \`expectation\`, \`semantic_contrast\` and \`contrast_group_ids\` to the V1 columns (\`purpose\`, \`outcome_type\`, \`excluded_group_ids\`, \`scenario_family\`). \`outcome_type\` is a controlled vocabulary with exactly one execution behavior each (\`lib/seed/eval-labels.mjs\`); \`expectation\` (\`top1\`, \`top1_or_alternates\`, \`top3\`) says how strictly a ranking scenario is judged.

${typeFamilyTbl}
**By scenario family**

${dist(byFamily, "Scenario family")}
**Original-label preservation:** ${nOrig} of 14 original labels are present with their original member, expected group and accepted alternates (checked against \`seed/stable_ids.json\`). They are all \`ranking\` labels with \`top1\` or \`top1_or_alternates\`. V2 corrected five added (non-original) labels whose \`top1_or_alternates\` declaration named no reachable alternate (e13, e18, e19, e22, e23); they are now \`top1\`.

${evalTbl}
## 9. Shortlist Recall@6 (offline, observed)
The deterministic stage is the same reference module the app is tested against (\`lib/ranking/reference-shortlist.mjs\`) running on the generated CSVs in memory; no database behavior is approximated. Features come from \`lib/features/person-features.mjs\`. Limitation: the production shortlist is \`app.recommendation_shortlist()\` over \`person_features\` computed in the database; parity with the reference is verified by \`npm run test:recommendations\` **after** the load, not here.

- **Shortlist Recall@6 (expected group on the six-group shortlist): ${recall.expected} of ${recall.n} ranking scenarios${recall.expected === recall.n ? " (100%)" : ""}.**
- Expected or accepted group present: ${recall.expectedOrAccepted} of ${recall.n}.
- Accepted alternates present on the shortlist: ${recall.altsPresent} of ${recall.alts.length} scenarios that declare alternates.
- Excluded groups absent from survivors and shortlist: ${recall.exclusionScenarios.filter((l) => evalRows.find((e) => e.l === l).ok).length} of ${recall.exclusionScenarios.length} scenarios that declare exclusions.

${rankTbl}
## 10. Policy and exclusion scenarios (never sent to LLM ranking)
${policyTbl}
These are checked deterministically and by policy tests only; \`scripts/rank_eval.mjs\` skips them and reports the count.

## 11. Semantic-differentiation scenarios (${semRows.length} selected)
Intent: after hard eligibility and structured scoring, an informed human can explain why one shortlisted group is better than another from the member's confirmed words and the group descriptions. There is **no** required score gap; close scores are acceptable. Each scenario below has its expected group on the shortlist, at least two credible alternatives on the same shortlist, distinct descriptions, and no sensitive claims for a model to infer.

${semTbl}
## 12. Named personas
${personaTbl}
Stable-id check: every persona, portal user, named group, original evaluation label and original join-request id matches \`seed/stable_ids.json\` (${results.filter((r) => r.area === "identity" && r.ok).length}/${results.filter((r) => r.area === "identity").length} identity checks passed).

## 13. Candidate funnel (reference implementation, offline)
${funnelTbl}
## 14. Dana: funnel and semantic contrast
**Observed funnel:** catalog ${dana.catalog} → open with a seat ${dana.open} → gender fit ${dana.genderOk} → **broadly eligible ${dana.broad}** → **pass every hard filter ${dana.survivors.length}** → shortlist ${dana.short.length} → three presented later (by the model, not run). The architecture caps the shortlist at ${SHORTLIST_SIZE}; the design's "8 to 15" is read as the hard-filter survivors.

**Deterministic shortlist** (${gap(dana.short)}; close scores are acceptable and nothing was tuned to widen them):

${danaTbl}
**Member narrative supplied to ranking** (\`memberPayload\`, prompt \`${PROMPT_VERSION}\`: life stage, preference, interests, own words; no name, attendance or address):

\`\`\`json
${JSON.stringify(danaPayload.member, null, 2)}
\`\`\`

**Candidate descriptions supplied to ranking** (shortlist order; the depth and preparation labels come from the generator's validation-only metadata and are **not** sent to the model, only the description text is):

${danaDescs}

**Intended semantic distinction (human-readable, not a model output):** ${danaRow.l.semantic_contrast}

**Why this is not a scripted outcome:** there is no Dana-specific branch, score or exclusion. Her profile is the same row any member would have; her preference is \`mixed\`, so women-only groups remain eligible. Every alternative above passes the same hard filters. The generator's only V2 change for her is the text: her own words now say she feels a little behind, and group descriptions state who each group assumes it is talking to. Whether a model orders them as a human would is **not known** until the live evaluation.

Marcus: ${fmtShort(marcus.short)}

Jordan after the Journey 2 intake text (hypothetical, nothing stored): ${fmtShort(jordanF.short)}

### Other semantic scenarios
${semDetail}
## 15. Referential integrity, rules and loader compatibility
${tbl(["Area", "Passed", "Total"], Object.entries(byArea).map(([a, rs]) => [a, rs.filter((r) => r.ok).length, rs.length]))}
${failedChecks.length ? "**Failures**\n\n" + failedChecks.map((f) => `- ${f.area}: ${f.name} (${f.detail})`).join("\n") + "\n" : "All integrity, schema and rule checks passed.\n"}
## 16. Target-range exceptions
${targets.filter((t) => t[3] !== "pass").map((t) => `- ${t[0]}: ${t[1]} (${t[3]})`).join("\n") || "None. Every approved target passed."}

## 17. Warnings, design compromises and schema limitations
- **Campuses:** the schema has no campus column. Campuses shape services (4 ministry locations plus an online gathering), which service a household attends, and where leaders live. A group's campus is derived from its leader's household and is recorded only in \`_truth_group.csv\`, which is never loaded.
- **Shortlist size:** the architecture caps the shortlist at ${SHORTLIST_SIZE}, the design asks for 8 to 15. The generator provides 8 to 15 hard-filter survivors for Dana; the shortlist is unchanged.
- **Paused groups** are not representable (status allows forming, open, full, closed, multiplying); closed groups stand in.
- **Hybrid groups** are in-person with a video link; \`is_online\` is false so the 5-mile rule applies.
- **Weekday-morning groups** exist only at the Clermont location, so the toddler-mom cohort (Priya and five others) is unserved by design (escalation story, Journey 4).
- **Join-request deciders:** accepted/declined history has no \`decided_by\` because only the 9 personas are portal users.
- **Roles that differ from the design text:** the Design doc (9.2, 9.4) describes Marcus as a leader and Jordan as an existing-membership case. Demo Journeys and \`personas.json\` define Marcus as a member and Jordan as a new attender with no profile, and the design (9.7) requires preserving portal roles, so the canonical roles were kept.
- **Dana's group preference:** \`mixed\` (changed from "women" in the first refactor). The women-only value contradicted the canonical expected pick; Demo Journeys never has her ask for a women's group. V2 keeps \`mixed\`.
- **Men's Accountability** keeps no declared life stage (its canonical description names none); its balanced roster is what scores it. V2 did not alter that.
- **Journey 3 leader personas remain unresolved.** Only Tom, Grace and Chris are persona leaders. The leaders of First Steps and Sunday Lunch D-Group, for example, are not portal personas, so a join request to those groups cannot be viewed from a leader persona. This is a separate decision for the project owner; V2 did not add leader personas.
- **Validation-only metadata is not an application feature:** campus, group format, depth and preparation live in \`_truth_group.csv\` (never loaded) and are used only to validate the data and to annotate this report.
- **Generated files in git:** ${totalMb} MB of CSV.

## 18. Known limitations that need the later Lakebase load
- Parity between the reference shortlist and the database function \`app.recommendation_shortlist()\` over the database-computed \`person_features\` is **not yet verified** for the expanded data; it is checked by \`npm run test:recommendations\` after the load.
- The development database still holds the previous seed. Running the database-dependent tests before the load would compare old state with new expectations.
- \`docs/Gathered - Data Model & Architecture.md\` §9 still states the v0.2 sizes; update it only after the expanded data is approved and loaded.

## 19. Not yet known (requires a model run)
- LLM Top-1, Top-3, stability and fallback rate on the ${recall.n} ranking scenarios. \`scripts/rank_eval.mjs\` is prepared to report them separately; it was **not run**, and no model was called.
- Whether the model orders Dana's shortlist as a human reviewer would (First Steps first). The data now gives a reviewer the evidence; whether the model uses it is a live-evaluation result.

## 20. Readiness for the load-and-evaluate increment
${failedChecks.length === 0 ? "**Ready for review.** All offline checks pass." : "**Not ready:** failing checks above."} Remaining steps, none of which were started:
1. Review this report and approve the expanded dataset.
2. Load with \`npm run seed:reset\` (recomputes \`person_features\`), then run \`npm test\` (the scripts are already prepared for the 29-label set).
3. Run \`scripts/rank_eval.mjs\` explicitly (real OpenRouter calls) and record Top-1, Top-3, stability and fallbacks.
4. Update Architecture §9 sizes after a successful load.
`;
  fs.writeFileSync(path.join(ROOT, "seed", "SYNTHETIC_DATA_REPORT.md"), md);
  console.log("report written: seed/SYNTHETIC_DATA_REPORT.md");
}
process.exit(failedChecks.length ? 1 : 0);
