"""
Gathered: synthetic church seed generator (v0.2, 2026-11-03)

A fictional church in the Winter Garden, FL area. Every row is synthetic (is_synthetic = true).
No real people, no real addresses: households are zip-centroid plus random jitter.
Giving data is intentionally absent (spec W1).

v0.2 changes
  - FIX: persona exclusion compared ids to dicts, so personas could be drawn as random leaders, members or
    serving volunteers, and the manager got a profile. Replaced with an explicit RESERVED id set.
  - FIX: empty tables (recommendation, escalation, audit_log) now write header rows.
  - FIX: no person gets two member_profile rows.
  - ADD: 8 groups (20 total), so personas and test members reach 4-6 eligible groups and the LLM ranking has real
    choices. Includes near-duplicate groups that differ mostly in their descriptions.
  - ADD: attendance channels (kiosk child check-in, app geofence arrival, livestream, serving roster) with
    realistic gaps. Many adults are invisible on a given Sunday. See spec §3b.
  - ADD: personas Chris (leader of a forming group) and Jordan (new, no profile: live intake demo).
    Sam has a pending request to Chris's forming group (step-5 demo).
  - ADD: eval_label.csv, the answer key for the match-quality evaluation.
  - ADD: _truth_*.csv, hidden generator truth for validating person_features. NOT loaded into the app.

Output: ./out/*.csv + ./out/personas.json
  Operational tables -> Lakebase (Postgres, schema `app`)
  Engagement tables   -> Databricks (service, attendance_event, ministry, serving_assignment)

Usage:  python generate_seed.py            (deterministic; RNG seed 516)
"""
import csv, json, math, os, random, uuid
from collections import Counter, defaultdict
from datetime import date, datetime, time, timedelta

R = random.Random(516)
NS = uuid.UUID("5160b6a2-0000-4000-8000-000000000516")
TODAY = date(2026, 11, 1)                      # last Sunday of seeded history
WEEKS = 26
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
NOW = datetime(2026, 11, 2, 9, 0, 0).isoformat()

def uid(*parts):                                # stable UUIDs: named records keep their ids across runs
    return str(uuid.uuid5(NS, "|".join(map(str, parts))))

# ---------------------------------------------------------------- geography (W11, W12)
ZIPS = {
    "34787": (28.5300, -81.5900),  # Winter Garden
    "34786": (28.4850, -81.5350),  # Windermere
    "34761": (28.5750, -81.5350),  # Ocoee
    "34734": (28.5270, -81.5220),  # Gotha
    "34711": (28.5500, -81.7400),  # Clermont (mostly outside 5 mi of the core)
}
ZIP_WEIGHTS = [("34787", 40), ("34786", 18), ("34761", 22), ("34734", 6), ("34711", 14)]
RADIUS_MI = 5

def miles(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    d = 0.5 - math.cos((la2 - la1) * p) / 2 + math.cos(la1 * p) * math.cos(la2 * p) * (1 - math.cos((lo2 - lo1) * p)) / 2
    return 7917.5 * math.asin(math.sqrt(d))

def jitter(z):
    la, lo = ZIPS[z]
    return round(la + R.uniform(-0.025, 0.025), 5), round(lo + R.uniform(-0.025, 0.025), 5)

def near(pt, max_mi=1.5):                       # a point within ~max_mi of pt
    r = max_mi / 69.0
    return round(pt[0] + R.uniform(-r, r) * 0.7, 5), round(pt[1] + R.uniform(-r, r) * 0.7, 5)

def zip_for(pt):
    return min(ZIPS, key=lambda z: miles(ZIPS[z], pt))

def pick_zip():
    return R.choices([z for z, _ in ZIP_WEIGHTS], [w for _, w in ZIP_WEIGHTS])[0]

# ---------------------------------------------------------------- names (fictional)
M = "James John Michael David Chris Daniel Matt Josh Andrew Ryan Brandon Tyler Kevin Jason Eric Luis Carlos Jordan Nathan Aaron Caleb Isaac Ethan Owen Derek Sam Victor Andre Paul Greg".split()
F = "Mary Sarah Jessica Emily Ashley Amanda Rachel Megan Lauren Hannah Grace Olivia Sofia Maria Elena Natalie Rebecca Leah Abby Chloe Kayla Brianna Jasmine Tara Joy Lydia Naomi Esther Hope Claire".split()
KID = "Noah Liam Ava Mia Eli Lucy Levi Zoe Asher Nora Jude Ivy Micah Ruby Silas June".split()
LAST = "Bennett Carter Diaz Ellis Foster Garcia Hayes Jensen Kim Lopez Mendez Nguyen Ortiz Patel Reyes Brooks Sullivan Torres Walsh Young Coleman Bishop Dunn Fields Grant Hart Lane Moss Price Rowe".split()

SLOTS = ["sun_9", "sun_11", "sun_pm", "mon_eve", "tue_am", "tue_eve", "wed_am", "wed_eve", "thu_am", "thu_eve", "sat_am"]
MINISTRIES = [("Kids Ministry", "kids"), ("Worship Team", "worship"), ("Hospitality", "hospitality"),
              ("Student Ministry", "students"), ("Parking & Greeting", "hospitality"), ("Care Team", "care")]
INTERESTS = ["bible_reading", "prayer", "new_to_faith", "parenting", "marriage", "men", "women",
             "outdoors", "serving_together", "book_study", "recovery_friendly", "theology"]

# Column lists so empty tables still get headers
COLS = {
    "recommendation": ["rec_id", "person_id", "group_id", "rank", "score", "score_breakdown", "why_text", "model", "prompt_version", "generated_at"],
    "escalation": ["escalation_id", "source", "kind", "severity", "group_id", "person_id", "summary", "evidence", "status", "created_at", "resolved_by"],
    "audit_log": ["id", "actor_user_id", "action", "entity", "entity_id", "detail", "at"],
}
T = {k: [] for k in ["household", "person", "member_profile", "portal_user", "service", "attendance_event",
                     "ministry", "serving_assignment", "grp", "group_tag", "group_leader", "group_membership",
                     "group_meeting", "meeting_attendance", "join_request", "recommendation", "escalation", "audit_log",
                     "eval_label", "_truth_household", "_truth_person"]}

# ---------------------------------------------------------------- ministries & services
for name, area in MINISTRIES:
    T["ministry"].append(dict(ministry_id=uid("min", name), name=name, area=area))
MIN = {r["name"]: r["ministry_id"] for r in T["ministry"]}

for w in range(WEEKS):
    sun = TODAY - timedelta(weeks=w)
    for st, nm, slot in [(time(9), "Sunday 9:00", "sun_9"), (time(11), "Sunday 11:00", "sun_11")]:
        T["service"].append(dict(service_id=uid("svc", sun, st), service_date=sun.isoformat(), start_time=st.isoformat(),
                                 name=nm, slot=slot, livestreamed=(slot == "sun_11")))
    wed = sun - timedelta(days=4)
    T["service"].append(dict(service_id=uid("svc", wed, "19"), service_date=wed.isoformat(), start_time="19:00:00",
                             name="Wednesday Night", slot="wed_eve", livestreamed=False))

# ---------------------------------------------------------------- households & people
people = {}            # person_id -> internal record
households = {}        # household_id -> internal record (adults, kids, channel truth)
adults = []
RESERVED = set()       # personas, their spouses, designed members: never drawn at random

def add_household(key, z=None, loc=None):
    if loc:
        la, lo = loc; z = zip_for(loc)
    else:
        z = z or pick_zip(); la, lo = jitter(z)
    hh = dict(household_id=uid("hh", key), zip=z, lat_approx=la, lng_approx=lo, checkin_app_opt_in=False, app_opt_in_at="")
    T["household"].append(hh)
    households[hh["household_id"]] = dict(row=hh, adults=[], kids=[])
    return hh

def add_person(hh, first, last, gender, birth_year, role, first_attended):
    pid = uid("person", hh["household_id"], first, birth_year, role)
    row = dict(person_id=pid, household_id=hh["household_id"], first_name=first, last_name=last, gender=gender,
               birth_year=birth_year, household_role=role, first_attended_on=first_attended.isoformat(), is_synthetic=True)
    T["person"].append(row)
    people[pid] = dict(row, loc=(hh["lat_approx"], hh["lng_approx"]), kids=[], serves=[])
    households[hh["household_id"]]["adults" if role == "adult" else "kids"].append(pid)
    return pid

def tenure_start(months):
    return TODAY - timedelta(days=int(months * 30.4))

def make_family(key, stage, gender=None, age=None, tenure=None, loc=None, z=None, kids=None, couple=None):
    """Creates a household. Returns the primary adult's id."""
    hh = add_household(key, z=z, loc=loc)
    last = R.choice(LAST)
    tenure = tenure if tenure is not None else R.choice([R.uniform(1, 6), R.uniform(6, 36), R.uniform(36, 140)])
    age = age or {"young_kids": R.randint(27, 38), "school_age_kids": R.randint(33, 46), "teens": R.randint(40, 52),
                  "married_no_kids": R.randint(24, 34), "single": R.randint(22, 35), "empty_nest": R.randint(52, 64),
                  "retired": R.randint(65, 78)}[stage]
    if couple is None:
        couple = stage != "single" and R.random() < 0.88
    g1 = gender or R.choice(["M", "F"])
    genders = [g1] + (["F" if g1 == "M" else "M"] if couple else [])
    ids = []
    for g in genders:
        pid = add_person(hh, R.choice(M if g == "M" else F), last, g, TODAY.year - age - R.randint(-2, 2), "adult", tenure_start(tenure))
        people[pid].update(stage=stage, tenure=tenure); ids.append(pid); adults.append(pid)
    if kids is None:
        rng = {"young_kids": (0, 4), "school_age_kids": (5, 12), "teens": (13, 18)}.get(stage)
        kids = [R.randint(*rng) for _ in range(R.randint(1, 3))] if rng else []
    for ka in kids:
        add_person(hh, R.choice(KID), last, R.choice(["M", "F"]), TODAY.year - ka, "child", tenure_start(tenure))
        for a in ids: people[a]["kids"].append(ka)
    return ids[0]

# general congregation (150 households, same archetype mix as v0.1)
ARCH = [("young_kids", 26), ("school_age_kids", 22), ("teens", 12), ("married_no_kids", 10),
        ("single", 14), ("empty_nest", 12), ("retired", 8)]
for i in range(150):
    stage = R.choices([a for a, _ in ARCH], [w for _, w in ARCH])[0]
    make_family(f"gen{i}", stage)

# ---------------------------------------------------------------- demo personas
PERSONAS = {}
def persona(key, first, last, gender, age, stage, tenure_m, z, kids=(), role="member", loc=None, spouse=None, landing=True):
    hh = add_household("persona_" + key, z=None if loc else z, loc=loc)
    pid = add_person(hh, first, last, gender, TODAY.year - age, "adult", tenure_start(tenure_m))
    people[pid].update(stage=stage, tenure=tenure_m); adults.append(pid); RESERVED.add(pid)
    if spouse:
        sp = add_person(hh, spouse[0], last, spouse[1], TODAY.year - age + 1, "adult", tenure_start(tenure_m))
        people[sp].update(stage=stage, tenure=tenure_m); adults.append(sp); RESERVED.add(sp)
    for ka in kids:
        add_person(hh, R.choice(KID), last, R.choice(["M", "F"]), TODAY.year - ka, "child", tenure_start(tenure_m))
        for a in households[hh["household_id"]]["adults"]: people[a]["kids"].append(ka)
    if landing:
        PERSONAS[key] = dict(person_id=pid, display=f"{first} {last}", role=role)
    return pid

WG = ZIPS["34787"]
alan   = persona("manager",      "Alan",   "Whitfield", "M", 51, "school_age_kids", 120, "34787", kids=(11, 14), role="manager", spouse=("Karen", "F"))
tom    = persona("leader_tom",   "Tom",    "Brennan",   "M", 36, "young_kids", 60, "34787", kids=(2, 4), role="leader", spouse=("Jill", "F"))
grace  = persona("leader_grace", "Grace",  "Okafor",    "F", 44, "school_age_kids", 84, "34761", kids=(8, 10), role="leader", spouse=("Daniel", "M"))
chris  = persona("leader_chris", "Chris",  "Delgado",   "M", 34, "young_kids", 40, None, kids=(1, 4), role="leader", spouse=("Amy", "F"),
                 loc=near(WG, 1.0))
marcus = persona("member_marcus", "Marcus", "Hale",     "M", 33, "young_kids", 14, "34787", kids=(1, 3), spouse=("Erin", "F"))
dana   = persona("member_dana",  "Dana",   "Ruiz",      "F", 29, "single", 1.5, "34786")
ruth   = persona("member_ruth",  "Ruth",   "Abbott",    "F", 61, "empty_nest", 110, "34787", spouse=("Walter", "M"))
priya  = persona("member_priya", "Priya",  "Shah",      "F", 31, "young_kids", 8, "34761", kids=(1, 3), spouse=("Dev", "M"))
jordan = persona("member_jordan", "Jordan", "Pike",     "M", 30, "young_kids", 1, None, kids=(1, 3), spouse=("Kate", "F"),
                 loc=near(people[chris]["loc"], 1.2))
sam    = persona("sam", "Sam", "Whitaker", "M", 32, "young_kids", 6, None, kids=(0, 2), spouse=("Lena", "F"),
                 loc=near(people[chris]["loc"], 1.2), landing=False)

TODDLER_MOMS = [priya]                          # escalation #3: no weekday-morning group within 5 miles
for i, z in enumerate(["34787", "34787", "34761", "34786", "34787"]):
    TODDLER_MOMS.append(persona(f"tmom{i}", R.choice(F), R.choice(LAST), "F", R.randint(27, 35), "young_kids", R.uniform(3, 30), z,
                                kids=(R.randint(0, 2), R.randint(2, 4)), spouse=(R.choice(M), "M"), landing=False))

# ---------------------------------------------------------------- serving
def serve(pid, ministry, role, slot, freq="weekly", months=12):
    T["serving_assignment"].append(dict(person_id=pid, ministry_id=MIN[ministry], role=role, schedule_slot=slot,
                                        frequency=freq, start_on=tenure_start(months).isoformat(), end_on=""))
    people[pid]["serves"].append((ministry, slot, freq))

serve(marcus, "Kids Ministry", "Preschool room", "sun_11", "weekly", 10)        # the hidden conflict
serve(tom, "Kids Ministry", "Check-in", "sun_9", "biweekly", 30)
serve(grace, "Hospitality", "Coffee team lead", "sun_9", "weekly", 48)
serve(ruth, "Care Team", "Meals coordinator", "wed_eve", "monthly", 72)
serve(ruth, "Hospitality", "Greeter", "sun_9", "biweekly", 96)
for pid in R.sample([a for a in adults if a not in RESERVED], 60):
    m, _ = R.choice(MINISTRIES)
    serve(pid, m, "Volunteer", R.choice(["sun_9", "sun_11", "wed_eve"]), R.choice(["weekly", "biweekly", "monthly"]), R.randint(2, 60))

# ---------------------------------------------------------------- groups (leader hosts at home: W11)
GROUPS = {}
def group(key, name, desc, gender, stage, slot, leader, cap_max=8, status="open", childcare=False, tags=(), online=False):
    gid = uid("grp", key)
    lp = people[leader]
    g = dict(group_id=gid, name=name, description=desc, gender_focus=gender, life_stage_focus=stage, meeting_slot=slot,
             frequency="weekly", lat_approx=lp["loc"][0], lng_approx=lp["loc"][1], is_online=online,
             capacity_min=3, capacity_max=cap_max, childcare=childcare, status=status)
    T["grp"].append(g)
    T["group_leader"].append(dict(group_id=gid, person_id=leader, role="leader", start_on=tenure_start(10).isoformat()))
    for t in tags:
        T["group_tag"].append(dict(group_id=gid, tag=t))
    GROUPS[key] = dict(g, key=key, leader=leader)
    RESERVED.add(leader)
    return gid

USED = set()           # anyone already placed as a leader or member
def free_adult(gender=None, stage=None, near_pt=None):
    pool = [a for a in adults if a not in USED and a not in RESERVED
            and (not gender or people[a]["gender"] == gender) and (not stage or people[a].get("stage") in stage)
            and (not near_pt or miles(people[a]["loc"], near_pt) <= RADIUS_MI)]
    if not pool:
        return None
    a = R.choice(pool); USED.add(a); return a

def leader(gender, stage, near_pt=WG, key="x"):
    a = free_adult(gender, stage, near_pt)
    return a or make_family(f"leader_{key}", stage[0], gender=gender, loc=near(near_pt, 2.0))

FS_LOC = near(ZIPS["34786"], 1.0)               # First Steps leader's home, Windermere
fs_leader = make_family("leader_newfaith", "empty_nest", gender="F", loc=FS_LOC, tenure=90)
MARCUS_LOC = people[marcus]["loc"]

# --- v0.1 groups (same names, keys and ids) ---
group("tom", "Tuesday Night Dads", "Dads of little ones walking through the Gospel of Mark. We keep it simple: read, pray, and actually check in on each other.",
      "men", "young_kids", "tue_eve", tom, tags=("parenting", "men", "bible_reading"))
group("sunpm", "Sunday Lunch D-Group", "We meet right after second service over lunch at the Carters' house. Men's discipleship group, Romans this fall.",
      "men", "young_kids", "sun_pm", make_family("leader_sunpm", "school_age_kids", gender="M", loc=near(MARCUS_LOC, 2.5), tenure=70),
      tags=("men", "bible_reading", "theology"))
group("grace", "Women of the Word", "Moms in the middle years reading through Philippians. Kids are welcome in the next room on the first Thursday.",
      "women", "school_age_kids", "thu_eve", grace, tags=("women", "bible_reading", "parenting"))
group("newfaith", "First Steps", "A slow walk through the Gospel of John for people who are new to faith or coming back to it. Questions are welcome.",
      "mixed", "single", "wed_eve", fs_leader, tags=("new_to_faith", "bible_reading", "prayer"))
group("couples", "Young Couples", "Married couples without kids yet, or with one on the way. Monday dinners and a marriage study.",
      "couples", "married_no_kids", "mon_eve", leader("M", ("married_no_kids",), key="couples"), tags=("marriage",))
group("emptynest", "Second Half", "Empty nesters and recent retirees. Saturday breakfast, Psalms, and a serving project each quarter.",
      "mixed", "empty_nest", "sat_am", leader("M", ("empty_nest", "retired"), key="emptynest"), tags=("serving_together", "prayer"))
group("men_sat", "Saturday Men's Breakfast", "Men of every season. Breakfast, a chapter of Proverbs, and accountability.",
      "men", "school_age_kids", "sat_am", leader("M", ("school_age_kids", "teens"), key="men_sat"), status="full", tags=("men", "bible_reading"))
group("teens", "Parents of Teens", "Honest conversation for parents navigating the teenage years, using a book study.",
      "mixed", "teens", "thu_eve", leader("F", ("teens",), key="teens"), status="full", tags=("parenting", "book_study"))
group("singles", "Thursday Twenties", "Singles in their twenties and early thirties. Dinner, a book of the Bible, and real friendship.",
      "mixed", "single", "thu_eve", make_family("leader_singles", "single", gender="M", loc=near(FS_LOC, 2.5), tenure=30, couple=False),
      tags=("bible_reading", "outdoors"))
group("clermont", "Lakeside Women", "Women's D-Group meeting near the lakes in Clermont. Reading plan plus prayer.",
      "women", "school_age_kids", "tue_eve", leader("F", ("school_age_kids", "teens"), ZIPS["34711"], key="clermont"), tags=("women", "prayer", "bible_reading"))
group("forming_m", "New Men's D-Group (forming)", "A new men's discipleship group launching this winter for dads of young kids. Bible-reading plan and weekly check-ins.",
      "men", "young_kids", "thu_eve", chris, status="forming", tags=("men", "bible_reading", "parenting"))
group("forming_w", "New Women's D-Group (forming)", "A new women's discipleship group. Reading through 1 John together.",
      "women", "single", "tue_eve", leader("F", ("single", "married_no_kids"), key="forming_w"), status="forming", tags=("women", "bible_reading", "new_to_faith"))

# --- v0.2 groups: near-duplicates the LLM must tell apart ---
# Dana cluster (Wed/Thu evenings, near Windermere)
group("deeproots", "Deep Roots", "Women working chapter by chapter through a systematic theology text. Weekly reading and discussion questions; best for those who have studied the Bible for years.",
      "women", "single", "wed_eve", make_family("leader_deeproots", "married_no_kids", gender="F", loc=near(FS_LOC, 1.5), tenure=100),
      tags=("women", "theology", "book_study"))
group("wordwomen", "Thursday Women in the Word", "Young professional women reading one book of the Bible each month at a brisk pace, with memory-verse goals.",
      "women", "single", "thu_eve", make_family("leader_wordwomen", "single", gender="F", loc=near(FS_LOC, 1.5), tenure=50, couple=False),
      tags=("women", "bible_reading"))
group("prayer", "Midweek Prayer & Worship", "An hour of worship and prayer for our church and city. Little discussion, lots of prayer.",
      "mixed", "empty_nest", "wed_eve", make_family("leader_prayer", "empty_nest", gender="M", loc=near(FS_LOC, 1.5), tenure=130),
      tags=("prayer",))
# Marcus cluster (Tue evening / Sunday afternoon, near Winter Garden)
group("accountability", "Tuesday Men's Accountability", "Men who want hard questions and real accountability. A short passage, then most of the night on confession and prayer.",
      "men", "school_age_kids", "tue_eve", make_family("leader_accountability", "school_age_kids", gender="M", loc=near(MARCUS_LOC, 1.5), tenure=80),
      tags=("men", "prayer"))
group("iron", "Men of Iron", "Older men going line by line through Romans with commentaries. Seasoned, theological, and unhurried.",
      "men", "empty_nest", "tue_eve", make_family("leader_iron", "empty_nest", gender="M", loc=near(MARCUS_LOC, 1.5), tenure=140),
      tags=("men", "theology", "book_study"))
group("supper", "Sunday Supper Families", "Young families share supper on Sunday evenings. Kids play while parents talk through the sermon.",
      "couples", "young_kids", "sun_pm", make_family("leader_supper", "young_kids", gender="M", loc=near(MARCUS_LOC, 1.5), tenure=45),
      childcare=True, tags=("parenting", "marriage"))
# Outside the radius on purpose (escalation #3: the nearest weekday-morning moms group is too far)
group("clermont_moms", "Clermont Moms Morning", "Moms of little ones on Tuesday mornings in Clermont. Kids welcome; we take turns watching them.",
      "women", "young_kids", "tue_am", make_family("leader_clermont_moms", "young_kids", gender="F", loc=near(ZIPS["34711"], 0.8), tenure=36),
      childcare=True, tags=("women", "parenting", "prayer"))
# Online
group("online", "Online Thursday Study", "An online video study for people who travel, work shifts, or mostly join services by livestream. Cameras optional.",
      "mixed", "single", "thu_eve", leader("F", ("married_no_kids", "single"), WG, key="online"), online=True,
      tags=("bible_reading", "book_study"))

# memberships: target headcounts. Under minimum: newfaith, couples. Full: men_sat, teens. Forming: forming_m, forming_w.
TARGET = dict(tom=5, sunpm=4, grace=6, newfaith=2, couples=2, emptynest=6, men_sat=8, teens=8, singles=5, clermont=4,
              forming_m=0, forming_w=0, deeproots=5, wordwomen=4, prayer=5, accountability=4, iron=5, supper=4,
              clermont_moms=4, online=4)
STAGE_FIT = dict(tom=("young_kids",), sunpm=("young_kids", "school_age_kids"), grace=("school_age_kids", "young_kids"),
                 newfaith=("single", "married_no_kids", "empty_nest"), couples=("married_no_kids",), emptynest=("empty_nest", "retired"),
                 men_sat=("school_age_kids", "teens", "empty_nest"), teens=("teens",), singles=("single",), clermont=("school_age_kids", "teens"),
                 deeproots=("married_no_kids", "empty_nest", "single"), wordwomen=("single",), prayer=("empty_nest", "retired"),
                 accountability=("school_age_kids", "teens"), iron=("empty_nest", "retired"), supper=("young_kids",),
                 clermont_moms=("young_kids",), online=("single", "married_no_kids", "school_age_kids"))
GENDER_OF = dict(men="M", women="F")
IN_GROUP = {}
def join(gid, pid, days_ago):
    IN_GROUP[pid] = gid; USED.add(pid)
    T["group_membership"].append(dict(group_id=gid, person_id=pid, status="active",
        joined_at=datetime.combine(TODAY - timedelta(days=days_ago), time(19)).isoformat(), left_at="", left_reason=""))

join(GROUPS["emptynest"]["group_id"], ruth, 600)  # Ruth is in a group ("in a group" member view)
for key, g in GROUPS.items():
    n = TARGET[key] - (1 if key == "emptynest" else 0)
    loc = (g["lat_approx"], g["lng_approx"])
    for i in range(n):
        gender = GENDER_OF.get(g["gender_focus"])
        m = free_adult(gender, STAGE_FIT.get(key), None if g["is_online"] else loc) \
            or make_family(f"member_{key}_{i}", STAGE_FIT[key][0], gender=gender, loc=None if g["is_online"] else near(loc, 3.0))
        join(g["group_id"], m, R.randint(20, 400))
    if key == "newfaith":                       # a former member left: history for the manager
        ex = free_adult(None, None, loc) or make_family("member_newfaith_ex", "single", loc=near(loc, 2))
        T["group_membership"].append(dict(group_id=g["group_id"], person_id=ex, status="left",
            joined_at=datetime.combine(TODAY - timedelta(days=200), time(19)).isoformat(),
            left_at=datetime.combine(TODAY - timedelta(days=45), time(19)).isoformat(), left_reason="schedule change"))

# group meetings + attendance: last 12 weeks, Manager-only (W2)
for key, g in GROUPS.items():
    if g["status"] == "forming": continue
    members = [m["person_id"] for m in T["group_membership"] if m["group_id"] == g["group_id"] and m["status"] == "active"]
    rate = 0.55 if key in ("newfaith", "couples") else 0.82
    for w in range(12):
        mid = uid("mtg", g["group_id"], w)
        T["group_meeting"].append(dict(meeting_id=mid, group_id=g["group_id"], met_on=(TODAY - timedelta(weeks=w, days=R.randint(0, 5))).isoformat()))
        for m in members:
            T["meeting_attendance"].append(dict(meeting_id=mid, person_id=m, present=R.random() < rate))

# ---------------------------------------------------------------- member profiles (opt-in only)
PROFILED = set()
def profile(pid, stage, slots, pref, interests, about, maxd=RADIUS_MI):
    if pid in PROFILED: return
    PROFILED.add(pid)
    T["member_profile"].append(dict(person_id=pid, opted_in_at=datetime.combine(TODAY - timedelta(days=R.randint(3, 60)), time(20)).isoformat(),
        consent_version="v1-2026-10", life_stage=stage, available_slots="{" + ",".join(slots) + "}", max_distance_mi=maxd, group_pref=pref,
        interests="{" + ",".join(interests) + "}", about_me=about, profile_source="llm_confirmed", confirmed_at=NOW))

profile(marcus, "young_kids", ["sun_pm", "tue_eve"], "men", ["men", "parenting", "bible_reading"],
        "Dad of two little ones. I help in the preschool room during second service most Sundays. Looking for a few guys to actually go deep with, not just small talk.")
profile(dana, "single", ["wed_eve", "thu_eve"], "women", ["bible_reading", "new_to_faith", "prayer"],
        "Moved here for work in September. I grew up going to church but never really read the Bible on my own. I'd like to start, with people who won't judge my questions.")
profile(ruth, "empty_nest", ["sat_am", "wed_am", "tue_am"], "mixed", ["prayer", "serving_together"],
        "Kids are grown and gone. I love hosting and I've walked alongside a lot of young moms over the years.")
profile(sam, "young_kids", ["thu_eve", "tue_eve"], "men", ["men", "parenting"],
        "Two kids under three. Thursdays are the one night I can reliably get out.")
for pid in TODDLER_MOMS:
    profile(pid, "young_kids", R.sample(["tue_am", "wed_am", "thu_am"], 2), "women", ["parenting", "women", "prayer"],
            R.choice(["Home with a toddler and a baby. Evenings are impossible with bedtime. A weekday morning with other moms would be a lifeline.",
                      "Mornings are the only time I can do anything. Looking for other moms of little ones and something that allows kids.",
                      "I work part-time from home. Weekday mornings work best; my two-year-old would need to come with me."]))
# Jordan has NO profile on purpose: the demo shows intake live. Suggested text is in personas.json.

# ---------------------------------------------------------------- eval members (answer key for match quality)
# Each is placed so several groups pass the hard filters; the cue in about_me points to one of them.
EVAL = [
  # key, gender, stage, near point, slots, pref, interests, about_me, expected group, acceptable alternates
  ("e01", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "women", ["theology", "book_study"],
   "I've read theology for years and want women who will push me on doctrine. Homework is fine.", "deeproots", []),
  ("e02", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "women", ["bible_reading"],
   "I want to memorize Scripture and move quickly. I'm disciplined and I love a reading plan.", "wordwomen", []),
  ("e03", "F", "empty_nest", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["prayer"],
   "I don't need a lot of discussion. I want to pray for people, and for our church.", "prayer", []),
  ("e04", "M", "single", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["new_to_faith"],
   "Not sure what I believe yet. A friend invited me and I have a lot of questions.", "newfaith", []),
  ("e05", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["bible_reading"],
   "I travel for work half the month, so I'd need to join from wherever I am.", "online", []),
  ("e06", "M", "young_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "couples", ["marriage", "parenting"],
   "My wife and I want to do this together, and our kids need to be included somehow.", "supper", []),
  ("e07", "M", "empty_nest", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["theology"],
   "I've taught Sunday school for twenty years. I want to go deep in Romans with men my age.", "iron", []),
  ("e08", "M", "school_age_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["men", "prayer"],
   "There are some things I need to confess to other men. I need accountability, not a lecture.", "accountability", []),
  ("e09", "M", "young_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["parenting", "men"],
   "Two toddlers at home. I want other dads in the same season.", "tom", ["supper"]),
  ("e10", "M", "school_age_kids", MARCUS_LOC, ["sun_pm", "tue_eve"], "men", ["theology", "men"],
   "I'd love to keep the sermon conversation going right after church over lunch.", "sunpm", []),
  ("e11", "M", "young_kids", None, ["thu_eve", "tue_eve"], "men", ["parenting"],
   "New dad. I'd like to start something fresh with other young dads.", "forming_m", ["tom"]),
  ("e12", "F", "married_no_kids", FS_LOC, ["wed_eve", "thu_eve"], "women", ["theology"],
   "Seminary-trained and looking for women who want real depth.", "deeproots", []),
]
EVAL_MEMBERS = {}
for key, gender, stage, pt, slots, pref, ints, about, exp, alts in EVAL:
    pt = pt or people[chris]["loc"]
    pid = make_family(f"eval_{key}", stage, gender=gender, loc=near(pt, 0.9), couple=(stage not in ("single",)))
    RESERVED.update(households[people[pid]["household_id"]]["adults"])
    profile(pid, stage, slots, pref, ints, about)
    EVAL_MEMBERS[key] = pid
    T["eval_label"].append(dict(person_id=pid, label_key=key, expected_group_id=GROUPS[exp]["group_id"], expected_group_name=GROUPS[exp]["name"],
                                acceptable_group_ids="|".join(GROUPS[a]["group_id"] for a in alts), cue=about))
for who, exp in [(marcus, "tom"), (dana, "newfaith")]:
    T["eval_label"].append(dict(person_id=who, label_key="persona", expected_group_id=GROUPS[exp]["group_id"],
                                expected_group_name=GROUPS[exp]["name"], acceptable_group_ids="", cue="persona"))

# ~45 more opted-in members: some in groups, ~22 not
not_in = [a for a in adults if a not in IN_GROUP and a not in RESERVED and a not in USED]
in_grp = [a for a in IN_GROUP if a not in RESERVED]
for pid in R.sample(not_in, 22) + R.sample(in_grp, 23):
    p = people[pid]
    st = p.get("stage", "single")
    pref = ("men" if p["gender"] == "M" else "women") if R.random() < 0.5 else ("couples" if st == "married_no_kids" and R.random() < 0.5 else "mixed")
    profile(pid, st, R.sample(["mon_eve", "tue_eve", "wed_eve", "thu_eve", "sat_am", "sun_pm"], 2), pref, R.sample(INTERESTS, 3), "")

# ---------------------------------------------------------------- attendance channels (data platform, spec §3b)
# Hidden truth per household: online_mode and kiosk use. Observable signals:
#   kiosk         child check-in row (person = child, checked_in_by = the adult who checked them in)
#   app_geofence  "arrived on campus" event, only for households that opted in to the church app
#   serving_roster adult was rostered to serve that slot (serving implies presence)
#   livestream    logged-in viewing session with minutes_watched (one per household)
# An adult with no kids, no app and no serving slot leaves NO trace when attending in person.
DRIFTED = set()
def household_truth(hid):
    h = households[hid]
    kids12 = [k for k in h["kids"] if TODAY.year - people[k]["birth_year"] <= 12]
    mode = R.choices(["in_person", "hybrid", "online_only"], [62, 26, 12])[0]
    app = R.random() < 0.25
    kiosk = bool(kids12) and R.random() < 0.88
    return mode, app, kiosk, kids12

def adult_propensity(pid):
    if pid in (ruth, alan, tom, grace, chris): return 0.92
    if pid == dana: return 0.95
    if pid in (marcus, jordan, sam): return 0.88
    return R.choice([0.25, 0.45, 0.65, 0.8, 0.9])

FORCE = {  # persona channel truth, so their stories hold
    households[people[dana]["household_id"]]["row"]["household_id"]: ("in_person", True, False),
    households[people[ruth]["household_id"]]["row"]["household_id"]: ("in_person", True, False),
    households[people[marcus]["household_id"]]["row"]["household_id"]: ("in_person", False, True),
    households[people[jordan]["household_id"]]["row"]["household_id"]: ("hybrid", False, True),
    households[people[priya]["household_id"]]["row"]["household_id"]: ("hybrid", True, True),
}
svc_by_week = defaultdict(dict)
for s in T["service"]:
    svc_by_week[s["service_date"]][s["slot"]] = s

def rostered(pid, slot, week_index):
    for _, sl, freq in people[pid]["serves"]:
        if sl != slot: continue
        if freq == "weekly" or (freq == "biweekly" and week_index % 2 == 0) or (freq == "monthly" and week_index % 4 == 0):
            return True
    return False

for hid, h in households.items():
    if not h["adults"]: continue
    mode, app, kiosk, kids12 = household_truth(hid)
    if hid in FORCE:
        mode, app, kf = FORCE[hid]; kiosk = kf and bool(kids12)
    row = h["row"]
    if app:
        row["checkin_app_opt_in"] = True
        row["app_opt_in_at"] = datetime.combine(TODAY - timedelta(days=R.randint(30, 400)), time(12)).isoformat()
    props = {a: adult_propensity(a) for a in h["adults"]}
    hh_prop = max(props.values())
    svc = "sun_11" if (h["adults"][0] in (marcus,) or R.random() < 0.5) else "sun_9"
    start = min(date.fromisoformat(people[a]["first_attended_on"]) for a in h["adults"])
    drift = R.random() < 0.12 and not (set(h["adults"]) & RESERVED)
    if drift: DRIFTED.update(h["adults"])
    T["_truth_household"].append(dict(household_id=hid, online_mode=mode, kiosk_user=kiosk, app_opt_in=app, home_service=svc, drifted=drift))
    for a in h["adults"]:
        T["_truth_person"].append(dict(person_id=a, propensity=props[a], drifted=drift))
    for w in range(WEEKS):
        sun = TODAY - timedelta(weeks=w)
        if sun < start: continue
        if drift and w < 8: continue                                    # stopped coming ~2 months ago
        if R.random() >= hh_prop: continue                              # household skipped this Sunday
        online = mode == "online_only" or (mode == "hybrid" and R.random() < 0.45)
        s = svc_by_week[sun.isoformat()]["sun_11" if online else svc]
        hh_, mm_ = map(int, s["start_time"].split(":")[:2])
        base = datetime.combine(sun, time(hh_, mm_))
        if online:
            T["attendance_event"].append(dict(person_id=h["adults"][0], service_id=s["service_id"], channel="livestream",
                checked_in_by="", checked_in_at=(base + timedelta(minutes=R.randint(0, 10))).isoformat(), minutes_watched=R.choice([4, 9, 18, 35, 52, 64, 71])))
            continue
        present = [a for a in h["adults"] if a == h["adults"][0] or R.random() < 0.9]
        for a in present:                                               # serving roster (serving implies presence)
            if rostered(a, s["slot"], w):
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="serving_roster",
                    checked_in_by="", checked_in_at=(base - timedelta(minutes=45)).isoformat(), minutes_watched=""))
        if app:
            for a in present:
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="app_geofence",
                    checked_in_by="", checked_in_at=(base - timedelta(minutes=R.randint(3, 20))).isoformat(), minutes_watched=""))
        if kiosk:
            by = R.choice(present)
            for k in kids12:
                T["attendance_event"].append(dict(person_id=k, service_id=s["service_id"], channel="kiosk",
                    checked_in_by=by, checked_in_at=(base - timedelta(minutes=R.randint(2, 12))).isoformat(), minutes_watched=""))
    # Wednesday nights: in person only, smaller crowd
    for w in range(WEEKS):
        wed = TODAY - timedelta(weeks=w, days=4)
        if wed < start or (drift and w < 8) or mode == "online_only" or R.random() >= hh_prop * 0.3: continue
        s = svc_by_week[wed.isoformat()]["wed_eve"]
        base = datetime.combine(wed, time(19))
        for a in h["adults"]:
            if rostered(a, "wed_eve", w):
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="serving_roster",
                    checked_in_by="", checked_in_at=(base - timedelta(minutes=30)).isoformat(), minutes_watched=""))
            if app:
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="app_geofence",
                    checked_in_by="", checked_in_at=(base - timedelta(minutes=R.randint(3, 15))).isoformat(), minutes_watched=""))

# ---------------------------------------------------------------- portal users (mock auth: W5)
for key, p in PERSONAS.items():
    T["portal_user"].append(dict(user_id=uid("user", key), person_id=p["person_id"], role=p["role"], email=f"{key}@demo.gathered.invalid"))

# ---------------------------------------------------------------- open join requests (leader views)
for i in range(2):
    req = free_adult("M", ("young_kids",), people[tom]["loc"]) or make_family(f"req_tom_{i}", "young_kids", gender="M", loc=near(people[tom]["loc"], 2))
    profile(req, "young_kids", ["tue_eve"], "men", ["parenting", "men"], "")
    T["join_request"].append(dict(request_id=uid("req", i), person_id=req, group_id=GROUPS["tom"]["group_id"], rec_id="", status="requested",
        member_note=["Saw this pop up for me. Tuesdays work and I'm close by.", "My wife said I need guys in my life. She's right."][i],
        requested_at=datetime.combine(TODAY - timedelta(days=[2, 9][i]), time(21)).isoformat(), decided_at="", decided_by="", decline_reason=""))
T["join_request"].append(dict(request_id=uid("req", "sam"), person_id=sam, group_id=GROUPS["forming_m"]["group_id"], rec_id="", status="requested",
    member_note="Thursdays are perfect. Happy to help get this one started.",
    requested_at=datetime.combine(TODAY - timedelta(days=1), time(20)).isoformat(), decided_at="", decided_by="", decline_reason=""))

# ---------------------------------------------------------------- write
os.makedirs(OUT, exist_ok=True)
for name, rows in T.items():
    cols = list(rows[0].keys()) if rows else COLS.get(name, [])
    with open(os.path.join(OUT, f"{name}.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader(); w.writerows(rows)

def gname(gid): return next(g["name"] for g in GROUPS.values() if g["group_id"] == gid)
landing = []
for k, v in PERSONAS.items():
    p = dict(key=k, **v)
    if p["role"] == "manager":
        p["blurb"] = "Groups pastor: sees every group, meeting attendance and escalations"
    elif p["role"] == "leader":
        p["blurb"] = "Leads " + next(g["name"] for g in GROUPS.values() if g["leader"] == p["person_id"])
    elif p["person_id"] in IN_GROUP:
        p["blurb"] = "In a group: " + gname(IN_GROUP[p["person_id"]])
    elif p["person_id"] not in PROFILED:
        p["blurb"] = "New here, no profile yet: tells us about himself, then sees recommendations"
        p["demo_intake_text"] = ("We just moved here and have two little ones. Weeknights after bedtime are tough, but Thursday or Tuesday "
                                 "evenings could work. I'd like a few other dads to grow with.")
    else:
        p["blurb"] = "Not in a group yet: sees recommendations"
    landing.append(p)
with open(os.path.join(OUT, "personas.json"), "w", encoding="utf-8") as f:
    json.dump(landing, f, indent=2)

# ---------------------------------------------------------------- sanity report
print("rows:", {k: len(v) for k, v in T.items()})
print("households", len(households), "adults", len(adults), "children", sum(1 for r in T["person"] if r["household_role"] == "child"))
print("attendance by channel:", dict(Counter(e["channel"] for e in T["attendance_event"])))
members_of = defaultdict(list)
for m in T["group_membership"]:
    if m["status"] == "active": members_of[m["group_id"]].append(m["person_id"])
for g in GROUPS.values():
    print(f"  {g['name']:<34} {g['status']:<8} members={len(members_of[g['group_id']])} slot={g['meeting_slot']}{' online' if g['is_online'] else ''}")

busy = defaultdict(set)
for s in T["serving_assignment"]: busy[s["person_id"]].add(s["schedule_slot"])
prof = {r["person_id"]: r for r in T["member_profile"]}
def eligible(pid, slots=None):
    pr = prof.get(pid); slots = slots or set(pr["available_slots"].strip("{}").split(","))
    out = []
    for g in GROUPS.values():
        if g["status"] not in ("open", "forming") or len(members_of[g["group_id"]]) >= g["capacity_max"]: continue
        sex = people[pid]["gender"]
        if (g["gender_focus"] == "men" and sex != "M") or (g["gender_focus"] == "women" and sex != "F"): continue
        if g["meeting_slot"] not in slots or g["meeting_slot"] in busy[pid]: continue
        if not g["is_online"] and miles(people[pid]["loc"], (g["lat_approx"], g["lng_approx"])) > RADIUS_MI: continue
        out.append(g["key"])
    return out
dist = Counter(len(eligible(p)) for p in prof if p not in IN_GROUP)
print("eligible-group counts, unmatched opted-in members:", sorted(dist.items()))
for name, pid in [("Marcus", marcus), ("Dana", dana), ("Priya", priya), ("Sam", sam)]:
    print(f"  {name}: {eligible(pid)}")
print(f"  Jordan (after intake, Tue/Thu eve): {eligible(jordan, {'tue_eve', 'thu_eve'}) if True else ''}")
ok = 0
for lab in T["eval_label"]:
    el = eligible(lab["person_id"]); exp = next(g["key"] for g in GROUPS.values() if g["group_id"] == lab["expected_group_id"])
    ok += exp in el
    print(f"  eval {lab['label_key']:<8} expected={exp:<15} eligible={el}")
print(f"expected group passes hard filters for {ok}/{len(T['eval_label'])} labels")
print("manager has a profile?", alan in PROFILED, "| personas drawn at random?", bool(set(p['person_id'] for p in PERSONAS.values()) & (USED - set(IN_GROUP))))
