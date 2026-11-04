-- Gathered: Lakebase walkthrough. Paste one numbered block at a time into the Lakebase SQL editor.
-- PART A runs as you (the owner), so row-level security is bypassed and you see everything.
-- PART B switches to gathered_app inside a transaction, so you see what each persona sees.

-- ============================================================ PART A · the data (owner view)

-- A1. Row counts
select 'household' t, count(*) from app.household union all
select 'person', count(*) from app.person union all
select 'member_profile', count(*) from app.member_profile union all
select 'grp', count(*) from app.grp union all
select 'group_membership (active)', count(*) from app.group_membership where status = 'active' union all
select 'group_meeting', count(*) from app.group_meeting union all
select 'meeting_attendance', count(*) from app.meeting_attendance union all
select 'join_request', count(*) from app.join_request union all
select 'portal_user', count(*) from app.portal_user;

-- A2. The public group cards, exactly as members will see them (no coordinates, area label only)
select name, meeting_slot, gender_focus, status, open_seats, area_label, childcare, tags
from app.group_card()
order by status, name;

-- A3. Demo personas and their roles
select pu.role, p.first_name || ' ' || p.last_name as persona, h.zip,
       (select string_agg(g.name, ', ') from app.group_leader gl join app.grp g using (group_id)
         where gl.person_id = p.person_id) as leads,
       (select string_agg(g.name, ', ') from app.group_membership gm join app.grp g using (group_id)
         where gm.person_id = p.person_id and gm.status = 'active') as member_of,
       exists (select 1 from app.member_profile mp where mp.person_id = p.person_id) as has_profile
from app.portal_user pu
join app.person p using (person_id)
join app.household h using (household_id)
order by pu.role, persona;

-- A4. Hard filters for Marcus (gender, seats, schedule, within 5 mi of the leader's home).
-- Preview of recommend_groups(). The busy-slot filter is missing until the Databricks notebook writes
-- person_features, so Sunday Lunch still shows here even though he serves at 11:00.
with me as (
  select p.person_id, p.gender, h.lat_approx lat, h.lng_approx lng, mp.available_slots
  from app.person p join app.household h using (household_id) join app.member_profile mp using (person_id)
  where p.first_name = 'Marcus' and p.last_name = 'Hale'
)
select c.name, c.meeting_slot, c.open_seats, c.is_online,
       round((3958.8 * 2 * asin(sqrt(power(sin(radians(g.lat_approx - me.lat) / 2), 2)
             + cos(radians(me.lat)) * cos(radians(g.lat_approx)) * power(sin(radians(g.lng_approx - me.lng) / 2), 2))))::numeric, 1) as miles
from me
cross join app.group_card() c
join app.grp g on g.group_id = c.group_id
where c.status in ('open', 'forming')
  and c.open_seats > 0
  and (c.gender_focus not in ('men', 'women') or (c.gender_focus = 'men') = (me.gender = 'M'))
  and c.meeting_slot = any (me.available_slots)
  and (c.is_online or 3958.8 * 2 * asin(sqrt(power(sin(radians(g.lat_approx - me.lat) / 2), 2)
             + cos(radians(me.lat)) * cos(radians(g.lat_approx)) * power(sin(radians(g.lng_approx - me.lng) / 2), 2))) <= 5)
order by miles;

-- A5. Escalation preview: rules the nightly job will raise
select 'below minimum' as rule, c.name as detail, (c.capacity_max - c.open_seats) || ' members' as evidence
from app.group_card() c join app.grp g using (group_id)
where c.status = 'open' and (c.capacity_max - c.open_seats) < g.capacity_min
union all
select 'request waiting > 7 days', g.name, to_char(now() - jr.requested_at, 'DD "days"')
from app.join_request jr join app.grp g using (group_id)
where jr.status = 'requested' and jr.requested_at < now() - interval '7 days';

-- A6. Unmet demand (escalation #3): moms of little ones who only have weekday mornings
select p.first_name, h.zip, mp.available_slots,
       (select string_agg(c.name || ' (' || c.area_label || ')', ', ')
          from app.group_card() c
         where c.meeting_slot = any (mp.available_slots) and c.gender_focus in ('women', 'mixed')) as weekday_morning_groups_anywhere
from app.member_profile mp
join app.person p using (person_id)
join app.household h using (household_id)
where mp.life_stage = 'young_kids' and p.gender = 'F'
  and mp.available_slots <@ array['tue_am', 'wed_am', 'thu_am']
  and not exists (select 1 from app.group_membership gm where gm.person_id = p.person_id and gm.status = 'active');

-- ============================================================ PART B · row-level security in action
-- Each block is one transaction: look up the persona as owner, switch to gathered_app, query, roll back.
-- If "set local role gathered_app" fails with "permission denied", run this once and retry:
--     grant gathered_app to current_user;

-- B1. MANAGER (Alan): sees everything
begin;
select set_config('app.role', 'manager', true),
       set_config('app.person_id', (select person_id::text from app.person where first_name = 'Alan' and last_name = 'Whitfield'), true);
set local role gathered_app;
select current_user as running_as,
       (select count(*) from app.member_profile)     as profiles_visible,
       (select count(*) from app.group_membership)   as memberships_visible,
       (select count(*) from app.meeting_attendance) as meeting_attendance_visible,
       (select count(*) from app.join_request)       as requests_visible;
rollback;

-- B2. LEADER (Tom): only his group's members and requests, and NO member profiles
begin;
select set_config('app.role', 'leader', true),
       set_config('app.person_id', (select person_id::text from app.person where first_name = 'Tom' and last_name = 'Brennan'), true);
set local role gathered_app;
select current_user as running_as,
       (select count(*) from app.member_profile)     as profiles_visible,      -- expect 0
       (select count(*) from app.group_membership)   as memberships_visible,   -- expect his group only
       (select count(*) from app.meeting_attendance) as meeting_attendance_visible,
       (select string_agg(first_name || ': ' || coalesce(jr.member_note, ''), ' | ')
          from app.join_request jr join app.person p using (person_id)
         where jr.status = 'requested')               as open_requests;
rollback;

-- B3. MEMBER (Marcus): only himself
begin;
select set_config('app.role', 'member', true),
       set_config('app.person_id', (select person_id::text from app.person where first_name = 'Marcus' and last_name = 'Hale'), true);
set local role gathered_app;
select current_user as running_as,
       (select count(*) from app.member_profile)     as profiles_visible,      -- expect 1 (his own)
       (select count(*) from app.person)             as people_visible,        -- expect 1
       (select count(*) from app.group_membership)   as memberships_visible,   -- expect 0
       (select count(*) from app.meeting_attendance) as meeting_attendance_visible, -- expect 0
       (select count(*) from app.group_card())       as group_cards_visible;   -- expect 20 (public)
rollback;

-- B4. NO CONTEXT: nothing but public cards
begin;
set local role gathered_app;
select (select count(*) from app.person) as people_visible,       -- expect 0
       (select count(*) from app.group_card()) as group_cards;    -- expect 20
rollback;

-- B5. Guardrail: leader's home coordinates are not readable by the app role. Expect: permission denied
begin;
set local role gathered_app;
select name, lat_approx, lng_approx from app.grp limit 1;
rollback;

-- B6. Guardrail: internal rationale is manager-only. Expect: ERROR "manager only"
begin;
select set_config('app.role', 'member', true);
set local role gathered_app;
select * from app.manager_recommendation_audit();
rollback;
