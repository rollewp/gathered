-- Gathered: person_features derivation in Databricks (architecture §3b).
-- A direct translation of lib/features/person-features.mjs (the reference contract). No new
-- definitions. {NS} is replaced with the catalog.schema namespace by databricks/features.mjs.
--
--   as_of                the latest service date (derived from the data, no clock)
--   week index           floor(days between as_of and the service date / 7); the last 12 weeks are 0..11
--   signal               a kiosk row counts for the adult in checked_in_by; a livestream row counts for
--                        the person at 20+ minutes watched; any other channel counts for person_id
--   observed_weeks_12w   distinct weeks in 0..11 with a signal
--   attendance_rate_12w  observed / 12            (rounded to 4 places)
--   consistency_score    longest run of consecutive observed weeks / 12   (4 places)
--   online_share_12w     livestream weeks / observed weeks, null if none observed   (4 places)
--   signal_confidence    high / medium / low as in the reference
--   busy_slots           every schedule_slot the person is assigned to serve (sorted set)
--   serving_areas        the areas of those ministries (sorted set)
--   kids_age_bands       age bands (0-4, 5-12, 13-18) of the children in the person's household
--   tenure_months        whole months from first_attended_on to as_of
--   last_attended_on     the latest signal date (any week)
create or replace table {NS}.person_features as
with asof as (
  select max(service_date) as as_of from {NS}.service
),
sig as (
  select
    case e.channel
      when 'kiosk' then e.checked_in_by
      when 'livestream' then case when e.minutes_watched >= 20 then e.person_id end
      else e.person_id
    end as adult_id,
    e.channel,
    s.service_date as date,
    datediff(a.as_of, s.service_date) div 7 as week
  from {NS}.attendance_event e
  join {NS}.service s on s.service_id = e.service_id
  cross join asof a
),
sig_valid as (select * from sig where adult_id is not null),
in12 as (select * from sig_valid where week >= 0 and week < 12),
weeks as (select distinct adult_id, week from in12),
islands as (
  select adult_id, week - row_number() over (partition by adult_id order by week) as island
  from weeks
),
streaks as (
  select adult_id, max(n) as best from (select adult_id, island, count(*) as n from islands group by adult_id, island) group by adult_id
),
agg as (
  select
    adult_id,
    count(distinct week) as observed_weeks,
    count(distinct case when channel = 'livestream' then week end) as live_weeks,
    sort_array(collect_set(channel)) as sources,
    max(case when week < 8 and channel in ('kiosk', 'app_geofence') then 1 else 0 end) as strong8,
    max(case when week < 8 and channel = 'serving_roster' then 1 else 0 end) as roster8,
    max(case when channel in ('livestream', 'serving_roster') then 1 else 0 end) as medium12
  from in12 group by adult_id
),
last_signal as (select adult_id, max(date) as last_attended_on from sig_valid group by adult_id),
serving as (
  select
    sa.person_id,
    sort_array(collect_set(sa.schedule_slot)) as busy_slots,
    sort_array(collect_set(m.area)) as serving_areas,
    max(case when sa.frequency = 'weekly' then 1 else 0 end) as weekly_server
  from {NS}.serving_assignment sa
  left join {NS}.ministry m on m.ministry_id = sa.ministry_id
  group by sa.person_id
),
kids as (
  select c.household_id,
    sort_array(collect_set(
      case when year(a.as_of) - c.birth_year between 0 and 4 then '0-4'
           when year(a.as_of) - c.birth_year between 5 and 12 then '5-12'
           when year(a.as_of) - c.birth_year between 13 and 18 then '13-18' end)) as bands
  from {NS}.person c cross join asof a
  where c.household_role = 'child'
  group by c.household_id
)
select
  p.person_id,
  cast(coalesce(g.observed_weeks, 0) as int) as observed_weeks_12w,
  cast(round(coalesce(g.observed_weeks, 0) / 12.0, 4) as decimal(5, 4)) as attendance_rate_12w,
  coalesce(g.sources, cast(array() as array<string>)) as signal_sources,
  case
    when coalesce(g.strong8, 0) = 1 or (coalesce(sv.weekly_server, 0) = 1 and coalesce(g.roster8, 0) = 1) then 'high'
    when coalesce(g.medium12, 0) = 1 then 'medium'
    else 'low'
  end as signal_confidence,
  case when coalesce(g.observed_weeks, 0) > 0
       then cast(round(g.live_weeks / cast(g.observed_weeks as double), 4) as decimal(5, 4)) end as online_share_12w,
  cast(round(coalesce(st.best, 0) / 12.0, 4) as decimal(5, 4)) as consistency_score,
  coalesce(sv.busy_slots, cast(array() as array<string>)) as busy_slots,
  coalesce(sv.serving_areas, cast(array() as array<string>)) as serving_areas,
  coalesce(k.bands, cast(array() as array<string>)) as kids_age_bands,
  case when p.first_attended_on is not null then cast(
    (year(a.as_of) - year(p.first_attended_on)) * 12 + (month(a.as_of) - month(p.first_attended_on))
    - case when day(a.as_of) < day(p.first_attended_on) then 1 else 0 end as int) end as tenure_months,
  ls.last_attended_on,
  current_timestamp() as computed_at
from {NS}.person p
cross join asof a
left join agg g on g.adult_id = p.person_id
left join streaks st on st.adult_id = p.person_id
left join last_signal ls on ls.adult_id = p.person_id
left join serving sv on sv.person_id = p.person_id
left join kids k on k.household_id = p.household_id
where p.household_role = 'adult'
