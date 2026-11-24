-- Gathered: analytical serving table + the scoped Databricks refresh role.
--
-- 1. app.demand_gap: the small result of the Databricks demand-gap analytics (one row per
--    life-stage / available-slot cohort). Aggregates only: no person ids, names or details.
--    gathered_app may only read it, and only as the Manager (RLS); the refresh role may write it.
-- 2. gathered_refresh: the Postgres role the scheduled Databricks job connects as. It is created
--    through the Lakebase roles API (native password, no membership roles, no BYPASSRLS) and its
--    password lives only in a Databricks secret scope. It can touch ONLY app.person_features and
--    app.demand_gap. It cannot read or write people, profiles, groups, requests, runs, escalations
--    or the audit log. The existing invalidation triggers on person_features are SECURITY DEFINER,
--    so a material feature change still invalidates recommendation runs exactly as before.

create table app.demand_gap (
    life_stage                       text not null check (life_stage in
                                      ('single','married_no_kids','young_kids','school_age_kids','teens','empty_nest','retired')),
    available_slot                   text not null,
    opted_in_ungrouped_count         int  not null,
    serving_group_count              int  not null,
    available_seat_count             int  not null,
    people_per_open_seat             numeric,
    people_without_group_in_catalog  int  not null,
    people_without_reachable_group   int  not null,
    gap_classification               text not null check (gap_classification in
                                      ('No current group','High demand','Limited reach','Served','Not a gap')),
    gap_rank                         int,
    as_of_date                       date,
    computed_at                      timestamptz not null,
    primary key (life_stage, available_slot)
);

alter table app.demand_gap enable row level security;

create policy select_demand_gap on app.demand_gap for select to gathered_app using (
    app._role() = 'manager'
);
grant select on app.demand_gap to gathered_app;

-- refresh role: schema access, the two tables, nothing else
grant usage on schema app to gathered_refresh;

grant select, insert, update on app.person_features to gathered_refresh;
create policy refresh_select_person_features on app.person_features for select to gathered_refresh using (true);
create policy refresh_insert_person_features on app.person_features for insert to gathered_refresh with check (true);
create policy refresh_update_person_features on app.person_features for update to gathered_refresh using (true) with check (true);

grant select, insert, update, delete on app.demand_gap to gathered_refresh;
create policy refresh_all_demand_gap on app.demand_gap for all to gathered_refresh using (true) with check (true);
