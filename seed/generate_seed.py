"""
Gathered: synthetic church seed generator (v1.0, 2026-11-10)

A large, multi-campus fictional church in the Winter Garden, FL area, built to the approved design in
docs/Gathered - Synthetic Data Design.md. Every row is synthetic (is_synthetic = true). No real people, no
real addresses: households are zip-centroid plus random jitter. Giving data is intentionally absent (W1).

Structure (top to bottom)
  1. CONFIG        scale, geography and campuses, archetypes, patterns, group-family templates
  2. HELPERS       deterministic RNG, UUIDs, geography
  3. SERVICES      eight weekly services over 52 weeks (four campuses plus online)
  4. POPULATION    named persona overlays, then the general congregation from household archetypes
  5. SERVING       ministry assignments
  6. GROUPS        legacy named groups, designed scenario groups, then group-family templates (about 140)
  7. MEMBERSHIPS   occupancy plans, historical departures, 52 weeks of meetings and attendance
  8. PROFILES      opt-in profiles from member archetypes, then a feasibility pass
  9. EVALUATION    existing 14 labels preserved, new scenarios added
 10. ENGAGEMENT    52 weeks of attendance signals from per-household patterns
 11. OUTPUT        CSV, personas.json, truth files

Determinism: RNG seed 516. Named records (personas, evaluation members, named groups, journey leaders) have
stable UUIDs: ids are uuid5 of stable keys, and the people whose ids existed in generator v0.2 are recorded in
LEGACY_PEOPLE so their ids never move. The bulk population draws from one seeded stream; named overlays use
per-entity streams (rng_for) so they do not shift when the bulk changes.

Output: <out>/*.csv + <out>/personas.json   (default seed/out; override with --out DIR)
  Operational tables -> Lakebase (Postgres, schema `app`)
  Engagement tables  -> Databricks (service, attendance_event, ministry, serving_assignment)
  _truth_*.csv       -> validation only, never loaded

Usage:  python seed/generate_seed.py [--out DIR]
"""
import argparse, csv, json, math, os, random, time as _clock, uuid
from collections import Counter, defaultdict
from datetime import date, datetime, time as dtime, timedelta

GENERATOR_VERSION = "v2.0 (2026-11-10)"
SEED = 516
NS = uuid.UUID("5160b6a2-0000-4000-8000-000000000516")
TODAY = date(2026, 11, 1)                      # last Sunday of seeded history
NOW = datetime(2026, 11, 2, 9, 0, 0).isoformat()

ap = argparse.ArgumentParser()
ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
OUT = ap.parse_args().out
_t0 = _clock.time()

# ================================================================ 1. CONFIG
SCALE = dict(
    adult_population=4500,       # adults, including those who rarely or never attend
    history_weeks=52,
    target_groups=140,
    profile_rate=0.34,           # share of adults with a recommendation profile (design 4.4: 30-45 percent)
    left_membership_rate=0.12,   # historical departures relative to active memberships
    serving_rate=0.11,           # share of participating adults with a serving assignment
)
WEEKS = SCALE["history_weeks"]

ZIPS = {
    "34787": (28.5300, -81.5900),  # Winter Garden
    "34786": (28.4850, -81.5350),  # Windermere
    "34761": (28.5750, -81.5350),  # Ocoee
    "34734": (28.5270, -81.5220),  # Gotha
    "34711": (28.5500, -81.7400),  # Clermont (outside 5 miles of every other campus area)
}
AREA = {"34787": "Winter Garden", "34786": "Windermere", "34761": "Ocoee", "34734": "Gotha", "34711": "Clermont"}
ZIP_WEIGHTS = [("34787", 36), ("34786", 18), ("34761", 22), ("34734", 7), ("34711", 17)]
RADIUS_MI = 5

# Campuses (ministry locations). The schema has no campus column: a campus shapes where services are held,
# which service a household attends, and where leaders live. See SYNTHETIC_DATA_REPORT.md (limitations).
CAMPUSES = {
    "WG": dict(name="Winter Garden", zip="34787", sundays=[("09:00", "sun_9", False), ("11:00", "sun_11", True)], wed=True),
    "OC": dict(name="Ocoee", zip="34761", sundays=[("09:30", "sun_9", False), ("11:15", "sun_11", False)], wed=False),
    "WM": dict(name="Windermere", zip="34786", sundays=[("10:00", "sun_9", False)], wed=False),
    "CL": dict(name="Clermont", zip="34711", sundays=[("09:30", "sun_9", False)], wed=False),
}
ONLINE_SERVICE = ("18:00", "sun_pm")           # the Online Gathering, livestreamed

SLOTS = ["sun_9", "sun_11", "sun_pm", "mon_eve", "tue_am", "tue_eve", "wed_am", "wed_eve", "thu_am", "thu_eve", "sat_am"]
SLOT_DAY = {"sun_9": 0, "sun_11": 0, "sun_pm": 0, "mon_eve": 1, "tue_am": 2, "tue_eve": 2, "wed_am": 3, "wed_eve": 3,
            "thu_am": 4, "thu_eve": 4, "sat_am": 6}
MORNING_SLOTS = ("tue_am", "wed_am", "thu_am")
MINISTRIES = [("Kids Ministry", "kids"), ("Worship Team", "worship"), ("Hospitality", "hospitality"),
              ("Student Ministry", "students"), ("Parking & Greeting", "hospitality"), ("Care Team", "care")]
INTERESTS = ["bible_reading", "prayer", "new_to_faith", "parenting", "marriage", "men", "women",
             "outdoors", "serving_together", "book_study", "recovery_friendly", "theology"]

# Household archetypes: key -> (weight, shape, primary adult age range, kids spec, life stage)
#   shape: solo | house | couple | multigen | retired | parents_adultchild
#   kids spec: (min count, max count, youngest-or-only age min, age max) or None; stage None = derived from kids/age
ARCHETYPES = {
    "single_adult":          (21, "solo",               (19, 46), None,           "single"),
    "housemates":            (6,  "house",              (20, 33), None,           "single"),
    "couple_no_kids":        (6,  "couple",             (24, 37), None,           "married_no_kids"),
    "couple_young_kids":     (11, "couple",             (26, 40), (1, 3, 0, 4),   "young_kids"),
    "couple_school_age":     (10, "couple",             (32, 47), (1, 3, 5, 12),  "school_age_kids"),
    "couple_teens":          (6,  "couple",             (40, 54), (1, 3, 13, 18), "teens"),
    "single_parent":         (6,  "solo",               (27, 48), (1, 3, 0, 17),  None),
    "multigenerational":     (2,  "multigen",           (34, 50), (1, 3, 2, 16),  None),
    "empty_nest":            (8,  "couple",             (50, 64), None,           "empty_nest"),
    "retired":               (11, "retired",            (63, 86), None,           "retired"),
    "young_adult_w_parents": (5,  "parents_adultchild", (48, 60), None,           "empty_nest"),
}
# Church tenure bands (months since first attended): name, min, max, weight (design 4.3)
TENURE_BANDS = [("first_time", 0.1, 1, 3), ("recent_visitor", 1, 3, 5), ("recent_attendee", 3, 6, 7),
                ("under_1y", 6, 12, 10), ("one_to_three_y", 12, 36, 23), ("established", 36, 120, 32), ("long", 120, 300, 20)]
# Attendance patterns (design 5.2): name, weight
PATTERNS = [("weekly", 24), ("twice_monthly", 17), ("monthly", 13), ("seasonal", 7), ("rising", 5), ("declining", 6),
            ("online_first", 7), ("mixed_online", 9), ("concentrated_wed", 4), ("interrupted", 6), ("sparse", 8),
            ("returning", 5)]
CONSISTENT_PATTERNS = ("weekly", "twice_monthly")

NAMES_M = ("James John Michael David Chris Daniel Matt Josh Andrew Ryan Brandon Tyler Kevin Jason Eric Luis Carlos Jordan Nathan Aaron Caleb "
           "Isaac Ethan Owen Derek Sam Victor Andre Paul Greg Mark Steve Adam Ben Cole Dean Evan Frank Gavin Henry Ian Jack Kyle Leo Marcus "
           "Nick Oscar Patrick Quinn Ross Scott Trent Wes Zach Brett Jonah Gabe Miles").split()
NAMES_F = ("Mary Sarah Jessica Emily Ashley Amanda Rachel Megan Lauren Hannah Grace Olivia Sofia Maria Elena Natalie Rebecca Leah Abby Chloe "
           "Kayla Brianna Jasmine Tara Joy Lydia Naomi Esther Hope Claire Anna Beth Carla Diana Erin Faith Gina Holly Iris Jenna Kim Laura "
           "Mia Nina Paige Rose Sara Tessa Vera Wendy Yvonne Zoe Alicia Bree Dawn Fiona Julia").split()
NAMES_KID = "Noah Liam Ava Mia Eli Lucy Levi Zoe Asher Nora Jude Ivy Micah Ruby Silas June Theo Ada Finn Cora Ezra Wren".split()
LASTS = ("Bennett Carter Diaz Ellis Foster Garcia Hayes Jensen Kim Lopez Mendez Nguyen Ortiz Patel Reyes Brooks Sullivan Torres Walsh Young "
         "Coleman Bishop Dunn Fields Grant Hart Lane Moss Price Rowe Adams Baker Chen Davis Evans Flores Green Hill Ibarra James Knight Lewis "
         "Morgan Nash Owens Perry Quinn Ramos Stone Turner Underwood Vargas Wells Xiong Yates Zimmer Alvarez Boyd Cruz Dixon Ford Gibson "
         "Holt Irwin Jacobs Keller Lowe Marsh Norris Olsen Pierce Rhodes Shaw Tate Vance Weaver").split()

# People whose ids already existed in generator v0.2 (named journeys, evaluation members, journey-group leaders,
# the toddler-mom cohort). Recorded verbatim so their UUIDs never change: [first, last, gender, birth_year, role, seq].
LEGACY_PEOPLE = {
    "eval_e01": [["Lydia","Carter","F",2006,"adult",0]],
    "eval_e02": [["Abby","Price","F",2001,"adult",0]],
    "eval_e03": [["Jessica","Moss","F",1966,"adult",0],["Tyler","Moss","M",1967,"adult",0]],
    "eval_e04": [["Kevin","Coleman","M",1997,"adult",0]],
    "eval_e05": [["Maria","Ellis","F",1998,"adult",0]],
    "eval_e06": [["John","Lopez","M",1989,"adult",0],["Mary","Lopez","F",1986,"adult",0],["Silas","Lopez","M",2022,"child",0],["Silas","Lopez","F",2025,"child",1]],
    "eval_e07": [["Andrew","Foster","M",1969,"adult",0],["Jasmine","Foster","F",1971,"adult",0]],
    "eval_e08": [["Kevin","Mendez","M",1987,"adult",0],["Brianna","Mendez","F",1985,"adult",0],["Liam","Mendez","F",2017,"child",0],["Eli","Mendez","F",2020,"child",1]],
    "eval_e09": [["Tyler","Mendez","M",1995,"adult",0],["Chloe","Mendez","F",1995,"adult",0],["Liam","Mendez","M",2026,"child",0],["Micah","Mendez","M",2026,"child",1]],
    "eval_e10": [["Ethan","Garcia","M",1993,"adult",0],["Megan","Garcia","F",1989,"adult",0],["Liam","Garcia","M",2016,"child",0],["Ivy","Garcia","F",2021,"child",1]],
    "eval_e11": [["Andrew","Patel","M",1996,"adult",0],["Chloe","Patel","F",1996,"adult",0],["Silas","Patel","F",2026,"child",0],["Ivy","Patel","F",2022,"child",1]],
    "eval_e12": [["Natalie","Torres","F",1997,"adult",0],["Andre","Torres","M",1994,"adult",0]],
    "leader_newfaith": [["Kayla","Garcia","F",1971,"adult",0],["Owen","Garcia","M",1967,"adult",0]],
    "leader_sunpm": [["Jason","Foster","M",1991,"adult",0],["Tara","Foster","F",1991,"adult",0],["Silas","Foster","M",2020,"child",0]],
    "leader_singles": [["Paul","Mendez","M",1994,"adult",0]],
    "leader_deeproots": [["Maria","Mendez","F",2002,"adult",0],["Caleb","Mendez","M",2002,"adult",0]],
    "leader_wordwomen": [["Brianna","Reyes","F",1994,"adult",0]],
    "leader_prayer": [["Josh","Moss","M",1963,"adult",0],["Maria","Moss","F",1965,"adult",0]],
    "leader_accountability": [["Andre","Grant","M",1988,"adult",0],["Lucy","Grant","M",2018,"child",0]],
    "leader_iron": [["Andre","Lane","M",1962,"adult",0],["Tara","Lane","F",1965,"adult",0]],
    "leader_supper": [["Tyler","Diaz","M",1990,"adult",0],["Natalie","Diaz","F",1992,"adult",0],["Asher","Diaz","M",2023,"child",0],["Eli","Diaz","M",2023,"child",1],["Jude","Diaz","M",2026,"child",2]],
    "leader_clermont_moms": [["Abby","Ortiz","F",1994,"adult",0],["John","Ortiz","M",1995,"adult",0],["Lucy","Ortiz","F",2023,"child",0]],
    "persona_tmom0": [["Lydia","Walsh","F",1993,"adult",0],["Brandon","Walsh","M",1994,"adult",0],["Ivy","Walsh","M",2026,"child",0],["Micah","Walsh","M",2024,"child",1]],
    "persona_tmom1": [["Jasmine","Grant","F",1999,"adult",0],["Daniel","Grant","M",2000,"adult",0],["Nora","Grant","F",2025,"child",0],["Ruby","Grant","F",2024,"child",1]],
    "persona_tmom2": [["Lauren","Fields","F",1995,"adult",0],["Caleb","Fields","M",1996,"adult",0],["Zoe","Fields","M",2025,"child",0],["Asher","Fields","M",2022,"child",1]],
    "persona_tmom3": [["Rachel","Brooks","F",1997,"adult",0],["Michael","Brooks","M",1998,"adult",0],["Eli","Brooks","F",2024,"child",0],["Zoe","Brooks","M",2024,"child",1]],
    "persona_tmom4": [["Abby","Garcia","F",1999,"adult",0],["Chris","Garcia","M",2000,"adult",0],["Zoe","Garcia","M",2026,"child",0],["Eli","Garcia","M",2023,"child",1]],
}

# Shared description fragments for group-family templates
CULTURE = ["Relaxed and conversational; people bring snacks.", "Structured: prayer, discussion, then a short application time.",
           "A warm, laid-back crowd that values honesty over polish.", "Quiet and thoughtful; we leave room for silence.",
           "High energy and plenty of laughter.", "We keep the format simple and consistent so newcomers can slip in.",
           "Everyone is invited to speak up, and no one is put on the spot.", "Teaching first, then questions.",
           "Hosted around a big table with an open door.", "Casual, coffee-shop feel with no dress code."]
PREP = {"none": "No homework or experience needed.", "light": "About fifteen minutes of reading before we meet.",
        "moderate": "Expect a chapter of reading and a few discussion questions each week.",
        "heavy": "Serious weekly preparation: several hours of reading and written notes."}
# Who the group assumes it is talking to (V2 semantic differentiation). Descriptive text only: never scored.
DEPTH_TEXT = {"intro": "No prior Bible knowledge is assumed, and basic questions are welcome.",
              "steady": "Some familiarity with the Bible helps, but you do not need to be an expert.",
              "deep": "Members come prepared and are comfortable discussing Scripture in depth.",
              "intensive": "This is an advanced study for people with years of experience reading Scripture and theology."}

# Group families: count (target total including legacy/designed), gender weights, stage weights, slot weights, tags,
# capacity range, childcare probability, depth/prep, names, and emphasis sentences (text, extra tags).
FAMILIES = {
 "foundational": dict(count=9, gender=[("mixed", 70), ("women", 15), ("men", 15)], stage=[("single", 35), ("married_no_kids", 20), ("young_kids", 20), ("school_age_kids", 15), ("empty_nest", 10)],
    slot=[("tue_eve", 15), ("wed_eve", 25), ("thu_eve", 25), ("sun_pm", 15), ("mon_eve", 10), ("sat_am", 10)], tags=["new_to_faith", "bible_reading"], cap=(8, 16), childcare=0.25, depth="intro", prep="none",
    names=["Starting Point", "Open Door", "Fresh Start Table", "Back to the Beginning", "Questions Welcome", "New Here Bible Night", "First Chapter", "Coffee & Questions"],
    emph=[("A slow walk through the Gospel of Luke for people who are new to faith or coming back to it.", ["prayer"]),
          ("A gentle introduction to the Bible: what it is, how to read it, and what to do with your questions.", []),
          ("An open table for seekers and recent believers where no question is too basic.", ["prayer"])]),
 "young_adult": dict(count=12, gender=[("mixed", 80), ("women", 10), ("men", 10)], stage=[("single", 100)],
    slot=[("tue_eve", 18), ("wed_eve", 22), ("thu_eve", 25), ("mon_eve", 10), ("sun_pm", 15), ("sat_am", 10)], tags=["bible_reading"], cap=(8, 16), childcare=0.0, depth="steady", prep="light",
    names=["Twenty-Somethings Dinner", "Young Professionals Group", "Post-College Fellowship", "City Lights", "The Common Table", "Rooftop Group", "Young Adults Midweek", "Sunday Night Singles", "Late Night Table", "Friends & Faith"],
    emph=[("Dinner, a book of the Bible, and real friendship for singles in their twenties and early thirties.", ["outdoors"]),
          ("Young adults figuring out work, faith and community together, with a loose reading plan.", ["book_study"]),
          ("A mix of Scripture, honest conversation and the occasional beach or trail day.", ["outdoors"])]),
 "mens": dict(count=13, gender=[("men", 100)], stage=[("young_kids", 30), ("school_age_kids", 30), ("teens", 15), ("empty_nest", 15), ("married_no_kids", 10)],
    slot=[("tue_eve", 25), ("wed_eve", 15), ("thu_eve", 18), ("sun_pm", 17), ("mon_eve", 10), ("sat_am", 15)], tags=["men", "bible_reading"], cap=(6, 10), childcare=0.0, depth="deep", prep="moderate",
    names=["Iron & Coffee", "Band of Brothers", "Wednesday Men's Table", "Men at the Fire", "Early Riser Men", "Dads Who Pray", "Brothers in Christ", "Monday Night Men", "Cornerstone Men"],
    emph=[("Men who want real accountability: a short passage, then most of the night on honest check-ins and prayer.", ["prayer"]),
          ("Working through Proverbs together, with a focus on being a steady husband and father.", ["parenting"]),
          ("A men's discipleship group going verse by verse through a New Testament letter.", ["book_study"])]),
 "womens": dict(count=13, gender=[("women", 100)], stage=[("single", 20), ("married_no_kids", 15), ("young_kids", 20), ("school_age_kids", 25), ("teens", 10), ("empty_nest", 10)],
    slot=[("tue_eve", 18), ("wed_eve", 22), ("thu_eve", 25), ("sun_pm", 10), ("mon_eve", 10), ("sat_am", 15)], tags=["women", "bible_reading"], cap=(6, 12), childcare=0.1, depth="steady", prep="light",
    names=["Women at the Well", "Sisters in Scripture", "Wednesday Women", "Grace & Grit", "Hearts Open", "Lilies of the Field", "Ruth & Naomi Circle", "Women of Prayer", "The Well Table", "Thursday Sisters"],
    emph=[("Women reading Scripture and praying for one another, with a reading plan and room for questions.", ["prayer"]),
          ("A women's discipleship group working through a book of the Bible at a steady pace.", ["book_study"]),
          ("Women across seasons of life who want friendship that goes beyond Sunday.", ["prayer"])]),
 "couples": dict(count=9, gender=[("couples", 100)], stage=[("married_no_kids", 40), ("young_kids", 25), ("school_age_kids", 20), ("empty_nest", 15)],
    slot=[("mon_eve", 20), ("tue_eve", 18), ("thu_eve", 20), ("sun_pm", 25), ("sat_am", 7), ("wed_eve", 10)], tags=["marriage"], cap=(8, 16), childcare=0.2, depth="steady", prep="light",
    names=["Marriage Matters", "Couples Connect", "Date Night Study", "Newlywed Group", "Marriage on Mission", "Hand in Hand", "Together at the Table", "Covenant Couples"],
    emph=[("Married couples working through a marriage study, with dinner and honest conversation.", []),
          ("Couples at every stage who want to build a faith-centered marriage and learn from one another.", ["prayer"])]),
 "young_family": dict(count=10, gender=[("couples", 50), ("mixed", 50)], stage=[("young_kids", 80), ("school_age_kids", 20)],
    slot=[("sun_pm", 30), ("tue_eve", 20), ("thu_eve", 18), ("wed_eve", 18), ("sat_am", 14)], tags=["parenting", "marriage"], cap=(8, 16), childcare=0.4, depth="intro", prep="none",
    names=["Playdate Prayer", "Messy Table Families", "Family Dinner Group", "Toddler Parents Circle", "Raising Disciples", "Kids in Tow", "Porch Light Families", "Little Ones, Big Faith"],
    emph=[("Young families sharing a meal while the kids play, then parents talk through the sermon and pray.", []),
          ("Parents of babies, toddlers and preschoolers swapping encouragement and practical ideas.", ["prayer"])]),
 "parenting": dict(count=6, gender=[("mixed", 100)], stage=[("teens", 50), ("school_age_kids", 50)],
    slot=[("thu_eve", 30), ("tue_eve", 25), ("wed_eve", 25), ("sun_pm", 20)], tags=["parenting", "book_study"], cap=(10, 20), childcare=0.0, depth="steady", prep="light",
    names=["Parenting Teens Together", "Raising Boys", "Raising Girls", "Fearless Parenting", "Wise Parents Workshop"],
    emph=[("A book-study group for parents of teenagers: honest conversation and practical tools.", []),
          ("Parents of school-age kids learning from Scripture and from each other.", ["prayer"])]),
 "empty_nest": dict(count=5, gender=[("mixed", 80), ("couples", 20)], stage=[("empty_nest", 100)],
    slot=[("sat_am", 30), ("wed_eve", 25), ("tue_eve", 20), ("sun_pm", 25)], tags=["serving_together", "prayer"], cap=(8, 16), childcare=0.0, depth="steady", prep="light",
    names=["Season of Change", "Empty Nest Evenings", "Next Chapter", "Second Wind"],
    emph=[("Empty nesters and recent retirees: a Psalm, good food, and a serving project each quarter.", []),
          ("Couples and singles whose kids have launched, finding purpose in this new season.", ["bible_reading"])]),
 "mature_adult": dict(count=5, gender=[("mixed", 80), ("women", 10), ("men", 10)], stage=[("retired", 70), ("empty_nest", 30)],
    slot=[("sat_am", 25), ("sun_pm", 20), ("wed_eve", 20), ("tue_am", 15), ("wed_am", 10), ("thu_am", 10)], tags=["bible_reading", "prayer"], cap=(12, 25), childcare=0.0, depth="steady", prep="light",
    names=["Silver Saints", "Seasoned Saints Bible Hour", "Wisdom Circle", "Golden Hour", "Lifetime Learners"],
    emph=[("A Bible class for adults in their sixties and beyond: unhurried, with large print and good coffee.", []),
          ("Retired friends studying Scripture and sharing life stories, with lunch afterwards.", ["serving_together"])]),
 "prayer": dict(count=6, gender=[("mixed", 80), ("women", 10), ("men", 10)], stage=[("empty_nest", 30), ("school_age_kids", 25), ("single", 20), ("retired", 25)],
    slot=[("wed_eve", 30), ("tue_eve", 20), ("sat_am", 20), ("thu_eve", 15), ("sun_pm", 15)], tags=["prayer"], cap=(8, 20), childcare=0.0, depth="intro", prep="none",
    names=["Prayer Circle", "Wednesday Intercessors", "Prayer Walk Group", "Worship & Prayer Night", "Quiet Prayer Hour"],
    emph=[("An hour of worship and prayer for our church and city. Little discussion, lots of prayer.", []),
          ("We pray through the week's requests, then walk the neighborhood together.", ["outdoors"])]),
 "bible_study": dict(count=12, gender=[("mixed", 85), ("women", 8), ("men", 7)], stage=[("single", 20), ("married_no_kids", 15), ("young_kids", 15), ("school_age_kids", 20), ("teens", 10), ("empty_nest", 20)],
    slot=[("tue_eve", 20), ("wed_eve", 22), ("thu_eve", 22), ("sun_pm", 14), ("mon_eve", 10), ("sat_am", 12)], tags=["bible_reading", "book_study"], cap=(10, 25), childcare=0.15, depth="steady", prep="moderate",
    names=["Gospel of Luke Study", "Psalms Together", "Proverbs for Life", "Acts: The Early Church", "Sermon on the Mount", "Romans Road", "Genesis Deep Dive", "Book of James", "Philippians Study", "Daniel Study", "Hebrews Study", "Mark in Motion"],
    emph=[("Verse-by-verse study with discussion questions and a short application each week.", []),
          ("We read a passage aloud, discuss what it meant then and now, and pray.", ["prayer"])]),
 "theology": dict(count=5, gender=[("mixed", 80), ("women", 10), ("men", 10)], stage=[("empty_nest", 30), ("single", 20), ("school_age_kids", 25), ("married_no_kids", 25)],
    slot=[("tue_eve", 30), ("thu_eve", 30), ("wed_eve", 25), ("mon_eve", 15)], tags=["theology", "book_study"], cap=(8, 16), childcare=0.0, depth="intensive", prep="heavy",
    names=["Systematic Theology Seminar", "Church History Reading Group", "Doctrine & Dialogue"],
    emph=[("Readings in systematic theology with weekly discussion; best for those who have studied the Bible for years.", []),
          ("A reading group working through the church fathers and the Reformers.", [])]),
 "recovery": dict(count=5, gender=[("mixed", 70), ("men", 15), ("women", 15)], stage=[("single", 30), ("school_age_kids", 25), ("empty_nest", 25), ("married_no_kids", 20)],
    slot=[("tue_eve", 30), ("thu_eve", 30), ("mon_eve", 20), ("wed_eve", 20)], tags=["recovery_friendly", "prayer"], cap=(6, 12), childcare=0.0, depth="steady", prep="none",
    names=["Steps to Freedom", "Grief & Hope Circle", "Anxiety & Peace Group", "Life After Loss", "Caregivers Circle"],
    emph=[("A confidential, supportive group for anyone working through a hard season, with Scripture and prayer.", []),
          ("Members listen more than they advise; what is shared stays in the room.", [])]),
 "serving": dict(count=5, gender=[("mixed", 90), ("women", 5), ("men", 5)], stage=[("single", 20), ("married_no_kids", 20), ("school_age_kids", 25), ("empty_nest", 25), ("retired", 10)],
    slot=[("sat_am", 40), ("tue_eve", 20), ("thu_eve", 20), ("sun_pm", 20)], tags=["serving_together"], cap=(8, 20), childcare=0.1, depth="intro", prep="none",
    names=["Serve Together Saturdays", "Hospitality Team Group", "Kids Ministry Volunteers Circle", "Neighborhood Outreach Group", "Care Team Circle"],
    emph=[("A group that serves together: one outreach project a month, with a short devotion and a meal.", ["prayer"]),
          ("We pair Scripture with hands-on service in the community.", [])]),
 "interest": dict(count=7, gender=[("mixed", 80), ("women", 10), ("men", 10)], stage=[("single", 25), ("married_no_kids", 20), ("school_age_kids", 20), ("empty_nest", 20), ("young_kids", 15)],
    slot=[("sat_am", 35), ("sun_pm", 25), ("thu_eve", 20), ("tue_eve", 20)], tags=["outdoors"], cap=(8, 20), childcare=0.1, depth="intro", prep="none",
    names=["Trail Walkers", "Book Club & Bible", "Board Games & Faith", "Cooking Together", "Running & Prayer", "Photography & Faith", "Gardening Group"],
    emph=[("Friendship built around a shared hobby, with a short reflection each time we meet.", []),
          ("A relaxed community group where the activity comes first and the conversation follows.", ["prayer"])]),
 "online": dict(count=6, gender=[("mixed", 100)], stage=[("single", 35), ("married_no_kids", 25), ("school_age_kids", 25), ("empty_nest", 15)],
    slot=[("tue_eve", 22), ("wed_eve", 25), ("thu_eve", 25), ("sun_pm", 28)], tags=["bible_reading", "book_study"], cap=(12, 25), childcare=0.0, depth="steady", prep="light",
    names=["Online Wednesday Bible", "Online Prayer Night", "Online Sunday Evening Group", "Online Parent Circle", "Online Study for Travelers"],
    emph=[("An online video study for people who travel, work shifts, or mostly join services by livestream. Cameras optional.", []),
          ("A video-call group with the same rhythm each week: check-in, Scripture, prayer.", ["prayer"])]),
 "hybrid": dict(count=5, gender=[("mixed", 100)], stage=[("single", 20), ("married_no_kids", 20), ("school_age_kids", 30), ("young_kids", 15), ("empty_nest", 15)],
    slot=[("tue_eve", 28), ("wed_eve", 25), ("thu_eve", 27), ("sun_pm", 20)], tags=["bible_reading"], cap=(10, 20), childcare=0.1, depth="steady", prep="light",
    names=["Hybrid Tuesday Study", "Hybrid Parents Group", "Hybrid Women's Study", "Hybrid Seekers Group", "Hybrid Men's Night"],
    emph=[("We meet in person at a home and open a video link for anyone who cannot make it that week.", []),
          ("Half the group is in the room and half is on screen; the leader keeps both sides in the conversation.", ["prayer"])]),
 "forming": dict(count=7, gender=[("mixed", 40), ("women", 20), ("men", 20), ("couples", 20)], stage=[("young_kids", 30), ("single", 25), ("school_age_kids", 25), ("empty_nest", 20)],
    slot=[("tue_eve", 25), ("wed_eve", 25), ("thu_eve", 30), ("sun_pm", 20)], tags=["bible_reading"], cap=(8, 12), childcare=0.2, depth="intro", prep="light",
    names=["New Group: Thursday Families", "New Group: Wednesday Study", "New Group: Young Couples Dinner", "New Group: Mature Adults", "New Group: Dads' Breakfast"],
    emph=[("A brand-new group launching this winter. Come help shape how we meet.", []),
          ("We are just getting started and looking for the first few members.", ["prayer"])]),
}

# ================================================================ 2. HELPERS
R = random.Random(SEED)

def rng_for(*key):                              # per-entity stream: named overlays never shift when the bulk changes
    return random.Random("|".join(["516"] + [str(k) for k in key]))

def uid(*parts):
    return str(uuid.uuid5(NS, "|".join(map(str, parts))))

def miles(a, b):
    (la1, lo1), (la2, lo2) = a, b
    p = math.pi / 180
    d = 0.5 - math.cos((la2 - la1) * p) / 2 + math.cos(la1 * p) * math.cos(la2 * p) * (1 - math.cos((lo2 - lo1) * p)) / 2
    return 7917.5 * math.asin(math.sqrt(d))

def jitter(z, r):
    la, lo = ZIPS[z]
    return round(la + r.uniform(-0.025, 0.025), 5), round(lo + r.uniform(-0.025, 0.025), 5)

def near(pt, max_mi, r):
    rad = max_mi / 69.0
    return round(pt[0] + r.uniform(-rad, rad) * 0.7, 5), round(pt[1] + r.uniform(-rad, rad) * 0.7, 5)

def point_at(pt, bearing_deg, mi):               # a point mi miles from pt along a bearing
    dlat = mi * math.cos(math.radians(bearing_deg)) / 69.0
    dlon = mi * math.sin(math.radians(bearing_deg)) / (69.0 * math.cos(math.radians(pt[0])))
    return round(pt[0] + dlat, 5), round(pt[1] + dlon, 5)

def nearest_zip(pt):
    return min(ZIPS, key=lambda z: miles(ZIPS[z], pt))

def campus_for(pt, r, stray=0.12):               # nearest campus, with some multi-campus attendance
    order = sorted(CAMPUSES, key=lambda c: miles(ZIPS[CAMPUSES[c]["zip"]], pt))
    return r.choice(order[1:3]) if r.random() < stray else order[0]

def weighted(r, pairs):
    return r.choices([p[0] for p in pairs], [p[-1] for p in pairs])[0]

def tenure_start(months):
    return TODAY - timedelta(days=int(months * 30.4))

def sunday(w):
    return TODAY - timedelta(weeks=w)

def to_arr(items):
    return "{" + ",".join(items) + "}"

T = {k: [] for k in ["household", "person", "member_profile", "portal_user", "service", "attendance_event",
                     "ministry", "serving_assignment", "grp", "group_tag", "group_leader", "group_membership",
                     "group_meeting", "meeting_attendance", "join_request", "escalation", "audit_log",
                     "eval_label", "_truth_household", "_truth_person", "_truth_group"]}
COLS = {  # empty tables still get headers
    "escalation": ["escalation_id", "source", "kind", "severity", "group_id", "person_id", "summary", "evidence", "status", "created_at", "resolved_by"],
    "audit_log": ["id", "actor_user_id", "action", "entity", "entity_id", "detail", "at"],
}

# ================================================================ 3. SERVICES (eight per week)
for name, area in MINISTRIES:
    T["ministry"].append(dict(ministry_id=uid("min", name), name=name, area=area))
MIN = {r["name"]: r["ministry_id"] for r in T["ministry"]}

SVC = {}                                        # (sunday-date iso, campus, slot) -> service row ; wed key uses campus WG slot wed_eve
def add_service(d, campus, label, start, slot, live):
    row = dict(service_id=uid("svc", d, campus, start), service_date=d.isoformat(), start_time=start + ":00",
               name=label, slot=slot, livestreamed=live)
    T["service"].append(row); SVC[(d.isoformat(), campus, slot)] = row

for w in range(WEEKS):
    sun = sunday(w)
    for c, cfg in CAMPUSES.items():
        for start, slot, live in cfg["sundays"]:
            add_service(sun, c, f"{cfg['name']} · Sunday {start.lstrip('0')}", start, slot, live)
    wed = sun - timedelta(days=4)
    add_service(wed, "WG", "Winter Garden · Wednesday Night", "19:00", "wed_eve", False)
    add_service(sun, "ON", f"Online Gathering · Sunday {ONLINE_SERVICE[0].lstrip('0')}", ONLINE_SERVICE[0], ONLINE_SERVICE[1], True)

# ================================================================ 4. POPULATION
people, households = {}, {}
adults = []
RESERVED = set()        # personas, spouses, evaluation members, leaders of named groups: never drawn at random
USED = set()            # anyone already placed as a group leader or member
PATTERN_FOR, FORCE = {}, {}

def add_household(key, z=None, loc=None, r=None, campus=None):
    r = r or R
    if loc:
        la, lo = loc; z = nearest_zip(loc)
    else:
        z = z or weighted(r, ZIP_WEIGHTS); la, lo = jitter(z, r)
    hh = dict(household_id=uid("hh", key), zip=z, lat_approx=la, lng_approx=lo, checkin_app_opt_in=False, app_opt_in_at="")
    T["household"].append(hh)
    households[hh["household_id"]] = dict(row=hh, adults=[], kids=[], campus=campus or campus_for((la, lo), r), key=key)
    return hh

def add_person(hh, first, last, gender, birth_year, role, first_attended, seq=0):
    pid = uid("person", hh["household_id"], first, birth_year, role, seq)
    row = dict(person_id=pid, household_id=hh["household_id"], first_name=first, last_name=last, gender=gender,
               birth_year=birth_year, household_role=role, first_attended_on=first_attended.isoformat(), is_synthetic=True)
    T["person"].append(row)
    people[pid] = dict(row, loc=(hh["lat_approx"], hh["lng_approx"]), kids=[], serves=[], stage=None,
                       tenure=(TODAY - first_attended).days / 30.4, participates=True, archetype=None)
    households[hh["household_id"]]["adults" if role == "adult" else "kids"].append(pid)
    if role == "adult":
        adults.append(pid)
    return pid

def kid_stage(ages):
    y = min(ages)
    return "young_kids" if y <= 4 else "school_age_kids" if y <= 12 else "teens"

def draw_tenure(r):
    b = r.choices(TENURE_BANDS, [t[3] for t in TENURE_BANDS])[0]
    return r.uniform(b[1], b[2]), b[0]

def finish_household(hid, stage_of, tenure, kid_ages, participates=None):
    """Sets stage, tenure and kids on every adult of a household."""
    for i, a in enumerate(households[hid]["adults"]):
        p = people[a]
        p["stage"] = stage_of[i] if isinstance(stage_of, (list, tuple)) else stage_of
        p["kids"] = list(kid_ages)
        if participates is not None:
            p["participates"] = participates[i]

def pick_names(r, gender):
    return r.choice(NAMES_M if gender == "M" else NAMES_F)

def build_household(key, arch, r, loc=None, z=None, tenure=None):
    """General-congregation household from an archetype. Returns the household id."""
    weight, shape, (alo, ahi), kspec, stage = ARCHETYPES[arch]
    hh = add_household(key, z=z, loc=loc, r=r)
    hid = hh["household_id"]
    last = r.choice(LASTS)
    tenure_m, _band = (tenure, None) if tenure is not None else draw_tenure(r)
    age = int(r.triangular(alo, ahi, 68)) if shape == "retired" else r.randint(alo, ahi)   # most retirees are in their late sixties and seventies
    g1 = r.choice(["M", "F"])
    spec = []                                    # (gender, age)
    if shape == "solo":
        spec = [(g1, age)]
    elif shape == "house":
        gs = [g1] + [g1 if r.random() < 0.7 else ("F" if g1 == "M" else "M")] + ([g1] if r.random() < 0.3 else [])
        spec = [(g, max(18, age + r.randint(-3, 4))) for g in gs]
    elif shape in ("couple", "retired", "multigen", "parents_adultchild"):
        couple = shape != "retired" or r.random() < 0.6
        spec = [(g1, age)] + ([("F" if g1 == "M" else "M", max(18, age + r.randint(-4, 3)))] if couple else [])
        if shape == "multigen":
            spec.append((r.choice(["M", "F"]), age + r.randint(24, 32)))
        if shape == "parents_adultchild":
            spec += [(r.choice(["M", "F"]), r.randint(19, 26)) for _ in range(r.choice([1, 1, 2]))]
    ids, ages = [], []
    for i, (g, a) in enumerate(spec):
        pid = add_person(hh, pick_names(r, g), last, g, TODAY.year - a, "adult", tenure_start(tenure_m + r.uniform(-1, 2) * (i > 0) if i else tenure_m), seq=i)
        ids.append(pid); ages.append(a)
    kid_ages = []
    if kspec:
        lo_n, hi_n, klo, khi = kspec
        n = r.randint(lo_n, hi_n)
        base = r.randint(klo, khi)
        kid_ages = sorted({max(0, min(17, base + r.randint(-1, 3) * j)) for j in range(n)} or {base})
        for j, ka in enumerate(kid_ages):
            add_person(hh, r.choice(NAMES_KID), last, r.choice(["M", "F"]), TODAY.year - ka, "child", tenure_start(tenure_m), seq=j)
    # stages and participation
    stages, part = [], []
    for i, a in enumerate(ages):
        st = stage or (kid_stage(kid_ages) if kid_ages else "single")
        if shape == "solo" and not kid_ages:
            st = "retired" if a >= 65 else "single"
        if shape == "house":
            st = "single"
        if shape == "multigen":
            st = "retired" if a >= 65 else kid_stage(kid_ages)
        if shape == "parents_adultchild":
            st = "single" if a < 30 else "empty_nest"
        if shape == "solo" and kid_ages:
            st = kid_stage(kid_ages)
        stages.append(st)
        if i == 0 or shape == "solo":
            part.append(True)
        elif shape == "parents_adultchild" and a < 30:
            part.append(r.random() > 0.45)
        elif shape == "house":
            part.append(r.random() > 0.25)
        else:
            part.append(r.random() > 0.12)       # mixed participation: a spouse who does not take part
    finish_household(hid, stages, tenure_m, kid_ages, part)
    return hid

# ---- named persona overlays (stable ids: same keys and name/age formulas as v0.2) ----
PERSONAS = {}
def persona(key, first, last, gender, age, stage, tenure_m, z, kids=(), role="member", loc=None, spouse=None, landing=True, pattern="weekly"):
    hh = add_household("persona_" + key, z=None if loc else z, loc=loc, r=rng_for("persona", key))
    pid = add_person(hh, first, last, gender, TODAY.year - age, "adult", tenure_start(tenure_m))
    people[pid].update(stage=stage); RESERVED.add(pid)
    if spouse:
        sp = add_person(hh, spouse[0], last, spouse[1], TODAY.year - age + 1, "adult", tenure_start(tenure_m))
        people[sp].update(stage=stage); RESERVED.add(sp)
    kr = rng_for("persona-kids", key)
    for i, ka in enumerate(kids):
        add_person(hh, kr.choice(NAMES_KID), last, kr.choice(["M", "F"]), TODAY.year - ka, "child", tenure_start(tenure_m), seq=i)
        for a in households[hh["household_id"]]["adults"]:
            people[a]["kids"].append(ka)
    PATTERN_FOR[hh["household_id"]] = pattern
    if landing:
        PERSONAS[key] = dict(person_id=pid, display=f"{first} {last}", role=role)
    return pid

WG = ZIPS["34787"]
DANA_LOC = (28.4625, -81.5300)                  # southern Windermere: edge of the church's footprint, so fewer groups are in reach
FS_LOC = (28.4688, -81.5386)                    # First Steps leader's home, about 0.7 mi from Dana
MARCUS_LOC0 = jitter("34787", rng_for("loc", "marcus"))      # Marcus and Tom live close together
TOM_LOC = point_at(MARCUS_LOC0, 200, 0.5)
alan   = persona("manager",      "Alan",   "Whitfield", "M", 51, "school_age_kids", 120, "34787", kids=(11, 14), role="manager", spouse=("Karen", "F"))
tom    = persona("leader_tom",   "Tom",    "Brennan",   "M", 36, "young_kids", 60, None, kids=(2, 4), role="leader", spouse=("Jill", "F"), loc=TOM_LOC)
grace  = persona("leader_grace", "Grace",  "Okafor",    "F", 44, "school_age_kids", 84, "34761", kids=(8, 10), role="leader", spouse=("Daniel", "M"))
chris  = persona("leader_chris", "Chris",  "Delgado",   "M", 34, "young_kids", 40, None, kids=(1, 4), role="leader", spouse=("Amy", "F"),
                 loc=near(WG, 1.0, rng_for("loc", "chris")))
marcus = persona("member_marcus", "Marcus", "Hale",     "M", 33, "young_kids", 14, None, kids=(1, 3), spouse=("Erin", "F"), loc=MARCUS_LOC0)
dana   = persona("member_dana",  "Dana",   "Ruiz",      "F", 29, "single", 1.5, None, loc=DANA_LOC)
ruth   = persona("member_ruth",  "Ruth",   "Abbott",    "F", 61, "empty_nest", 110, "34787", spouse=("Walter", "M"))
priya  = persona("member_priya", "Priya",  "Shah",      "F", 31, "young_kids", 8, "34761", kids=(1, 3), spouse=("Dev", "M"), pattern="mixed_online")
jordan = persona("member_jordan", "Jordan", "Pike",     "M", 30, "young_kids", 1, None, kids=(1, 3), spouse=("Kate", "F"),
                 loc=near(people[chris]["loc"], 1.2, rng_for("loc", "jordan")), pattern="mixed_online")
sam    = persona("sam", "Sam", "Whitaker", "M", 32, "young_kids", 6, None, kids=(0, 2), spouse=("Lena", "F"),
                 loc=near(people[chris]["loc"], 1.2, rng_for("loc", "sam")), landing=False)
MARCUS_LOC = people[marcus]["loc"]
HH_OF = lambda pid: households[people[pid]["household_id"]]
FORCE[HH_OF(dana)["row"]["household_id"]] = ("in_person", True, False)
FORCE[HH_OF(ruth)["row"]["household_id"]] = ("in_person", True, False)
FORCE[HH_OF(marcus)["row"]["household_id"]] = ("in_person", False, True)
FORCE[HH_OF(jordan)["row"]["household_id"]] = ("hybrid", False, True)
FORCE[HH_OF(priya)["row"]["household_id"]] = ("hybrid", True, True)
people[marcus]["home_service"] = "sun_11"; HH_OF(marcus)["campus"] = "WG"

def legacy_household(key, loc, tenure_m, stage, campus=None, pattern=None, r=None):
    """A household whose people (and so ids) are recorded in LEGACY_PEOPLE."""
    r = r or rng_for("legacy", key)
    hh = add_household(key, loc=loc, r=r, campus=campus)
    ids, kid_ages = [], []
    for first, last, gender, by, role, seq in LEGACY_PEOPLE[key]:
        pid = add_person(hh, first, last, gender, by, role, tenure_start(tenure_m), seq=seq)
        if role == "adult":
            ids.append(pid); RESERVED.add(pid)
        else:
            kid_ages.append(TODAY.year - by)
    finish_household(hh["household_id"], stage, tenure_m, kid_ages)
    if pattern:
        PATTERN_FOR[hh["household_id"]] = pattern
    return ids[0]

# Priya's cohort: toddler moms with no weekday-morning group within 5 miles (escalation #3)
TODDLER_MOMS = [priya]
for i, z in enumerate(["34787", "34787", "34761", "34786", "34787"]):
    lr = rng_for("loc", "tmom", i)
    TODDLER_MOMS.append(legacy_household(f"persona_tmom{i}", jitter(z, lr), 3 + 5 * i, "young_kids", pattern="weekly"))
COHORT_ZERO = set(TODDLER_MOMS)
for _c in COHORT_ZERO:
    people[_c]["archetype"] = "unmet_demand_cohort"
MOM_SLOTS = [["thu_am", "tue_am"], ["tue_am", "thu_am"], ["tue_am", "wed_am"], ["wed_am", "thu_am"], ["tue_am", "wed_am"], ["wed_am", "thu_am"]]

# ---- general congregation ----
ARCH_KEYS = list(ARCHETYPES)
ARCH_W = [ARCHETYPES[a][0] for a in ARCH_KEYS]
i = 0
while len(adults) < SCALE["adult_population"]:
    arch = R.choices(ARCH_KEYS, ARCH_W)[0]
    hid = build_household(f"gen{i}", arch, R)
    households[hid]["arch"] = arch
    i += 1
for a in adults:
    households[people[a]["household_id"]].setdefault("arch", "named")

# ---- household patterns (attendance), assigned once per household from a per-household stream ----
def assign_pattern(hid):
    h = households[hid]
    if "pattern" in h: return
    h["tenure"] = max((people[a]["tenure"] for a in h["adults"]), default=0)
    if hid in PATTERN_FOR:
        h["pattern"] = PATTERN_FOR[hid]; return
    pr_ = rng_for("pattern", hid); ten = h["tenure"]
    if ten < 1:
        h["pattern"] = pr_.choices(["new_visit", "none"], [60, 40])[0]
    elif ten < 3:
        h["pattern"] = pr_.choices(["weekly", "twice_monthly", "sparse", "monthly", "none"], [35, 25, 15, 15, 10])[0]
    else:
        pats = [(n, w) for n, w in PATTERNS if not (n == "returning" and ten < 18)]
        h["pattern"] = pr_.choices([n for n, _ in pats], [w for _, w in pats])[0]
for hid in list(households):
    assign_pattern(hid)
for _p in (tom, ruth, alan):                     # serving slots (Wednesday night, Sunday) are held at Winter Garden
    households[people[_p]["household_id"]]["campus"] = "WG"

# ================================================================ 5. SERVING
def serve(pid, ministry, role, slot, freq="weekly", months=12):
    T["serving_assignment"].append(dict(person_id=pid, ministry_id=MIN[ministry], role=role, schedule_slot=slot,
                                        frequency=freq, start_on=tenure_start(months).isoformat(), end_on=""))
    people[pid]["serves"].append((ministry, slot, freq))

serve(marcus, "Kids Ministry", "Preschool room", "sun_11", "weekly", 10)        # the hidden conflict (WG sun_11)
serve(tom, "Kids Ministry", "Check-in", "sun_9", "biweekly", 30)
serve(grace, "Hospitality", "Coffee team lead", "sun_9", "weekly", 48)
serve(ruth, "Care Team", "Meals coordinator", "wed_eve", "monthly", 72)
serve(ruth, "Hospitality", "Greeter", "sun_9", "biweekly", 96)
def campus_slots(c):
    return [s for _, s, _ in CAMPUSES[c]["sundays"]] + (["wed_eve"] if CAMPUSES[c]["wed"] else [])
sr = rng_for("serving")
volunteers = [a for a in adults if a not in RESERVED and people[a]["participates"]
              and households[people[a]["household_id"]]["pattern"] in CONSISTENT_PATTERNS + ("monthly",)]
for pid in sorted(sr.sample(volunteers, int(SCALE["serving_rate"] * len(volunteers) / 0.4))):
    c = households[people[pid]["household_id"]]["campus"]
    m, _ = sr.choice(MINISTRIES)
    serve(pid, m, "Volunteer", sr.choice(campus_slots(c)), sr.choice(["weekly", "biweekly", "monthly"]), sr.randint(2, 60))

# ================================================================ 6. GROUPS
GROUPS = {}
FAMILY_OF = {}
def free_adult_pool(gender=None, stages=None, campus=None, min_tenure=0, need_consistent=False, near_pt=None, within=None):
    out = []
    for a in adults:
        if a in USED or a in RESERVED: continue
        p = people[a]
        if not p["participates"]: continue
        if gender and p["gender"] != gender: continue
        if stages and p["stage"] not in stages: continue
        h = households[p["household_id"]]
        if campus and h["campus"] != campus: continue
        if p["tenure"] < min_tenure: continue
        if need_consistent and h["pattern"] not in CONSISTENT_PATTERNS: continue
        if near_pt and miles(p["loc"], near_pt) > within: continue
        out.append(a)
    return out

def pick_leader(r, gender, stages, campus):
    """A consistent, established adult hosting at home. Relaxes constraints in a fixed order."""
    for kw in (dict(stages=stages, campus=campus, min_tenure=24, need_consistent=True),
               dict(stages=None, campus=campus, min_tenure=24, need_consistent=True),
               dict(stages=None, campus=campus, min_tenure=12),
               dict(stages=None, campus=None, min_tenure=12)):
        pool = free_adult_pool(gender=gender, **kw)
        if pool:
            a = r.choice(pool); USED.add(a); RESERVED.add(a); return a
    raise SystemExit("no leader candidate for " + str((gender, stages, campus)))

def group(key, family, name, desc, gender, stage, slot, leader, cap_max=8, status="open", childcare=False, tags=(),
          online=False, freq="weekly", cap_min=3, depth="steady", prep="light", plan="healthy", fmt=None, loc=None, started_weeks=None):
    gid = uid("grp", key)
    lp = people[leader]
    la, lo = loc or lp["loc"]
    g = dict(group_id=gid, name=name, description=desc, gender_focus=gender, life_stage_focus=stage or "", meeting_slot=slot,
             frequency=freq, lat_approx=la, lng_approx=lo, is_online=online, capacity_min=cap_min, capacity_max=cap_max,
             childcare=childcare, status=status)
    T["grp"].append(g)
    T["group_leader"].append(dict(group_id=gid, person_id=leader, role="leader", start_on=tenure_start(10 + len(GROUPS) % 30).isoformat()))
    for t in tags:
        T["group_tag"].append(dict(group_id=gid, tag=t))
    c = households[lp["household_id"]]["campus"]
    GROUPS[key] = dict(g, key=key, leader=leader, family=family, campus=c, fmt=fmt or ("online" if online else "in_person"),
                       depth=depth, prep=prep, plan=plan, started_weeks=started_weeks, _row=g)
    FAMILY_OF[key] = family
    RESERVED.add(leader); USED.add(leader)
    return gid

def lg(key, loc, tenure, stage, campus=None, pattern="weekly"):         # leader from LEGACY_PEOPLE
    return legacy_household(key, loc, tenure, stage, campus=campus, pattern=pattern)

# ---- legacy named groups (same keys, so same group UUIDs). Descriptions kept; geography re-anchored. ----
fs_leader = lg("leader_newfaith", FS_LOC, 90, "empty_nest", "WM")
group("tom", "mens", "Tuesday Night Dads", "Dads of little ones walking through the Gospel of Mark. We keep it simple: read, pray, and actually check in on each other.",
      "men", "young_kids", "tue_eve", tom, tags=("parenting", "men", "bible_reading"), depth="steady", prep="light")
group("sunpm", "mens", "Sunday Lunch D-Group", "We meet right after second service over lunch at the Carters' house. Men's discipleship group, Romans this fall.",
      "men", "young_kids", "sun_pm", lg("leader_sunpm", near(MARCUS_LOC, 2.5, rng_for("loc", "sunpm")), 70, "school_age_kids", "WG"),
      tags=("men", "bible_reading", "theology"), depth="deep", prep="moderate")
group("grace", "womens", "Women of the Word", "Moms in the middle years reading through Philippians. Kids are welcome in the next room on the first Thursday.",
      "women", "school_age_kids", "thu_eve", grace, tags=("women", "bible_reading", "parenting"))
group("newfaith", "foundational", "First Steps", "A slow walk through the Gospel of John for people who are new to faith or coming back to it. Questions are welcome. No homework, no experience needed, and no one is put on the spot.",
      "mixed", "single", "wed_eve", fs_leader, tags=("new_to_faith", "bible_reading", "prayer"), depth="intro", prep="none")
group("couples", "couples", "Young Couples", "Married couples without kids yet, or with one on the way. Monday dinners and a marriage study.",
      "couples", "married_no_kids", "mon_eve", pick_leader(rng_for("leader", "couples"), "M", ("married_no_kids",), "WG"), tags=("marriage",))
group("emptynest", "empty_nest", "Second Half", "Empty nesters and recent retirees. Saturday breakfast, Psalms, and a serving project each quarter.",
      "mixed", "empty_nest", "sat_am", pick_leader(rng_for("leader", "emptynest"), "M", ("empty_nest", "retired"), "WG"), tags=("serving_together", "prayer"))
group("men_sat", "mens", "Saturday Men's Breakfast", "Men of every season. Breakfast, a chapter of Proverbs, and accountability.",
      "men", "school_age_kids", "sat_am", pick_leader(rng_for("leader", "men_sat"), "M", ("school_age_kids", "teens"), "WG"), status="full", tags=("men", "bible_reading"))
group("teens", "parenting", "Parents of Teens", "Honest conversation for parents navigating the teenage years, using a book study.",
      "mixed", "teens", "thu_eve", pick_leader(rng_for("leader", "teens"), "F", ("teens",), "WG"), status="full", tags=("parenting", "book_study"))
group("singles", "young_adult", "Thursday Twenties", "Singles in their twenties and early thirties. Dinner, a book of the Bible, and real friendship.",
      "mixed", "single", "thu_eve", lg("leader_singles", near(FS_LOC, 2.5, rng_for("loc", "singles")), 30, "single", "WM"),
      tags=("bible_reading", "outdoors"))
group("clermont", "womens", "Lakeside Women", "Women's D-Group meeting near the lakes in Clermont. Reading plan plus prayer.",
      "women", "school_age_kids", "tue_eve", pick_leader(rng_for("leader", "clermont"), "F", ("school_age_kids", "teens"), "CL"), tags=("women", "prayer", "bible_reading"))
group("forming_m", "forming", "New Men's D-Group (forming)", "A new men's discipleship group launching this winter for dads of young kids. Bible-reading plan and weekly check-ins.",
      "men", "young_kids", "thu_eve", chris, status="forming", tags=("men", "bible_reading", "parenting"), cap_max=8)
group("forming_w", "forming", "New Women's D-Group (forming)", "A new women's discipleship group. Reading through 1 John together.",
      "women", "single", "tue_eve", pick_leader(rng_for("leader", "forming_w"), "F", ("single", "married_no_kids"), "WM"), status="forming", tags=("women", "bible_reading", "new_to_faith"))
group("deeproots", "theology", "Deep Roots", "Women working chapter by chapter through a systematic theology text. Weekly reading and discussion questions; best for those who have studied the Bible for years.",
      "women", "single", "wed_eve", lg("leader_deeproots", near(FS_LOC, 1.5, rng_for("loc", "deeproots")), 100, "married_no_kids", "WM"),
      tags=("women", "theology", "book_study"), depth="intensive", prep="heavy")
group("wordwomen", "womens", "Thursday Women in the Word", "Young professional women reading one book of the Bible each month at a brisk pace, with memory-verse goals.",
      "women", "single", "thu_eve", lg("leader_wordwomen", point_at(DANA_LOC, 60, 3.0), 50, "single", "WG", pattern="weekly"),
      tags=("women", "bible_reading"), depth="deep", prep="moderate")
group("prayer", "prayer", "Midweek Prayer & Worship", "An hour of worship and prayer for our church and city. Little discussion, lots of prayer.",
      "mixed", "empty_nest", "wed_eve", lg("leader_prayer", near(FS_LOC, 1.5, rng_for("loc", "prayer")), 130, "empty_nest", "WM"), tags=("prayer",), depth="intro", prep="none")
group("accountability", "mens", "Tuesday Men's Accountability", "Men who want hard questions and real accountability. A short passage, then most of the night on confession and prayer.",
      "men", None, "tue_eve", lg("leader_accountability", near(MARCUS_LOC, 1.5, rng_for("loc", "acct")), 80, "school_age_kids", "WG"), tags=("men", "prayer"), depth="deep")
group("iron", "theology", "Men of Iron", "Older men going line by line through Romans with commentaries. Seasoned, theological, and unhurried.",
      "men", "empty_nest", "tue_eve", lg("leader_iron", near(MARCUS_LOC, 1.5, rng_for("loc", "iron")), 140, "empty_nest", "WG"), tags=("men", "theology", "book_study"), depth="intensive", prep="heavy")
group("supper", "young_family", "Sunday Supper Families", "Young families share supper on Sunday evenings. Kids play while parents talk through the sermon.",
      "couples", "young_kids", "sun_pm", lg("leader_supper", point_at(MARCUS_LOC, 110, 1.8), 45, "young_kids", "WG"), childcare=True, tags=("parenting", "marriage"), depth="intro", prep="none")
group("clermont_moms", "young_family", "Clermont Moms Morning", "Moms of little ones on Tuesday mornings in Clermont. Kids welcome; we take turns watching them.",
      "women", "young_kids", "tue_am", lg("leader_clermont_moms", near(ZIPS["34711"], 0.8, rng_for("loc", "cmoms")), 36, "young_kids", "CL"), childcare=True, tags=("women", "parenting", "prayer"))
group("online", "online", "Online Thursday Study", "An online video study for people who travel, work shifts, or mostly join services by livestream. Cameras optional.",
      "mixed", "single", "thu_eve", pick_leader(rng_for("leader", "online"), "F", ("married_no_kids", "single"), "WG"), online=True, tags=("bible_reading", "book_study"), cap_max=25, fmt="online")

# ---- designed scenario groups (supporting evaluation scenarios; see EVAL below) ----
def designed(key, family, name, desc, gender, stage, slot, campus, leader_gender, leader_stages, cap_max, plan, tags, **kw):
    lead = pick_leader(rng_for("leader", key), leader_gender, leader_stages, campus)
    return group(key, family, name, desc, gender, stage, slot, lead, cap_max=cap_max, tags=tags, plan=plan, **kw)

designed("s_satmen", "mens", "Saturday Early Men's Prayer Breakfast",
         "Men meeting early on Saturday mornings for breakfast, prayer and a short passage. We cap the group at eight so everyone is heard.",
         "men", "school_age_kids", "sat_am", "WG", "M", ("school_age_kids", "empty_nest"), 8, "nearly_full", ("men", "prayer"), depth="deep", prep="light")
designed("s_satmix", "bible_study", "Saturday Morning Coffee & Scripture",
         "Coffee and a chapter of Scripture on Saturday mornings. This is the group for people whose only free time is Saturday.",
         "mixed", None, "sat_am", "WM", "F", ("single", "married_no_kids"), 14, "healthy", ("bible_reading", "book_study"))
designed("s_childcare", "young_family", "Wednesday Moms & Babies (Childcare Provided)",
         "Parents of babies, toddlers and preschoolers. Volunteers care for the children in the next room, so parents can actually listen and talk.",
         "mixed", "young_kids", "wed_eve", "WG", "F", ("young_kids",), 14, "healthy", ("parenting", "prayer"), childcare=True, depth="intro", prep="none")
designed("s_hybrid", "hybrid", "Winter Garden Hybrid Study",
         "We meet in person at a home and open a video link, so families who split their time between campuses or watch online can stay connected.",
         "mixed", None, "tue_eve", "WG", "M", ("school_age_kids", "married_no_kids"), 16, "healthy", ("bible_reading", "prayer"), fmt="hybrid")
designed("s_return", "foundational", "Coming Back Table",
         "A no-pressure group for people returning to church after time away. Come as you are, say as much or as little as you like.",
         "mixed", "empty_nest", "wed_eve", "OC", "F", ("empty_nest",), 12, "healthy", ("new_to_faith", "prayer"), depth="intro", prep="none")
designed("s_sun9", "bible_study", "Sunday Morning Bible Class",
         "A classic Sunday-morning Bible class that meets at the first service hour, with a short lesson and discussion.",
         "mixed", None, "sun_9", "WG", "M", ("school_age_kids", "empty_nest"), 20, "healthy", ("bible_reading",))

# ---- group-family templates ----
def describe(r, fam, cfg, emph, slot, campus, gender, childcare, depth, prep, freq, fmt, loc_zip):
    parts = [emph]
    if fmt == "hybrid":
        parts.append("Meets in person with a video link for anyone who cannot be there.")
    elif fmt == "online":
        parts.append("Meets by video call.")
    else:
        parts.append(f"Meets in a leader's home in the {AREA[loc_zip]} area.")
    parts.append(r.choice(CULTURE))
    parts.append(DEPTH_TEXT[depth])
    parts.append(PREP[prep])
    if freq != "weekly":
        parts.append("We meet every other week." if freq == "biweekly" else "We meet once a month.")
    if childcare:
        parts.append("Childcare is provided.")
    return " ".join(parts)

designed_count = Counter(g["family"] for g in GROUPS.values())
for fam, cfg in FAMILIES.items():
    need = cfg["count"] - designed_count[fam]
    for i in range(need):
        key = f"{fam}_{i}"
        r = rng_for("group", key)
        gender = weighted(r, cfg["gender"]); stage = weighted(r, cfg["stage"])
        if fam == "forming" and i == 0:
            pass
        slot = weighted(r, cfg["slot"])
        fmt = "online" if fam == "online" else "hybrid" if fam == "hybrid" else "in_person"
        # weekday mornings exist only at the Clermont ministry location (keeps Priya's cohort unserved by design)
        if slot in MORNING_SLOTS:
            campus = "CL"
        elif fam == "online":
            campus = "WG"
        else:
            campus = r.choices(list(CAMPUSES), [32, 28, 10, 30])[0]
        if gender == "couples":
            lead_g = r.choice(["M", "F"])
        else:
            lead_g = "M" if gender == "men" else "F" if gender == "women" else r.choice(["M", "F"])
        leader = pick_leader(r, lead_g, (stage,), campus)
        status = "forming" if fam == "forming" else "open"
        plan = "forming" if fam == "forming" else weighted(r, [("healthy", 44), ("under", 12), ("nearly_full", 14), ("full", 11), ("closed", 4), ("multiplying", 3), ("recent_departures", 12)])
        if plan == "full": status = "full"
        elif plan == "closed": status = "closed"
        elif plan == "multiplying": status = "multiplying"
        cap = r.randint(*cfg["cap"])
        childcare = r.random() < cfg["childcare"] and stage in ("young_kids", "school_age_kids")
        freq = weighted(r, [("weekly", 72), ("biweekly", 20), ("monthly", 8)]) if fam not in ("forming",) else "weekly"
        emph, extra = cfg["emph"][i % len(cfg["emph"])]
        tags = list(dict.fromkeys(cfg["tags"] + extra + (["men"] if gender == "men" else ["women"] if gender == "women" else [])))
        lz = people[leader]["household_id"]
        zipc = households[lz]["row"]["zip"]
        name = cfg["names"][i] if i < len(cfg["names"]) else f"{AREA[zipc]} {cfg['names'][i % len(cfg['names'])]}"
        desc = describe(r, fam, cfg, emph, slot, campus, gender, childcare, cfg["depth"], cfg["prep"], freq, fmt, zipc)
        life_focus = stage if (r.random() < 0.8 and fam not in ("bible_study", "interest", "serving", "prayer", "hybrid", "online", "mature_adult")) else (stage if r.random() < 0.35 else None)
        group(key, fam, name, desc, gender, life_focus, slot, leader, cap_max=cap, status=status, childcare=childcare, tags=tags,
              online=(fam == "online"), freq=freq, depth=cfg["depth"], prep=cfg["prep"], plan=plan, fmt=fmt)

# ---- V2 semantic differentiation: sentences appended to existing descriptions (original wording is kept) ----
def append_desc(key, text):
    GROUPS[key]["description"] = GROUPS[key]["_row"]["description"] = GROUPS[key]["_row"]["description"].rstrip() + " " + text

append_desc("newfaith", "Each week starts with the basics, so nobody needs to have read the earlier chapters or to know their way around the Bible.")
append_desc("singles", "Most of us grew up in church and already know our way around Scripture, so the conversation moves quickly and assumes some familiarity with the Bible.")
append_desc("online", "Everyone joins by video, so there is no driving and no hosting. Members read the week's passage on their own and use the call to compare notes, which suits people who are comfortable studying independently.")
append_desc("wordwomen", "Members finish the week's reading and memorize the verse before we meet; someone who has not read the book yet will feel behind.")
append_desc("deeproots", "Expect several hours of reading and written notes every week, and a lot of independent work between meetings.")
append_desc("accountability", "Weekly check-ins are expected and what is shared stays confidential; this is a committed group, not a casual hangout.")
append_desc("supper", "Whole families come together, including the kids, so nobody needs a sitter.")
append_desc("sunpm", "Adults only, and members arrive having done the reading.")
append_desc("forming_m", "There is no established routine yet; the first few members help set the pace and the reading plan.")
append_desc("forming_0", "The first weeks are for getting to know each other, and the study plan is still being decided.")
append_desc("s_return", "Nobody asks why you were away, and there is no reading to catch up on.")

# ================================================================ 7. MEMBERSHIPS, MEETINGS
IN_GROUP = {}
members_of = defaultdict(list)                 # group_id -> active person ids
def join(gid, pid, days_ago):
    IN_GROUP[pid] = gid; USED.add(pid); members_of[gid].append(pid)
    T["group_membership"].append(dict(group_id=gid, person_id=pid, status="active",
        joined_at=datetime.combine(TODAY - timedelta(days=days_ago), dtime(19)).isoformat(), left_at="", left_reason=""))

TARGET = dict(tom=5, sunpm=4, grace=6, newfaith=2, couples=2, emptynest=6, men_sat=8, teens=8, singles=5, clermont=4,
              forming_m=0, forming_w=0, deeproots=5, wordwomen=4, prayer=5, accountability=4, iron=5, supper=4,
              clermont_moms=4, online=4)
STAGE_FIT = dict(tom=("young_kids",), sunpm=("young_kids",), grace=("school_age_kids", "young_kids"),
                 newfaith=("single", "married_no_kids", "empty_nest"), couples=("married_no_kids",), emptynest=("empty_nest", "retired"),
                 men_sat=("school_age_kids", "teens", "empty_nest"), teens=("teens",), singles=("single",), clermont=("school_age_kids", "teens"),
                 deeproots=("married_no_kids", "empty_nest", "single"), wordwomen=("single",), prayer=("empty_nest", "retired"),
                 accountability=("young_kids", "school_age_kids", "teens"), iron=("empty_nest", "retired"), supper=("young_kids",),
                 clermont_moms=("young_kids",), online=("single", "married_no_kids", "school_age_kids"))
GENDER_OF = dict(men="M", women="F")

def members_pool(g, stages, radius):
    gender = GENDER_OF.get(g["gender_focus"])
    loc = (g["lat_approx"], g["lng_approx"])
    busy_ok = lambda a: g["meeting_slot"] not in {s for _, s, _ in people[a]["serves"]}
    pool = []
    for a in adults:
        if a in USED or a in RESERVED: continue
        p = people[a]
        if not p["participates"] or p["tenure"] < 3 or (gender and p["gender"] != gender): continue
        if stages and p["stage"] not in stages: continue
        if not g["is_online"] and miles(p["loc"], loc) > radius: continue
        if not busy_ok(a): continue
        pool.append(a)
    return pool

mr = rng_for("memberships")
def fill_group(key, n, stages):
    g = GROUPS[key]
    for _ in range(n):
        pool = members_pool(g, stages, RADIUS_MI) or members_pool(g, stages, 8) or members_pool(g, None, RADIUS_MI)
        if not pool:
            break
        a = mr.choice(pool)
        ten_days = int(people[a]["tenure"] * 30.4)
        join(g["group_id"], a, mr.randint(14, min(1500, ten_days - 7)))

join(GROUPS["emptynest"]["group_id"], ruth, 600)    # Ruth is in a group ("in a group" member view)
for key, n in TARGET.items():
    if key == "accountability":              # a stage-agnostic men's group: its roster mixes seasons of life (young dads and dads of school-age kids)
        fill_group(key, n // 2, ("young_kids",)); fill_group(key, n - n // 2, ("school_age_kids",))
    else:
        fill_group(key, n - (1 if key == "emptynest" else 0), STAGE_FIT.get(key))
FORCE_PROFILE = set(members_of[GROUPS["accountability"]["group_id"]])   # its mix is computed from members' opted-in profiles
LEFT = []
def departure(gid, g, days_joined, days_left, reason, pool_stages=None):
    pool = [a for a in members_pool(g, pool_stages, 8) if people[a]["tenure"] * 30.4 > days_joined + 7]
    if not pool: return
    a = mr.choice(pool); USED.add(a)
    T["group_membership"].append(dict(group_id=gid, person_id=a, status="left",
        joined_at=datetime.combine(TODAY - timedelta(days=days_joined), dtime(19)).isoformat(),
        left_at=datetime.combine(TODAY - timedelta(days=days_left), dtime(19)).isoformat(), left_reason=reason))
    LEFT.append((gid, a, days_joined, days_left))
departure(GROUPS["newfaith"]["group_id"], GROUPS["newfaith"], 200, 45, "schedule change")

LEFT_REASONS = ["schedule change", "moved away", "family change", "joined another group", "not the right fit", "group ended a season", "work travel"]
for key, g in GROUPS.items():
    if key in TARGET: continue
    plan, cap = g["plan"], g["capacity_max"]
    if plan == "forming":
        n = mr.randint(0, 6)
    elif plan == "under":
        n = mr.randint(g["capacity_min"], g["capacity_min"] + 1)
    elif plan == "nearly_full":
        n = max(g["capacity_min"], cap - mr.randint(1, 2))
    elif plan in ("full",):
        n = cap
    elif plan == "multiplying":
        n = max(g["capacity_min"], int(cap * 0.85))
    elif plan == "closed":
        n = max(g["capacity_min"], int(cap * 0.5))
    else:
        n = max(g["capacity_min"], int(cap * mr.uniform(0.5, 0.85)))
    if key == "s_satmen": n = 7
    if key == "s_satmix": n = 6
    if key == "s_childcare": n = 7
    if key == "s_hybrid": n = 8
    if key == "s_return": n = 6
    if key == "s_sun9": n = 9
    if g["status"] == "forming" and n > 0 and g["family"] != "forming": n = 0
    stages = (g["life_stage_focus"],) if g["life_stage_focus"] else None
    fill_group(key, n, stages)
    if plan in ("recent_departures", "healthy", "nearly_full") and mr.random() < (0.9 if plan == "recent_departures" else 0.25):
        for _ in range(mr.randint(1, 3)):
            dj = mr.randint(120, 900)
            departure(g["group_id"], g, dj, mr.randint(10, min(dj - 5, 330)), mr.choice(LEFT_REASONS), None)

# a pool shortfall must not leave a "full" or "nearly full" group inconsistent with its occupancy
for key, g in GROUPS.items():
    n = len(members_of[g["group_id"]])
    if key not in TARGET and g["plan"] in ("full", "nearly_full") and n < g["capacity_max"] - (1 if g["plan"] == "nearly_full" else 0):
        newcap = max(n + (1 if g["plan"] == "nearly_full" else 0), g["capacity_min"] + 1)
        g["capacity_max"] = newcap; g["_row"]["capacity_max"] = newcap

# group meetings and attendance over the full history (Manager-only, W2)
GROUP_START_W = {}
for key, g in GROUPS.items():
    if g["status"] == "forming": continue
    r = rng_for("meetings", key)
    start_w = WEEKS - 1 if g["plan"] != "recent_departures" and key not in ("newfaith", "couples") and r.random() > 0.08 else r.randint(10, 40)
    if g["status"] == "closed":
        end_w = r.randint(2, 14)
    else:
        end_w = 0
    GROUP_START_W[key] = start_w
    gid = g["group_id"]
    rate_base = 0.55 if key in ("newfaith", "couples") else r.uniform(0.66, 0.88)
    phase = r.randint(0, 3)
    memb = [(m["person_id"], datetime.fromisoformat(m["joined_at"]).date(),
             datetime.fromisoformat(m["left_at"]).date() if m["left_at"] else None) for m in T["group_membership"] if m["group_id"] == gid]
    mrate = {pid: min(0.97, max(0.25, rate_base + r.uniform(-0.15, 0.12))) for pid, _, _ in memb}
    for w in range(start_w, end_w - 1, -1):
        freq = g["frequency"]
        if (freq == "biweekly" and (w + phase) % 2) or (freq == "monthly" and (w + phase) % 4): continue
        if r.random() < 0.05: continue              # holiday or cancelled
        d = sunday(w) - timedelta(days=(7 - SLOT_DAY[g["meeting_slot"]]) % 7)
        mid = uid("mtg", gid, w)
        T["group_meeting"].append(dict(meeting_id=mid, group_id=gid, met_on=d.isoformat()))
        for pid, j, l in memb:
            if j <= d and (l is None or d < l):
                T["meeting_attendance"].append(dict(meeting_id=mid, person_id=pid, present=r.random() < mrate[pid]))

# ================================================================ 8. PROFILES
PROFILED = set()
def profile(pid, stage, slots, pref, interests, about, maxd=RADIUS_MI, days=None):
    if pid in PROFILED: return
    PROFILED.add(pid)
    rr = rng_for("profile", pid)
    T["member_profile"].append(dict(person_id=pid, opted_in_at=datetime.combine(TODAY - timedelta(days=days or rr.randint(3, 60)), dtime(20)).isoformat(),
        consent_version="v1-2026-10", life_stage=stage, available_slots=to_arr(slots), max_distance_mi=maxd, group_pref=pref,
        interests=to_arr(interests), about_me=about, profile_source="llm_confirmed", confirmed_at=NOW))

# Designed personas (about_me text preserved from v0.2; Dana's stated preference is "mixed": her story, in Demo
# Journeys and the design, never asks for a women-only group, and "women" contradicted the canonical expected pick).
profile(marcus, "young_kids", ["sun_pm", "tue_eve"], "men", ["men", "parenting", "bible_reading"],
        "Dad of two little ones. I help in the preschool room during second service most Sundays. Looking for a few guys to actually go deep with, not just small talk.", days=10)
profile(dana, "single", ["wed_eve", "thu_eve"], "mixed", ["bible_reading", "new_to_faith", "prayer"],
        "Moved here for work in September. I grew up going to church but never really read the Bible on my own, and I feel a little behind the people around me. I'd like to start, with people who won't judge my questions.", days=30)
profile(ruth, "empty_nest", ["sat_am", "wed_am", "tue_am"], "mixed", ["prayer", "serving_together"],
        "Kids are grown and gone. I love hosting and I've walked alongside a lot of young moms over the years.", days=40)
profile(sam, "young_kids", ["thu_eve", "tue_eve"], "men", ["men", "parenting"],
        "Two kids under three. Thursdays are the one night I can reliably get out.", days=5)
MOM_TEXT = ["Home with a toddler and a baby. Evenings are impossible with bedtime. A weekday morning with other moms would be a lifeline.",
            "Mornings are the only time I can do anything. Looking for other moms of little ones and something that allows kids.",
            "I work part-time from home. Weekday mornings work best; my two-year-old would need to come with me."]
for i, pid in enumerate(TODDLER_MOMS):
    profile(pid, "young_kids", MOM_SLOTS[i], "women", ["parenting", "women", "prayer"], MOM_TEXT[i % 3], days=7 + 4 * i)
# Jordan has NO profile on purpose: the demo shows intake live. Suggested text is in personas.json.

# ---- evaluation members: 12 existing (preserved) + 13 new scenarios ----
def new_member(key, first, last, gender, age, stage, loc, tenure_m, pattern, kids=(), spouse=None, campus=None):
    """A new evaluation member household (names given here, so ids are stable)."""
    r = rng_for("eval-member", key)
    hh = add_household(f"eval_{key}", loc=loc, r=r, campus=campus)
    pid = add_person(hh, first, last, gender, TODAY.year - age, "adult", tenure_start(tenure_m))
    people[pid].update(stage=stage); RESERVED.add(pid)
    if spouse:
        sp = add_person(hh, spouse[0], last, spouse[1], TODAY.year - age + 1, "adult", tenure_start(tenure_m))
        people[sp].update(stage=stage); RESERVED.add(sp)
    for i, ka in enumerate(kids):
        add_person(hh, r.choice(NAMES_KID), last, r.choice(["M", "F"]), TODAY.year - ka, "child", tenure_start(tenure_m), seq=i)
    for a in households[hh["household_id"]]["adults"]:
        people[a]["kids"] = list(kids)
    PATTERN_FOR[hh["household_id"]] = pattern
    households[hh["household_id"]]["pattern"] = pattern
    households[hh["household_id"]]["tenure"] = tenure_m
    return pid

def eg(key): return GROUPS[key]["group_id"]

# ---- evaluation labels (V2 model). eval_label.csv is an offline answer key: it is never loaded into the database.
# outcome_type is a small controlled vocabulary with one execution behavior each:
#   ranking              -> deterministic shortlist AND LLM ranking are evaluated (expectation says how strictly)
#   empty                -> no group may pass the hard filters; never sent to the ranking model
#   excluded             -> the listed groups must be absent from the shortlist; never sent to the ranking model
#   duplicate_pending    -> a second request to a group with a pending request must be blocked; not ranked
#   active_member        -> an active member is never matched; not ranked
# expectation (ranking only): top1 | top1_or_alternates | top3
OUTCOME_TYPES = ("ranking", "empty", "excluded", "duplicate_pending", "active_member")
EXPECTATIONS = ("top1", "top1_or_alternates", "top3")
LABEL_FIELDS = ["person_id", "label_key", "expected_group_id", "expected_group_name", "acceptable_group_ids", "cue", "purpose", "outcome_type",
                "excluded_group_ids", "scenario_family", "expectation", "semantic_contrast", "contrast_group_ids"]
def gk(x):                                       # a group key, or a group name
    if x in GROUPS: return x
    return next(k for k, g in GROUPS.items() if g["name"] == x)
def add_label(**kw):
    assert kw["outcome_type"] in OUTCOME_TYPES, kw["outcome_type"]
    assert (kw["outcome_type"] == "ranking") == (kw.get("expectation", "") in EXPECTATIONS), kw["label_key"]
    row = {f: "" for f in LABEL_FIELDS}
    row.update(kw)
    T["eval_label"].append(row)
SEM = {   # label -> (what an informed reviewer can see in the text, groups on the shortlist that are structurally plausible but weaker)
 "dana": ("First Steps is the only shortlisted group that expects no prior experience and says that questions are welcome and nobody is put on the spot. Thursday Twenties assumes some familiarity with Scripture; Thursday Women in the Word expects the reading done and the verse memorized; Online Thursday Study is independent study on a call; the forming group has no track record yet; Deep Roots is an advanced study with heavy weekly preparation. All are eligible on schedule, distance and seats; only one matches how she describes herself.",
          ["singles", "wordwomen", "online", "deeproots", "forming_0"]),
 "e04": ("A seeker with a lot of questions: First Steps welcomes basic questions, while Thursday Twenties assumes familiarity with Scripture and Online Thursday Study is independent study.", ["singles", "online", "forming_0"]),
 "e01": ("Years of reading and a request for doctrine: Deep Roots is the advanced systematic study; First Steps is pitched at newcomers and Thursday Twenties at a moderate pace.", ["newfaith", "singles", "online"]),
 "e02": ("Wants to memorize Scripture and move quickly: Thursday Women in the Word is the brisk memory-verse group; First Steps is gentle and Thursday Twenties is a dinner-and-friendship group.", ["newfaith", "singles", "online"]),
 "e05": ("Needs to join from wherever she is: Online Thursday Study is the only shortlisted group that is entirely on video; the others are hosted in a home.", ["newfaith", "singles", "forming_0"]),
 "e20": ("Prefers to participate from home: Online Thursday Study is video-only and self-paced; the other shortlisted groups meet in a leader's home.", ["singles", "newfaith", "deeproots"]),
 "e15": ("Wants an in-person weeknight group after too much screen time: Thursday Twenties meets in a home; Online Thursday Study is video-only; First Steps is pitched at newcomers.", ["online", "newfaith", "forming_0"]),
 "e08": ("Asks for accountability, not a lecture: Tuesday Men's Accountability is a committed, confidential men's group; the other shortlisted Tuesday options are parents' groups, a mixed hybrid study and a casual prayer-and-walk group.", ["Fearless Parenting", "Online Parent Circle", "s_hybrid", "Wednesday Intercessors"]),
 "e06": ("Wants the whole family included: Sunday Supper Families is for families together with the kids; Tuesday Night Dads, Early Riser Men and Sunday Lunch D-Group are men-only or adult-only.", ["tom", "Early Riser Men", "sunpm"]),
 "e11": ("Wants to start something fresh with other young dads: the forming men's group has no routine yet and invites its first members to set the pace; Tuesday Night Dads is established, and the other forming and family groups are mixed.", ["tom", "New Group: Young Couples Dinner", "Kids in Tow"]),
 "e22": ("Returning after time away and wants no pressure: Coming Back Table is built for that; Questions Welcome assumes a seeker, the forming group has no history and Grief & Hope Circle is a recovery group.", ["Questions Welcome", "New Group: Wednesday Study", "Grief & Hope Circle"]),
}
def sem_cols(k):
    if k not in SEM: return {}
    return dict(semantic_contrast=SEM[k][0], contrast_group_ids="|".join(eg(gk(x)) for x in SEM[k][1]))
LEG = rng_for("eval-legacy")
EVAL = [  # key, gender, stage, near point, slots, pref, interests, about_me, expected group, alternates, purpose
  ("e01", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "women", ["theology", "book_study"],
   "I've read theology for years and want women who will push me on doctrine. Homework is fine.", "deeproots", [], "theology depth"),
  ("e02", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "women", ["bible_reading"],
   "I want to memorize Scripture and move quickly. I'm disciplined and I love a reading plan.", "wordwomen", [], "disciplined study"),
  ("e03", "F", "empty_nest", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["prayer"],
   "I don't need a lot of discussion. I want to pray for people, and for our church.", "prayer", [], "prayer emphasis"),
  ("e04", "M", "single", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["new_to_faith"],
   "Not sure what I believe yet. A friend invited me and I have a lot of questions.", "newfaith", [], "questions and new faith"),
  ("e05", "F", "single", FS_LOC, ["wed_eve", "thu_eve"], "mixed", ["bible_reading"],
   "I travel for work half the month, so I'd need to join from wherever I am.", "online", [], "online access"),
  ("e06", "M", "young_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "couples", ["marriage", "parenting"],
   "My wife and I want to do this together, and our kids need to be included somehow.", "supper", [], "family inclusion"),
  ("e07", "M", "empty_nest", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["theology"],
   "I've taught Sunday school for twenty years. I want to go deep in Romans with men my age.", "iron", [], "mature men's theology"),
  ("e08", "M", "school_age_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["men", "prayer"],
   "There are some things I need to confess to other men. I need accountability, not a lecture.", "accountability", [], "accountability"),
  ("e09", "M", "young_kids", MARCUS_LOC, ["tue_eve", "sun_pm"], "men", ["parenting", "men"],
   "Two toddlers at home. I want other dads in the same season.", "tom", ["supper"], "fathers"),
  ("e10", "M", "school_age_kids", MARCUS_LOC, ["sun_pm", "tue_eve"], "men", ["theology", "men"],
   "I'd love to keep the sermon conversation going right after church over lunch.", "sunpm", [], "post-service timing"),
  ("e11", "M", "young_kids", None, ["thu_eve", "tue_eve"], "men", ["parenting"],
   "New dad. I'd like to start something fresh with other young dads.", "forming_m", ["tom"], "forming-group preference"),
  ("e12", "F", "married_no_kids", FS_LOC, ["wed_eve", "thu_eve"], "women", ["theology"],
   "Seminary-trained and looking for women who want real depth.", "deeproots", [], "theology depth"),
]
EVAL_MEMBERS = {}
EXTRA_LABEL = {}                                # key -> (outcome_type, family, excluded ids)
for key, gender, stage, pt, slots, pref, ints, about, exp, alts, purpose in EVAL:
    pt = pt or people[chris]["loc"]
    pid = legacy_household(f"eval_{key}", near(pt, 0.9, rng_for("loc", key)), LEG.uniform(12, 60), stage, pattern=("weekly" if key != "e05" else "mixed_online"))
    for a in households[people[pid]["household_id"]]["adults"]:
        people[a]["stage"] = stage
    profile(pid, stage, slots, pref, ints, about)
    EVAL_MEMBERS[key] = pid
    add_label(person_id=pid, label_key=key, expected_group_id=eg(exp), expected_group_name=GROUPS[exp]["name"],
        acceptable_group_ids="|".join(eg(a) for a in alts), cue=about, purpose=purpose,
        outcome_type="ranking", expectation="top1_or_alternates" if alts else "top1", scenario_family="existing", **sem_cols(key))
for who, exp, sk in [(marcus, "tom", None), (dana, "newfaith", "dana")]:
    add_label(person_id=who, label_key="persona", expected_group_id=eg(exp), expected_group_name=GROUPS[exp]["name"],
        cue="persona", purpose="persona journey 1", outcome_type="ranking", expectation="top1", scenario_family="existing", **sem_cols(sk))

# New scenarios. Each: member, circumstances, profile, and a defensible expectation.
grace_loc = people[grace]["loc"]
def gloc(key): return (GROUPS[key]["lat_approx"], GROUPS[key]["lng_approx"])      # scenario members live within reach of their intended group
NEW_EVAL = [
 dict(key="e13", fam="sparse engagement history", first="Hannah", last="Reeves", g="F", age=31, stage="young_kids", loc=near(MARCUS_LOC, 0.9, rng_for("loc", "e13")),
      tenure=9, pattern="sparse", kids=(1,), spouse=("Mitch", "M"), slots=["sun_pm", "tue_eve"], pref="couples", ints=["parenting", "marriage"],
      about="We're not at church every week with a toddler, but we'd love a Sunday evening dinner group with other parents.", exp="supper", alts=[], outcome="top1",
      purpose="sparse attendance history must not be read as low interest"),
 dict(key="e15", fam="stated preference versus observed behavior", first="Evan", last="Cho", g="M", age=27, stage="single", loc=near(FS_LOC, 0.9, rng_for("loc", "e15")),
      tenure=20, pattern="online_first", slots=["thu_eve", "wed_eve"], pref="mixed", ints=["bible_reading", "outdoors"],
      about="I've mostly watched online but I'm tired of screens. I want a real in-person group on a weeknight, near Windermere.", exp="singles", alts=[], outcome="top1",
      purpose="stated in-person preference outweighs online-first behavior"),
 dict(key="e16", fam="capacity-constrained best match", first="Gary", last="Whitlock", g="M", age=44, stage="school_age_kids", loc=near(gloc("s_satmen"), 1.5, rng_for("loc", "e16")),
      tenure=40, pattern="weekly", kids=(8, 11), spouse=("Dena", "F"), slots=["sat_am"], pref="men", ints=["men", "prayer"],
      about="Saturday mornings are the only time that works. I want a men's breakfast with prayer, and I heard the main one is full.", exp="s_satmen", alts=[], outcome="top1",
      purpose="the full group is excluded; the nearly full group with one seat is the right answer", excluded=["men_sat"]),
 dict(key="e17", fam="geographic tradeoff", first="Tina", last="Alvarado", g="F", age=42, stage="school_age_kids", loc=point_at(grace_loc, 200, 4.4),
      tenure=30, pattern="weekly", kids=(9, 12), spouse=("Rob", "M"), slots=["thu_eve"], pref="women", ints=["women", "bible_reading", "parenting"],
      about="I'd like a mom's Bible study that reads through Philippians. I'm a bit of a drive from most groups but I'll make the trip for the right one.", exp="grace", alts=[], outcome="top3_inclusion",
      purpose="a good fit near the edge of the 5-mile radius still belongs in the top three"),
 dict(key="e18", fam="strong schedule constraint", first="Miriam", last="Sandoval", g="F", age=36, stage="married_no_kids", loc=near(gloc("s_satmix"), 1.5, rng_for("loc", "e18")),
      tenure=14, pattern="twice_monthly", spouse=("Paul", "M"), slots=["sat_am"], pref="mixed", ints=["bible_reading", "book_study"],
      about="I work shifts all week. Saturday morning is the only time I am free to join anything.", exp="s_satmix", alts=[], outcome="top1",
      purpose="a single available slot makes the schedule decisive"),
 dict(key="e19", fam="childcare as a decisive requirement", first="Brooke", last="Delaney", g="F", age=30, stage="young_kids", loc=near(gloc("s_childcare"), 1.5, rng_for("loc", "e19")),
      tenure=11, pattern="weekly", kids=(0, 2), spouse=("Cal", "M"), slots=["wed_eve", "tue_eve", "thu_eve"], pref="mixed", ints=["parenting", "prayer"],
      about="I have a baby and a toddler and no one to watch them. I can only come to a group that has childcare on site.", exp="s_childcare", alts=[], outcome="top1",
      purpose="childcare is the decisive requirement"),
 dict(key="e20", fam="online-first behavior", first="Nina", last="Okafor", g="F", age=33, stage="single", loc=near(FS_LOC, 1.5, rng_for("loc", "e20")),
      tenure=26, pattern="online_first", slots=["wed_eve", "thu_eve", "tue_eve"], pref="mixed", ints=["bible_reading", "book_study"],
      about="I watch services online and I like it that way. I'd like a group I can join from my couch.", exp="online", alts=[], outcome="top1",
      purpose="an online-first member is matched to an online group"),
 dict(key="e21", fam="mixed online and in-person, multiple campuses", first="Darren", last="Quill", g="M", age=45, stage="school_age_kids", loc=point_at(gloc("s_hybrid"), 30, 3.0),
      tenure=50, pattern="mixed_online", kids=(10, 13), spouse=("Joy", "F"), slots=["tue_eve", "wed_eve"], pref="mixed", ints=["bible_reading", "prayer"],
      about="We go to the Ocoee campus some weeks and Winter Garden others, and sometimes watch online. A group that handles all that would be ideal.", exp="s_hybrid", alts=[], outcome="top3_inclusion",
      purpose="split campus attendance and mixed online participation favor a hybrid group", campus="OC", alt_campus="WG"),
 dict(key="e22", fam="returning after disengagement", first="Ellen", last="Marsh", g="F", age=58, stage="empty_nest", loc=near(gloc("s_return"), 2.0, rng_for("loc", "e22")),
      tenure=140, pattern="returning", spouse=None, slots=["wed_eve"], pref="mixed", ints=["prayer", "new_to_faith"],
      about="I stepped away from church for a couple of years after we moved. I'd like to ease back in with no pressure.", exp="s_return", alts=[], outcome="top1",
      purpose="a member returning after disengagement is matched to a gentle re-entry group"),
 dict(key="e23", fam="couple versus individual preference", first="Corey", last="Lindgren", g="M", age=30, stage="married_no_kids", loc=near(gloc("couples"), 1.5, rng_for("loc", "e23")),
      tenure=22, pattern="weekly", spouse=("Alexa", "F"), slots=["mon_eve", "sun_pm"], pref="couples", ints=["marriage"],
      about="My wife and I want a group for couples, not separate men's and women's groups.", exp="couples", alts=[], outcome="top1",
      purpose="a couples preference is honored over individual groups"),
 dict(key="e24", fam="serving schedule conflict", first="Vera", last="Holloway", g="F", age=39, stage="married_no_kids", loc=near(people[grace]["loc"], 1.5, rng_for("loc", "e24")),
      tenure=60, pattern="weekly", spouse=("Ned", "M"), slots=["sun_9", "wed_eve"], pref="mixed", ints=["bible_reading"], serves_sun9=True,
      about="I'd love a Sunday morning Bible class, but I serve on the welcome team at the first service every week.", exp=None, alts=[], outcome="deterministic_exclusion",
      purpose="a strong match at the member's own serving time is excluded by the schedule rule", excluded=["s_sun9"]),
 dict(key="e25", fam="duplicate pending join request", first="Joanna", last="Whitfield", g="F", age=28, stage="single", loc=near(DANA_LOC, 0.8, rng_for("loc", "e25")),
      tenure=8, pattern="weekly", slots=["thu_eve", "wed_eve"], pref="women", ints=["bible_reading", "women"],
      about="I want to read the Bible quickly with other women who take it seriously.", exp="wordwomen", alts=[], outcome="duplicate_request_blocked",
      purpose="a second request to a group with a pending request is blocked", pending_to="wordwomen"),
 dict(key="e27", fam="forming-group opportunity, no engagement history", first="Lauren", last="Pike", g="F", age=26, stage="single", loc=near(gloc("forming_w"), 1.5, rng_for("loc", "e27")),
      tenure=0.4, pattern="none", slots=["tue_eve", "thu_eve"], pref="women", ints=["women", "bible_reading", "new_to_faith"],
      about="Brand new to the area. I would love to help start a new women's group and meet people at the very beginning.", exp="forming_w", alts=[], outcome="top3_inclusion",
      purpose="a brand-new attender with no history is offered a forming group"),
]
OUTCOME_MAP = {"top1": ("ranking", "top1"), "top1_or_alternates": ("ranking", "top1_or_alternates"), "top3_inclusion": ("ranking", "top3"),
               "deterministic_exclusion": ("excluded", ""), "duplicate_request_blocked": ("duplicate_pending", "")}
for sc in NEW_EVAL:
    pid = new_member(sc["key"], sc["first"], sc["last"], sc["g"], sc["age"], sc["stage"], sc["loc"], sc["tenure"], sc["pattern"],
                     kids=sc.get("kids", ()), spouse=sc.get("spouse"), campus=sc.get("campus"))
    if sc.get("alt_campus"):
        households[people[pid]["household_id"]]["alt_campus"] = sc["alt_campus"]
    if sc.get("serves_sun9"):
        serve(pid, "Hospitality", "Welcome team", "sun_9", "weekly", 30)
    profile(pid, sc["stage"], sc["slots"], sc["pref"], sc["ints"], sc["about"], days=12)
    EVAL_MEMBERS[sc["key"]] = pid
    exp = sc["exp"]
    otype, expect = OUTCOME_MAP[sc["outcome"]]
    add_label(person_id=pid, label_key=sc["key"], expected_group_id=eg(exp) if exp else "", expected_group_name=GROUPS[exp]["name"] if exp else "",
        acceptable_group_ids="|".join(eg(a) for a in sc["alts"]), cue=sc["about"], purpose=sc["purpose"], outcome_type=otype, expectation=expect,
        excluded_group_ids="|".join(eg(x) for x in sc.get("excluded", [])), scenario_family=sc["fam"], **sem_cols(sc["key"]))
# persona-based policy scenarios
add_label(person_id=priya, label_key="persona_priya", cue="persona", purpose="intentionally empty recommendation: no weekday-morning group within 5 miles",
    outcome_type="empty", scenario_family="intentionally empty recommendation")
add_label(person_id=ruth, label_key="persona_ruth", cue="persona", purpose="existing active membership: never sent through matching",
    outcome_type="active_member", scenario_family="existing active membership")

# ---- generic profiles (member archetypes, design 4.5) ----
SLOT_POOLS = {
  "single": [("wed_eve", 3), ("thu_eve", 3), ("tue_eve", 2), ("mon_eve", 1), ("sat_am", 2), ("sun_pm", 2)],
  "married_no_kids": [("mon_eve", 3), ("tue_eve", 2), ("thu_eve", 2), ("sun_pm", 3), ("sat_am", 1), ("wed_eve", 2)],
  "young_kids": [("tue_eve", 3), ("thu_eve", 3), ("sun_pm", 3), ("wed_eve", 2), ("tue_am", 1), ("wed_am", 1), ("thu_am", 1)],
  "school_age_kids": [("tue_eve", 3), ("wed_eve", 3), ("thu_eve", 3), ("sun_pm", 3), ("sat_am", 1)],
  "teens": [("tue_eve", 3), ("wed_eve", 3), ("thu_eve", 3), ("sun_pm", 3), ("sat_am", 1)],
  "empty_nest": [("tue_am", 2), ("wed_am", 2), ("thu_am", 2), ("sat_am", 3), ("wed_eve", 3), ("sun_pm", 2), ("tue_eve", 1)],
  "retired": [("tue_am", 2), ("wed_am", 2), ("thu_am", 2), ("sat_am", 3), ("wed_eve", 2), ("sun_pm", 2)],
}
ABOUT = {
  "new_believer": ["I'm new to faith and have a lot of questions.", "I recently started coming to church and want to understand the Bible."],
  "deep_study": ["I've studied Scripture for years and want to go deeper.", "I'm looking for serious study with people who read carefully."],
  "parent_childcare": ["With little ones at home I need a group that works around our schedule.", "A group where our kids are welcome would help a lot."],
  "young_adult_community": ["I'm looking for friends my age who take faith seriously.", "I want community, not just a Sunday seat."],
  "schedule_flexible": ["My schedule changes a lot, so I need something flexible.", "I can usually do one weeknight, depending on work."],
  "online_first": ["I mostly join online and prefer to do groups from home.", "I live a bit far, so video would be easiest."],
  "returning": ["I took a break from church and am easing back in.", "I'm coming back after some time away."],
  "prayer_support": ["I want a place to pray with others.", "Prayer is what I'm looking for most."],
  "serving": ["I love serving and want a group that serves together.", "I'd like to pair Bible study with helping others."],
  "stated_vs_observed": ["I want to be more consistent and in-person than I have been."],
}
ARCH_INTERESTS = {
  "new_believer": ["new_to_faith", "bible_reading", "prayer"], "deep_study": ["theology", "book_study", "bible_reading"],
  "parent_childcare": ["parenting", "marriage", "prayer"], "young_adult_community": ["bible_reading", "outdoors", "serving_together"],
  "schedule_flexible": ["bible_reading", "prayer"], "online_first": ["bible_reading", "book_study"],
  "returning": ["new_to_faith", "prayer"], "prayer_support": ["prayer", "recovery_friendly"],
  "serving": ["serving_together", "prayer"], "stated_vs_observed": ["bible_reading", "prayer"],
}
def member_archetype(pid, r):
    p = people[pid]; h = households[p["household_id"]]; ten = p["tenure"]; st = p["stage"]
    if h["pattern"] in ("online_first", "mixed_online") and r.random() < 0.6: return "online_first"
    if h["pattern"] == "returning" and r.random() < 0.7: return "returning"
    if ten < 12 and r.random() < 0.4: return "new_believer"
    if st in ("young_kids", "school_age_kids") and r.random() < 0.45: return "parent_childcare"
    if st == "single" and TODAY.year - p["birth_year"] < 32 and r.random() < 0.45: return "young_adult_community"
    if ten > 60 and r.random() < 0.35: return "deep_study"
    if p["serves"] and r.random() < 0.5: return "serving"
    return r.choices(["prayer_support", "schedule_flexible", "stated_vs_observed", "deep_study", "new_believer"], [30, 40, 8, 12, 10])[0]

def generic_profile(pid):
    r = rng_for("gprofile", pid); p = people[pid]
    arch = member_archetype(pid, r); p["archetype"] = arch
    st = p["stage"]
    slots = list(dict.fromkeys(weighted_k(r, SLOT_POOLS[st], r.randint(2, 3))))
    gender = p["gender"]
    pref = ("men" if gender == "M" else "women") if r.random() < 0.4 else ("couples" if st == "married_no_kids" and r.random() < 0.5 else "mixed")
    rest_i = [i for i in INTERESTS if i not in ARCH_INTERESTS[arch]]
    ints = r.sample(ARCH_INTERESTS[arch] + r.sample(rest_i, 2), r.randint(2, 4)) if r.random() > 0.15 else []
    detail = r.random()
    about = (" ".join(r.sample(ABOUT[arch], min(len(ABOUT[arch]), r.choice([1, 2]))))) if detail < 0.55 else ""
    if detail > 0.93:                                       # sparse profile: missing fields
        pref = ""; ints = []
    profile(pid, st, slots, pref, ints, about)

def weighted_k(r, pairs, k):
    out = []
    for _ in range(k):
        out.append(weighted(r, pairs))
    return out

in_member = [a for a in adults if a in IN_GROUP and a not in RESERVED]
outside = [a for a in adults if a not in IN_GROUP and a not in RESERVED and people[a]["participates"]]
pr = rng_for("profile-select")
want = int(SCALE["profile_rate"] * len(adults)) - len(PROFILED)
p_member = 0.60
chosen = [a for a in in_member if pr.random() < p_member]
rest = max(0, want - len(chosen))
fresh = [a for a in outside if people[a]["tenure"] < 3]
others = [a for a in outside if people[a]["tenure"] >= 3]
chosen += list(FORCE_PROFILE)
chosen += [a for a in fresh if pr.random() < 0.55] + pr.sample(others, min(len(others), max(0, rest - len(fresh) // 2)))
for pid in sorted(set(chosen)):
    generic_profile(pid)

# feasibility pass: a person picks times that exist. Every generic non-member profile reaches at least one group
# (only the designated toddler-mom cohort and the empty-recommendation scenario stay at zero, on purpose).
busy = defaultdict(set)
for s in T["serving_assignment"]: busy[s["person_id"]].add(s["schedule_slot"])
prof = {r["person_id"]: r for r in T["member_profile"]}
def eligible(pid, slots=None):
    pr_ = prof.get(pid); slots = slots or set(pr_["available_slots"].strip("{}").split(","))
    sex = people[pid]["gender"]; out = []
    for key, g in GROUPS.items():
        if g["status"] not in ("open", "forming") or len(members_of[g["group_id"]]) >= g["capacity_max"]: continue
        if (g["gender_focus"] == "men" and sex != "M") or (g["gender_focus"] == "women" and sex != "F"): continue
        if g["meeting_slot"] not in slots or g["meeting_slot"] in busy[pid]: continue
        if not g["is_online"] and miles(people[pid]["loc"], (g["lat_approx"], g["lng_approx"])) > RADIUS_MI: continue
        out.append(key)
    return out
fr = rng_for("feasibility")
dropped = 0
for pid in sorted(prof):
    if pid in IN_GROUP or pid in RESERVED or pid in COHORT_ZERO: continue
    if eligible(pid): continue
    row = prof[pid]; st = people[pid]["stage"]; ok = False
    for _ in range(14):
        slots = set(weighted_k(fr, [x for x in SLOT_POOLS[st] if x[0] not in MORNING_SLOTS] or SLOT_POOLS[st], fr.randint(2, 3)))
        if eligible(pid, slots):
            row["available_slots"] = to_arr(sorted(slots)); ok = True; break
    if not ok:
        T["member_profile"].remove(row); PROFILED.discard(pid); del prof[pid]; dropped += 1

# ================================================================ 9. JOIN REQUESTS
def req(i, pid, gkey, note, days_ago, status="requested", decided_days=None, reason=""):
    row = dict(request_id=uid("req", i), person_id=pid, group_id=eg(gkey), rec_id="", status=status, member_note=note,
               requested_at=datetime.combine(TODAY - timedelta(days=days_ago), dtime(21)).isoformat(),
               decided_at=datetime.combine(TODAY - timedelta(days=decided_days), dtime(20)).isoformat() if decided_days is not None else "",
               decided_by="", decline_reason=reason)
    T["join_request"].append(row)

tr = rng_for("req-tom")
for i in range(2):
    pool = [a for a in adults if a not in USED and a not in RESERVED and a not in IN_GROUP and people[a]["gender"] == "M"
            and people[a]["stage"] == "young_kids" and miles(people[a]["loc"], people[tom]["loc"]) <= 4 and people[a]["participates"]]
    r_ = tr.choice(sorted(pool)); USED.add(r_)
    profile(r_, "young_kids", ["tue_eve"], "men", ["parenting", "men"], "")
    req(i, r_, "tom", ["Saw this pop up for me. Tuesdays work and I'm close by.", "My wife said I need guys in my life. She's right."][i], [2, 9][i])
req("sam", sam, "forming_m", "Thursdays are perfect. Happy to help get this one started.", 1)
req("e25", EVAL_MEMBERS["e25"], "wordwomen", "I would love to join. I read fast and want company.", 3)       # duplicate-request scenario
# decided history (accepted requests match memberships; other outcomes round out the picture; deciders are not seeded users)
hr = rng_for("req-history")
recent = [m for m in T["group_membership"] if m["status"] == "active" and (TODAY - datetime.fromisoformat(m["joined_at"]).date()).days <= 360]
for k, m in enumerate(hr.sample(recent, min(len(recent), 70))):
    j = datetime.fromisoformat(m["joined_at"]).date()
    dd = (TODAY - j).days
    T["join_request"].append(dict(request_id=uid("req", "hist", k), person_id=m["person_id"], group_id=m["group_id"], rec_id="", status="accepted",
        member_note="", requested_at=datetime.combine(j - timedelta(days=hr.randint(1, 6)), dtime(20)).isoformat(),
        decided_at=datetime.combine(j, dtime(19)).isoformat(), decided_by="", decline_reason=""))
others_g = [k for k, g in GROUPS.items() if g["status"] in ("open", "full")]
for k in range(14):
    pid = hr.choice(sorted(a for a in adults if a not in IN_GROUP and a not in RESERVED and people[a]["participates"]))
    gk = hr.choice(others_g)
    st = hr.choice(["declined", "withdrawn", "expired"])
    d0 = hr.randint(20, 300)
    T["join_request"].append(dict(request_id=uid("req", "hist-other", k), person_id=pid, group_id=eg(gk), rec_id="", status=st, member_note="",
        requested_at=datetime.combine(TODAY - timedelta(days=d0), dtime(20)).isoformat(),
        decided_at=datetime.combine(TODAY - timedelta(days=d0 - hr.randint(1, 8)), dtime(20)).isoformat(),
        decided_by="", decline_reason="Group was full that season." if st == "declined" else ""))

# ================================================================ 10. ENGAGEMENT (52 weeks)
DRIFTED = set()
def week_prob(pat, w, prm):
    if pat == "weekly": return 0.93
    if pat == "twice_monthly": return 0.5
    if pat == "monthly": return 0.25
    if pat == "seasonal": return 0.05 if prm["gap"][0] <= w < prm["gap"][1] else 0.8
    if pat == "rising": return 0.15 + 0.78 * (1 - w / (WEEKS - 1))
    if pat == "declining": return 0.15 + 0.78 * (w / (WEEKS - 1))
    if pat in ("online_first", "mixed_online"): return 0.7
    if pat == "concentrated_wed": return 0.18
    if pat in ("interrupted", "returning"): return 0.05 if prm["gap"][0] <= w < prm["gap"][1] else 0.85
    if pat == "sparse": return 0.08
    if pat == "new_visit": return 0.6
    return 0.0
BASE = {"weekly": 0.93, "twice_monthly": 0.5, "monthly": 0.25, "seasonal": 0.55, "rising": 0.55, "declining": 0.55, "online_first": 0.7,
        "mixed_online": 0.7, "concentrated_wed": 0.18, "interrupted": 0.6, "returning": 0.6, "sparse": 0.08, "new_visit": 0.6, "none": 0.0}

def rostered(pid, slot, week_index):
    for _, sl, freq in people[pid]["serves"]:
        if sl != slot: continue
        if freq == "weekly" or (freq == "biweekly" and week_index % 2 == 0) or (freq == "monthly" and week_index % 4 == 0):
            return True
    return False

er = rng_for("engagement")
for hid in list(households):
    assign_pattern(hid)
for hid, h in households.items():
    if not h["adults"]: continue
    kids12 = [k for k in h["kids"] if TODAY.year - people[k]["birth_year"] <= 12]
    pat = h["pattern"]
    mode = "online_only" if pat == "online_first" else "hybrid" if (pat == "mixed_online" or er.random() < 0.06) else "in_person"
    app = er.random() < 0.22
    kiosk = bool(kids12) and er.random() < 0.88
    if hid in FORCE:
        mode, app, kf = FORCE[hid]; kiosk = kf and bool(kids12)
    online_share = {"online_only": 0.92, "hybrid": 0.45 if pat == "mixed_online" else 0.2}.get(mode, 0.0)
    row = h["row"]
    if app:
        row["checkin_app_opt_in"] = True
        row["app_opt_in_at"] = datetime.combine(TODAY - timedelta(days=er.randint(30, 400)), dtime(12)).isoformat()
    part = [a for a in h["adults"] if people[a]["participates"]]
    if not part:
        pat = "none"
    prm = dict(gap=(0, 0))
    if pat in ("seasonal", "interrupted"):
        s0 = er.randint(4, 36); prm["gap"] = (s0, s0 + er.randint(8, 16))
    if pat == "returning":
        s0 = er.randint(4, 14); prm["gap"] = (s0, min(WEEKS - 4, s0 + er.randint(20, 30)))
    home_slots = [s for _, s, _ in CAMPUSES[h["campus"]]["sundays"]]
    home_slot = people[h["adults"][0]].get("home_service") or er.choice(home_slots)
    if home_slot not in home_slots: home_slot = home_slots[0]
    for a in part:                               # people attend the service they serve at
        sv = [sl for _, sl, _ in people[a]["serves"] if sl in home_slots]
        if sv: home_slot = sv[0]; break
    start = min((date.fromisoformat(people[a]["first_attended_on"]) for a in part), default=TODAY)
    drifted = pat == "declining"
    if drifted: DRIFTED.update(h["adults"])
    T["_truth_household"].append(dict(household_id=hid, online_mode=mode, kiosk_user=kiosk, app_opt_in=app, home_service=home_slot,
                                      drifted=drifted, pattern=pat, campus=h["campus"], alt_campus=h.get("alt_campus", ""), archetype=h.get("arch", "named")))
    for a in h["adults"]:
        T["_truth_person"].append(dict(person_id=a, propensity=BASE.get(pat, 0.0) if people[a]["participates"] else 0.0, drifted=drifted,
                                       participates=people[a]["participates"], archetype=people[a]["archetype"] or "", pattern=pat))
    if pat == "none": continue
    for w in range(WEEKS):
        sun = sunday(w)
        if sun < start: continue
        if er.random() >= week_prob(pat, w, prm): continue
        online = mode == "online_only" or (mode == "hybrid" and er.random() < online_share)
        campus = h["campus"]
        if h.get("alt_campus") and er.random() < 0.4: campus = h["alt_campus"]
        slot = home_slot if home_slot in [s for _, s, _ in CAMPUSES[campus]["sundays"]] else [s for _, s, _ in CAMPUSES[campus]["sundays"]][0]
        if online:
            svc = SVC[(sun.isoformat(), "WG", "sun_11")] if er.random() < 0.7 else SVC[(sun.isoformat(), "ON", ONLINE_SERVICE[1])]
            hh_, mm_ = map(int, svc["start_time"].split(":")[:2])
            T["attendance_event"].append(dict(person_id=part[0], service_id=svc["service_id"], channel="livestream", checked_in_by="",
                checked_in_at=(datetime.combine(sun, dtime(hh_, mm_)) + timedelta(minutes=er.randint(0, 10))).isoformat(),
                minutes_watched=er.choice([4, 9, 18, 35, 52, 64, 71])))
            continue
        s = SVC[(sun.isoformat(), campus, slot)]
        hh_, mm_ = map(int, s["start_time"].split(":")[:2])
        base = datetime.combine(sun, dtime(hh_, mm_))
        present = [a for a in part if a == part[0] or er.random() < 0.9]
        for a in present:
            if rostered(a, s["slot"], w) and h["campus"] == campus:
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="serving_roster", checked_in_by="",
                    checked_in_at=(base - timedelta(minutes=45)).isoformat(), minutes_watched=""))
        if app:
            for a in present:
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="app_geofence", checked_in_by="",
                    checked_in_at=(base - timedelta(minutes=er.randint(3, 20))).isoformat(), minutes_watched=""))
        if kiosk:
            by = er.choice(present)
            for k in kids12:
                T["attendance_event"].append(dict(person_id=k, service_id=s["service_id"], channel="kiosk", checked_in_by=by,
                    checked_in_at=(base - timedelta(minutes=er.randint(2, 12))).isoformat(), minutes_watched=""))
    # Wednesday nights (Winter Garden only): in person, smaller crowd
    wp = 0.8 if pat == "concentrated_wed" else (BASE.get(pat, 0.0) * 0.3 if pat not in ("online_first",) else 0.0)
    for w in range(WEEKS):
        wed = TODAY - timedelta(weeks=w, days=4)
        if wed < start or mode == "online_only" or er.random() >= wp: continue
        s = SVC[(wed.isoformat(), "WG", "wed_eve")]
        base = datetime.combine(wed, dtime(19))
        for a in part:
            if rostered(a, "wed_eve", w):
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="serving_roster", checked_in_by="",
                    checked_in_at=(base - timedelta(minutes=30)).isoformat(), minutes_watched=""))
            if app:
                T["attendance_event"].append(dict(person_id=a, service_id=s["service_id"], channel="app_geofence", checked_in_by="",
                    checked_in_at=(base - timedelta(minutes=er.randint(3, 15))).isoformat(), minutes_watched=""))

# ================================================================ 11. PORTAL USERS, TRUTH FILES, OUTPUT
for key, p in PERSONAS.items():
    T["portal_user"].append(dict(user_id=uid("user", key), person_id=p["person_id"], role=p["role"], email=f"{key}@demo.gathered.invalid"))
CAP_BAND = lambda c: "6-10" if c <= 10 else "11-16" if c <= 16 else "17-30"
for key, g in GROUPS.items():
    T["_truth_group"].append(dict(group_id=g["group_id"], key=key, family=g["family"], campus=g["campus"], format=g["fmt"], depth=g["depth"],
                                  prep=g["prep"], occupancy_plan=g["plan"], capacity_band=CAP_BAND(g["capacity_max"])))

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

# ---- console summary (the offline validator, scripts/seed_validate.mjs, does the real checks) ----
n_ad = sum(1 for r in T["person"] if r["household_role"] == "adult")
print(f"generator {GENERATOR_VERSION}  seed {SEED}  out {OUT}")
print("rows:", {k: len(v) for k, v in T.items()})
print(f"households {len(households)}  adults {n_ad}  children {len(T['person']) - n_ad}  groups {len(GROUPS)}  profiles {len(T['member_profile'])}  "
      f"active memberships {sum(1 for m in T['group_membership'] if m['status'] == 'active')}  dropped profiles {dropped}")
print("attendance by channel:", dict(Counter(e["channel"] for e in T["attendance_event"])))
print(f"duration {_clock.time() - _t0:.1f}s")
