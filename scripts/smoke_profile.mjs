// Gathered: preferences page HTTP smoke test against a RUNNING app (no LLM calls, no browser).
//
//   1. npm run build && npx next start -p 3114
//   2. BASE_URL=http://localhost:3114 node --env-file=.env.local scripts/smoke_profile.mjs
//   (or: npm run smoke:profile)
//
// Drives the real pages and the real server action with plain HTTP and a persona cookie: the
// member-home summary, the prefilled form, cancel, an unchanged confirmation, a material change,
// rejected crafted input, and the no-profile route. This is NOT a click-through in a browser.
// Dana's profile is restored afterwards; runs and audit rows created here are removed.
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const BASE = process.env.BASE_URL ?? "http://localhost:3114";
const ssl = { rejectUnauthorized: false };
const personas = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "seed", "out", "personas.json"), "utf8"));
const P = Object.fromEntries(personas.map((p) => [p.key, p]));
const own = new pg.Client({ connectionString: process.env.DATABASE_OWNER_URL, ssl });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3 });
await own.connect();
const startAuditId = Number((await own.query("select coalesce(max(id), 0) m from app.audit_log")).rows[0].m);

let failed = 0;
const check = (name, ok, extra = "") => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  " + extra}`); if (!ok) failed++; };
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (h) => unesc(h.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const get = async (key, url) => { const r = await fetch(BASE + url, { headers: { cookie: key ? `personaKey=${key}` : "" }, redirect: "manual" }); return { status: r.status, html: await r.text(), loc: r.headers.get("location") }; };
const HIDDEN = /rationale|score_breakdown|shortlist|prompt_version|rank-v|stub-model|confidence|internal_rationale|busy_slots|attendance|"score"/i;
const DANA = "member_dana";
const profile = async (key) => (await own.query("select * from app.member_profile where person_id = $1", [P[key].person_id])).rows[0];
const runs = async (key) => (await own.query("select run_id, is_current, invalidation_reason from app.recommendation_run where person_id = $1 order by generated_at", [P[key].person_id])).rows;
const auditCount = async (where = "true") => Number((await own.query(`select count(*) c from app.audit_log where id > $1 and ${where}`, [startAuditId])).rows[0].c);

async function persist(personKey) {
  const c = await app.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.role', $1, true), set_config('app.person_id', $2, true)", [P[personKey].role, P[personKey].person_id]);
    const ids = (await c.query("select group_id from app.recommendation_shortlist() order by shortlist_position")).rows.map((r) => r.group_id);
    await c.query("select app.persist_recommendation_run($1::uuid[], $2::uuid[], 'llm', 'medium', 'smoke', 'stub-model', 'rank-v2', '{}'::jsonb)", [ids, ids.slice(0, 3)]);
    await c.query("commit");
  } finally { c.release(); }
}
async function cleanup() {
  for (const t of ["recommendation", "recommendation_run_candidate", "recommendation_run"]) await own.query(`delete from app.${t}`);
  await own.query("delete from app.audit_log where id > $1", [startAuditId]);
}
const snap = await profile(DANA);
async function restore() {
  await own.query("update app.member_profile set life_stage=$2, available_slots=$3, group_pref=$4, interests=$5, about_me=$6 where person_id=$1",
    [snap.person_id, snap.life_stage, snap.available_slots, snap.group_pref, snap.interests, snap.about_me]);
}

/** The form exactly as a browser would submit it: every hidden input the page rendered, then the fields. */
function hiddenFields(html) {
  const out = [];
  for (const tag of html.match(/<input[^>]*type="hidden"[^>]*>/g) ?? []) {
    const name = tag.match(/name="([^"]*)"/)?.[1]; const value = tag.match(/value="([^"]*)"/)?.[1] ?? "";
    if (name) out.push([name, unesc(value)]);
  }
  return out;
}
/** What the form currently shows as chosen. */
function formState(html) {
  const checked = (name) => [...html.matchAll(new RegExp(`<input[^>]*name="${name}"[^>]*>`, "g"))].map((m) => m[0]).filter((t) => /checked/.test(t)).map((t) => t.match(/value="([^"]*)"/)[1]);
  const select = (name) => {
    const sel = html.match(new RegExp(`<select[^>]*name="${name}"[\\s\\S]*?</select>`))?.[0] ?? "";
    return (sel.match(/<option[^>]*selected[^>]*>/)?.[0].match(/value="([^"]*)"/) ?? [])[1] ?? "";
  };
  const about = unesc(html.match(/<textarea[^>]*name="about_me"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? "");
  return { life_stage: select("life_stage"), slots: checked("available_slots"), group_pref: select("group_pref"), interests: checked("interests"), about };
}
async function submit(key, html, fields) {
  const f = new FormData();
  for (const [k, v] of hiddenFields(html)) f.append(k, v);
  for (const [k, v] of fields) f.append(k, v);
  return fetch(`${BASE}/member/intake`, { method: "POST", body: f, redirect: "manual", headers: { cookie: `personaKey=${key}` } });
}
const same = (row) => [["life_stage", row.life_stage ?? ""], ...row.available_slots.map((s) => ["available_slots", s]), ["group_pref", row.group_pref ?? ""], ...row.interests.map((i) => ["interests", i]), ["about_me", row.about_me ?? ""]];

await cleanup();
try {
  console.log("Member home summary");
  await persist(DANA);
  let r = await get(DANA, "/member");
  let t = text(r.html);
  check("Dana's summary shows her stored values from the database", r.status === 200 && t.includes("Your preferences") && t.includes("Single") && t.includes("Wednesdays · evenings") && t.includes("Thursdays · evenings") && t.includes("Mixed") && t.includes("Bible reading") && t.includes("New to faith") && t.includes("Prayer"), t.slice(0, 400));
  check("it shows her own words, labelled as what she told Gathered", t.includes("What you told Gathered") && t.includes("Moved here for work in September"));
  check("it offers Edit preferences, linking to /member/intake", /href="\/member\/intake"[^>]*>Edit preferences</.test(r.html));
  check("the saved run is still offered as View my best matches", t.includes("View my best matches"));
  check("no ranking, feature or attendance data in the page", !HIDDEN.test(r.html), (r.html.match(HIDDEN) ?? [])[0]);
  r = await get("member_priya", "/member");
  check("another member's summary shows different, her own, values (not hard-coded)", !text(r.html).includes("Moved here for work") && text(r.html).includes("Your preferences"));

  console.log("\nEdit page");
  r = await get(DANA, "/member/intake");
  t = text(r.html);
  const fs0 = formState(r.html);
  check("heading is Your preferences, with Save preferences and Cancel", r.status === 200 && t.includes("Your preferences") && t.includes("Save preferences") && /href="\/member"[^>]*>Cancel</.test(r.html), t.slice(0, 300));
  check("every control is prefilled from the stored profile",
    fs0.life_stage === snap.life_stage && JSON.stringify([...fs0.slots].sort()) === JSON.stringify([...snap.available_slots].sort())
    && fs0.group_pref === snap.group_pref && JSON.stringify([...fs0.interests].sort()) === JSON.stringify([...snap.interests].sort()) && fs0.about === snap.about_me, JSON.stringify(fs0));
  check("no person id, score or run data in the form", !HIDDEN.test(r.html) && !r.html.includes(P[DANA].person_id), "");

  console.log("\nCancel and unchanged confirmation");
  r = await get(DANA, "/member");
  check("opening the form and cancelling changes nothing (run still current, no audit rows)", (await runs(DANA)).every((x) => x.is_current) && (await auditCount("action = 'member_profile_updated'")) === 0 && text(r.html).includes("View my best matches"));
  r = await get(DANA, "/member/intake");
  let post = await submit(DANA, r.html, same(snap));
  check("saving the unchanged form redirects to the member page", post.status === 303 && (post.headers.get("location") ?? "").includes("/member?notice=preferences_unchanged"), `${post.status} ${post.headers.get("location")}`);
  const xs = await runs(DANA);
  check("the saved run is untouched, no audit row, profile identical", xs.length === 1 && xs[0].is_current && (await auditCount("action = 'member_profile_updated'")) === 0 && JSON.stringify(await profile(DANA)) === JSON.stringify(snap));
  r = await get(DANA, "/member?notice=preferences_unchanged");
  check("the member home still offers View my best matches and says nothing changed", text(r.html).includes("View my best matches") && text(r.html).includes("Nothing changed"));

  console.log("\nMaterial change");
  r = await get(DANA, "/member/intake");
  const changed = same(snap).filter(([k, v]) => !(k === "interests" && v === "prayer")).concat([["interests", "outdoors"]]);
  post = await submit(DANA, r.html, changed);
  check("saving a change redirects to Browse Groups with Preferences updated", post.status === 303 && (post.headers.get("location") ?? "").includes("/member?notice=preferences_updated"), `${post.status} ${post.headers.get("location")}`);
  const after = await profile(DANA);
  check("the new values are stored; consent and source are not touched", after.interests.includes("outdoors") && !after.interests.includes("prayer") && after.consent_version === snap.consent_version && after.profile_source === snap.profile_source && String(after.confirmed_at) === String(snap.confirmed_at));
  const xr = await runs(DANA);
  check("the saved run is out of date, reason profile_changed, and still stored", xr.length === 1 && !xr[0].is_current && xr[0].invalidation_reason === "profile_changed", JSON.stringify(xr));
  r = await get(DANA, "/member?notice=preferences_updated");
  t = text(r.html);
  check("Browse Groups shows Preferences updated and offers Find my best matches (not View my best matches)", t.includes("Preferences updated.") && t.includes("Find my best matches") && !t.includes("View my best matches") && t.includes("Find your group"), t.slice(0, 300));
  check("no recommendation was generated by the save (still no current run, no model audit rows)", (await runs(DANA)).every((x) => !x.is_current) && (await auditCount("action like 'llm%' or action like 'recommendation%'")) === 0);
  check("one audit row, naming fields only", (await auditCount("action = 'member_profile_updated'")) === 1);
  r = await get(DANA, "/member");
  check("the summary's Interests row now shows the changed interests", /Interests Bible reading, New to faith, Outdoors /.test(text(r.html)), (text(r.html).match(/Interests [^]{0,80}/) ?? [])[0]);

  console.log("\nRejected input");
  r = await get(DANA, "/member/intake");
  const before = JSON.stringify(await profile(DANA));
  post = await submit(DANA, r.html, [["life_stage", "single"], ["available_slots", "fri_midnight"], ["group_pref", "mixed"], ["interests", "zz_test"], ["about_me", "x"]]);
  t = text(await post.text());
  check("invalid slot and interest values are refused with a calm message; nothing is saved", post.status === 200 && t.includes("Please choose from the options shown") && JSON.stringify(await profile(DANA)) === before, `${post.status} ${t.slice(0, 200)}`);
  post = await submit(DANA, r.html, [["life_stage", "single"], ["group_pref", "mixed"], ["about_me", "x"]]);
  check("no meeting time at all is refused", post.status === 200 && text(await post.text()).includes("Pick at least one time") && JSON.stringify(await profile(DANA)) === before);
  post = await submit(DANA, r.html, [["life_stage", "single"], ["available_slots", "tue_am"], ["about_me", "a".repeat(1001)]]);
  check("an about_me over 1000 characters is refused", post.status === 200 && text(await post.text()).includes("under 1000 characters") && JSON.stringify(await profile(DANA)) === before);
  const priyaBefore = JSON.stringify(await profile("member_priya"));
  post = await submit(DANA, r.html, [...same(await profile(DANA)), ["person_id", P.member_priya.person_id], ["about_me", "crafted"]]);
  check("a crafted person_id in the payload is ignored: Priya is untouched", JSON.stringify(await profile("member_priya")) === priyaBefore);
  r = await get("leader_tom", "/member/intake");
  check("a Leader gets the member persona chooser, not Dana's or anyone's form", r.status === 200 && !text(r.html).includes("Save preferences"));
  post = await fetch(`${BASE}/member/intake`, { method: "POST", body: (() => { const f = new FormData(); f.append("available_slots", "tue_am"); return f; })(), redirect: "manual", headers: { cookie: "personaKey=leader_tom" } });
  check("a Leader posting to the member action changes no member's profile (only a member persona is accepted)", JSON.stringify(await profile(DANA)) === before, String(post.status));

  console.log("\nNo profile (Journey 2 shell)");
  r = await get("member_jordan", "/member/intake");
  t = text(r.html);
  check("a member with no profile sees an honest not-yet-available page and no fake confirm button", r.status === 200 && t.includes("not available in this demo yet") && !t.includes("Looks right") && !t.includes("Save preferences"), t.slice(0, 250));
  r = await get("member_jordan", "/member");
  check("Jordan's home still routes to intake", text(r.html).includes("Let's get to know you") && /href="\/member\/intake"/.test(r.html));
  r = await get(null, "/member/intake");
  check("with no persona chosen, the chooser is shown", r.status === 200 && !text(r.html).includes("Save preferences"));

  console.log("\nRestoring Dana through the same form");
  r = await get(DANA, "/member/intake");
  post = await submit(DANA, r.html, same(snap));
  const back = await profile(DANA);
  check("the original values are saved again through the form", post.status === 303 && JSON.stringify([...back.interests].sort()) === JSON.stringify([...snap.interests].sort()) && back.about_me === snap.about_me);
} finally {
  await restore();
  await cleanup();
  const end = await profile(DANA);
  check("cleanup: Dana's profile equals the original, no runs or audit rows remain", JSON.stringify(end) === JSON.stringify(snap) && (await runs(DANA)).length === 0 && (await auditCount()) === 0);
  await own.end(); await app.end();
}
console.log(failed ? `\n${failed} FAILED` : "\nAll smoke checks passed");
process.exit(failed ? 1 : 0);
