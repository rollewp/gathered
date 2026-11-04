-- Gathered: row-level security + grants for gathered_app. Run as DATABASE_OWNER_URL via
-- scripts/migrate.mjs, after 0001_app_schema.sql.
--
-- Session context (set per-request inside a transaction, per W5 and the spike convention):
--   select set_config('app.role', '<member|leader|manager>', true);
--   select set_config('app.person_id', '<uuid>', true);
--
-- Tables are ENABLE'd but never FORCE'd: gathered_app is a grantee, not the table owner, so it
-- is already fully subject to RLS. FORCE would also bind the owner role, which needs to keep
-- bypassing RLS so the SECURITY DEFINER functions in 0003 can see everything regardless of
-- who's calling them.

create function app._role() returns text language sql stable as $$
    select current_setting('app.role', true)
$$;

create function app._person() returns uuid language sql stable as $$
    select nullif(current_setting('app.person_id', true), '')::uuid
$$;

revoke all on function app._role() from public;
revoke all on function app._person() from public;
grant execute on function app._role() to gathered_app;
grant execute on function app._person() to gathered_app;

grant usage on schema app to gathered_app;

-- ---------------------------------------------------------------- household

alter table app.household enable row level security;

create policy select_household on app.household for select using (
    app._role() = 'manager'
    or exists (select 1 from app.person p
               where p.person_id = app._person() and p.household_id = household.household_id)
);

grant select on app.household to gathered_app;

-- ---------------------------------------------------------------- person

alter table app.person enable row level security;

create policy select_person on app.person for select using (
    app._role() = 'manager'
    or person_id = app._person()
    or exists (select 1 from app.group_membership gm
               join app.group_leader gl on gl.group_id = gm.group_id
               where gm.person_id = person.person_id and gm.status = 'active'
                 and gl.person_id = app._person())
    or exists (select 1 from app.join_request jr
               join app.group_leader gl on gl.group_id = jr.group_id
               where jr.person_id = person.person_id and jr.status = 'requested'
                 and gl.person_id = app._person())
);

grant select on app.person to gathered_app;

-- ---------------------------------------------------------------- member_profile
-- Leaders get no access here, ever -- not even for a pending requester. W10: the rationale
-- (which can reference about_me content) must never reach a leader. The leader-facing "profile
-- summary" is person (name) + join_request.member_note, both covered elsewhere.

alter table app.member_profile enable row level security;

create policy select_member_profile on app.member_profile for select using (
    app._role() = 'manager' or person_id = app._person()
);
create policy insert_member_profile on app.member_profile for insert with check (
    person_id = app._person()
);
create policy update_member_profile on app.member_profile for update using (
    person_id = app._person()
) with check (
    person_id = app._person()
);

grant select, insert, update on app.member_profile to gathered_app;

-- ---------------------------------------------------------------- portal_user

alter table app.portal_user enable row level security;

create policy select_portal_user on app.portal_user for select using (
    app._role() = 'manager' or person_id = app._person()
);

grant select on app.portal_user to gathered_app;

-- ---------------------------------------------------------------- person_features (manager only)

alter table app.person_features enable row level security;

create policy select_person_features on app.person_features for select using (
    app._role() = 'manager'
);

grant select on app.person_features to gathered_app;

-- ---------------------------------------------------------------- grp / group_tag (public card data)

alter table app.grp enable row level security;
alter table app.group_tag enable row level security;

create policy select_grp on app.grp for select using (true);
create policy select_group_tag on app.group_tag for select using (true);

-- Column-level grant: no lat_approx/lng_approx. The doc is explicit that members see a named
-- area, never coordinates/address. app.group_card() in 0003 is how the app actually reads group
-- cards (including a derived area label) without ever exposing raw coordinates to gathered_app.
grant select (group_id, name, description, gender_focus, life_stage_focus, meeting_slot,
              frequency, is_online, capacity_min, capacity_max, childcare, status)
    on app.grp to gathered_app;
grant select on app.group_tag to gathered_app;

-- ---------------------------------------------------------------- group_leader

alter table app.group_leader enable row level security;

create policy select_group_leader on app.group_leader for select using (
    app._role() = 'manager' or person_id = app._person()
);

grant select on app.group_leader to gathered_app;

-- ---------------------------------------------------------------- group_membership

alter table app.group_membership enable row level security;

create policy select_group_membership on app.group_membership for select using (
    app._role() = 'manager'
    or person_id = app._person()
    or exists (select 1 from app.group_leader gl
               where gl.group_id = group_membership.group_id and gl.person_id = app._person())
);
create policy insert_group_membership on app.group_membership for insert with check (
    app._role() = 'manager'
    or exists (select 1 from app.group_leader gl
               where gl.group_id = group_membership.group_id and gl.person_id = app._person())
);

grant select, insert on app.group_membership to gathered_app;

-- ---------------------------------------------------------------- group_meeting / meeting_attendance

alter table app.group_meeting enable row level security;
alter table app.meeting_attendance enable row level security;

create policy select_group_meeting on app.group_meeting for select using (
    app._role() = 'manager'
    or exists (select 1 from app.group_leader gl
               where gl.group_id = group_meeting.group_id and gl.person_id = app._person())
);
create policy select_meeting_attendance on app.meeting_attendance for select using (
    app._role() = 'manager'
    or exists (select 1 from app.group_meeting gm
               join app.group_leader gl on gl.group_id = gm.group_id
               where gm.meeting_id = meeting_attendance.meeting_id and gl.person_id = app._person())
);

grant select on app.group_meeting to gathered_app;
grant select on app.meeting_attendance to gathered_app;

-- ---------------------------------------------------------------- recommendation
-- Column-level grant: no score_breakdown/internal_rationale via the base table for anyone,
-- manager included -- app.manager_recommendation_audit() in 0003 is the only route to those two
-- columns, and it checks app.role itself. INSERT stays full-table: the live matching call still
-- needs to write score_breakdown/internal_rationale, it just can't read them back directly.

alter table app.recommendation enable row level security;

create policy select_recommendation on app.recommendation for select using (
    app._role() = 'manager' or person_id = app._person()
);
create policy insert_recommendation on app.recommendation for insert with check (
    app._role() = 'manager'
    or (app._role() in ('member','leader') and person_id = app._person())
);

grant select (rec_id, person_id, group_id, rank, score, model, prompt_version, generated_at)
    on app.recommendation to gathered_app;
grant insert on app.recommendation to gathered_app;

-- ---------------------------------------------------------------- join_request

alter table app.join_request enable row level security;

create policy select_join_request on app.join_request for select using (
    app._role() = 'manager'
    or person_id = app._person()
    or exists (select 1 from app.group_leader gl
               where gl.group_id = join_request.group_id and gl.person_id = app._person())
);
create policy insert_join_request on app.join_request for insert with check (
    app._role() = 'manager' or person_id = app._person()
);
create policy update_join_request on app.join_request for update using (
    app._role() = 'manager'
    or exists (select 1 from app.group_leader gl
               where gl.group_id = join_request.group_id and gl.person_id = app._person())
) with check (
    app._role() = 'manager'
    or exists (select 1 from app.group_leader gl
               where gl.group_id = join_request.group_id and gl.person_id = app._person())
);

grant select, insert, update on app.join_request to gathered_app;

-- ---------------------------------------------------------------- escalation
-- Insert is open to any role (rule/AI review calls land here) but must claim a real source and
-- always start open; only a manager can move it to acknowledged/resolved.

alter table app.escalation enable row level security;

create policy select_escalation on app.escalation for select using (
    app._role() = 'manager'
    or exists (select 1 from app.group_leader gl
               where gl.group_id = escalation.group_id and gl.person_id = app._person())
);
create policy insert_escalation on app.escalation for insert with check (
    source in ('rule','ai') and status = 'open'
);
create policy update_escalation on app.escalation for update using (
    app._role() = 'manager'
) with check (
    app._role() = 'manager'
);

grant select, insert, update on app.escalation to gathered_app;

-- ---------------------------------------------------------------- audit_log
-- Append-only: insert for every role (every action logs itself), select for manager only, no
-- update/delete policy at all.

alter table app.audit_log enable row level security;

create policy select_audit_log on app.audit_log for select using (
    app._role() = 'manager'
);
create policy insert_audit_log on app.audit_log for insert with check (true);

grant select, insert on app.audit_log to gathered_app;
