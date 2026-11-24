-- Gathered: population demand-gap analytics (Databricks).
--
-- Question: among opted-in adults without an active group, where are people concentrated in
-- life-stage / availability combinations that the current group catalog serves poorly?
-- No scores and no model: counts, canonical hard-filter rules and two thresholds.
--
-- DEMAND  one row per (life_stage, available_slot). A person counts in a slot when they are an
--         adult with a confirmed opt-in profile, hold no active group membership, listed the slot
--         as available and are not rostered to serve in it (busy_slots, from person_features).
--         People who listed several slots appear in several cohort rows; the rows are cohorts,
--         not a partition, so their counts must not be added together.
-- SUPPLY  groups open or forming with at least one open seat (capacity_max minus active members),
--         meeting in the slot, whose declared life_stage_focus is empty or equals the cohort's.
--         serving_group_count / available_seat_count use these catalog rules only.
-- REACH   people_without_reachable_group applies the full app hard filters per person on top of
--         the supply rule: gender focus, and (for in-person groups) within 5 miles of the group's
--         location (the leader's home). people_without_group_in_catalog ignores geography and
--         gender, so the difference between the two is shown, not hidden.
-- GAP     an honest minimum size (MIN_PEOPLE) and a pressure threshold (PRESSURE_HIGH); see
--         the classification below. {NS}, {MIN_PEOPLE} and {PRESSURE_HIGH} are replaced by
--         databricks/demand.mjs.
create or replace table {NS}.demand_gaps as
with asof as (select max(service_date) as as_of from {NS}.service),
ungrouped as (
  select m.person_id, m.life_stage, m.available_slots, p.gender, h.lat_approx lat, h.lng_approx lng, f.busy_slots
  from {NS}.member_profile m
  join {NS}.person p on p.person_id = m.person_id and p.household_role = 'adult'
  join {NS}.household h on h.household_id = p.household_id
  join {NS}.person_features f on f.person_id = m.person_id
  where m.opted_in_at is not null
    and m.life_stage is not null
    and not exists (select 1 from {NS}.group_membership gm where gm.person_id = m.person_id and gm.status = 'active')
),
demand as (
  select person_id, life_stage, gender, lat, lng, slot as available_slot
  from (select u.*, explode(u.available_slots) as slot from ungrouped u)
  where not array_contains(busy_slots, slot)
),
active_counts as (
  select group_id, count(*) as active_members from {NS}.group_membership where status = 'active' group by group_id
),
open_groups as (
  select g.group_id, g.meeting_slot, g.life_stage_focus, g.gender_focus, g.is_online, g.lat_approx, g.lng_approx,
         g.capacity_max - coalesce(a.active_members, 0) as open_seats
  from {NS}.grp g left join active_counts a on a.group_id = g.group_id
  where g.status in ('open', 'forming') and g.capacity_max - coalesce(a.active_members, 0) > 0
),
-- one row per (person, slot, compatible open group), with the app's per-person hard filters
pairs as (
  select d.person_id, d.life_stage, d.available_slot, g.group_id,
    (g.gender_focus is null or g.gender_focus in ('mixed', 'couples')
       or (g.gender_focus = 'men' and d.gender = 'M') or (g.gender_focus = 'women' and d.gender = 'F')) as gender_ok,
    (g.is_online or 7917.5 * asin(sqrt(0.5 - cos(radians(g.lat_approx - d.lat)) / 2
        + cos(radians(d.lat)) * cos(radians(g.lat_approx)) * (1 - cos(radians(g.lng_approx - d.lng))) / 2)) <= 5) as near_ok
  from demand d
  join open_groups g on g.meeting_slot = d.available_slot and (g.life_stage_focus is null or g.life_stage_focus = d.life_stage)
),
person_reach as (
  select person_id, life_stage, available_slot,
    count(*) as any_group,
    sum(case when gender_ok and near_ok then 1 else 0 end) as reachable_groups
  from pairs group by person_id, life_stage, available_slot
),
cohort_demand as (
  select life_stage, available_slot, count(*) as opted_in_ungrouped_count from demand group by life_stage, available_slot
),
cohort_supply as (
  select c.life_stage, c.available_slot,
         count(g.group_id) as serving_group_count, coalesce(sum(g.open_seats), 0) as available_seat_count
  from cohort_demand c
  left join open_groups g on g.meeting_slot = c.available_slot and (g.life_stage_focus is null or g.life_stage_focus = c.life_stage)
  group by c.life_stage, c.available_slot
),
cohort_reach as (
  select c.life_stage, c.available_slot,
    sum(case when r.person_id is null then 1 else 0 end) as people_without_group_in_catalog,
    sum(case when r.person_id is null or r.reachable_groups = 0 then 1 else 0 end) as people_without_reachable_group
  from (select * from demand) c
  left join person_reach r on r.person_id = c.person_id and r.available_slot = c.available_slot and r.life_stage = c.life_stage
  group by c.life_stage, c.available_slot
)
, scored as (
select
  d.life_stage,
  d.available_slot,
  cast(d.opted_in_ungrouped_count as int) as opted_in_ungrouped_count,
  cast(s.serving_group_count as int) as serving_group_count,
  cast(s.available_seat_count as int) as available_seat_count,
  case when s.available_seat_count > 0 then cast(round(d.opted_in_ungrouped_count / cast(s.available_seat_count as double), 2) as decimal(8, 2)) end as people_per_open_seat,
  cast(r.people_without_group_in_catalog as int) as people_without_group_in_catalog,
  cast(r.people_without_reachable_group as int) as people_without_reachable_group,
  case
    when d.opted_in_ungrouped_count < {MIN_PEOPLE} then 'Not a gap'
    when s.serving_group_count = 0 then 'No current group'
    when d.opted_in_ungrouped_count / cast(s.available_seat_count as double) >= {PRESSURE_HIGH} then 'High demand'
    when r.people_without_reachable_group >= {MIN_PEOPLE} and r.people_without_reachable_group / cast(d.opted_in_ungrouped_count as double) >= 0.5 then 'Limited reach'
    else 'Served'
  end as gap_classification,
  (select as_of from asof) as as_of_date,
  current_timestamp() as computed_at
from cohort_demand d
join cohort_supply s on s.life_stage = d.life_stage and s.available_slot = d.available_slot
join cohort_reach r on r.life_stage = d.life_stage and r.available_slot = d.available_slot
)
select scored.*,
  case when gap_classification in ('No current group', 'High demand', 'Limited reach')
    then row_number() over (partition by gap_classification in ('No current group', 'High demand', 'Limited reach')
      order by people_without_reachable_group desc, opted_in_ungrouped_count desc, life_stage, available_slot) end as gap_rank
from scored
