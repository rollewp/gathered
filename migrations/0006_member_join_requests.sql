-- Gathered: Journey 1 member join requests. Run as DATABASE_OWNER_URL via scripts/migrate.mjs,
-- after 0005.
--
-- 0002 let any member INSERT a join_request directly (policy: person_id = own), which also let
-- them choose the status ('accepted'), skip the duplicate check and bypass the audit row. The
-- member's write is now a single SECURITY DEFINER function that enforces the rules in the
-- database (architecture W4, §4):
--   * only an opted-in member with no active group membership can ask to join
--   * the group must be open or forming, have a seat, and be compatible with the member's gender
--     focus rule
--   * at most one open (status 'requested') request per member and group, enforced by a partial
--     unique index so concurrent submissions cannot create duplicates
--   * the status is always 'requested'; rec_id links the recommendation row when the group is in
--     the member's current run
--   * one audit_log row per request (never the note text)
-- Creating a request is not a material change for recommendations (architecture §6.3).

-- gathered_app no longer inserts join_request directly. Leader/manager decisions still UPDATE it.
revoke insert on app.join_request from gathered_app;

create unique index join_request_one_open on app.join_request (person_id, group_id) where status = 'requested';

create function app.request_to_join(p_group_id uuid, p_member_note text default null)
returns uuid
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_person   uuid := app._person();
    v_note     text := nullif(btrim(p_member_note), '');
    v_group    app.grp%rowtype;
    v_gender   text;
    v_active   int;
    v_rec      uuid;
    v_request  uuid := gen_random_uuid();
begin
    if v_person is null
       or not exists (select 1 from app.member_profile mp where mp.person_id = v_person)
       or exists (select 1 from app.group_membership gm where gm.person_id = v_person and gm.status = 'active') then
        raise exception 'not_eligible';
    end if;
    if v_note is not null and char_length(v_note) > 500 then
        raise exception 'note_too_long';
    end if;

    select * into v_group from app.grp g where g.group_id = p_group_id;
    if not found then raise exception 'group_unavailable'; end if;

    select count(*)::int into v_active from app.group_membership gm where gm.group_id = p_group_id and gm.status = 'active';
    select p.gender into v_gender from app.person p where p.person_id = v_person;
    if v_group.status not in ('open', 'forming')
       or v_active >= v_group.capacity_max
       or (v_group.gender_focus = 'men' and v_gender is distinct from 'M')
       or (v_group.gender_focus = 'women' and v_gender is distinct from 'F') then
        raise exception 'group_unavailable';
    end if;

    if exists (select 1 from app.join_request jr
               where jr.person_id = v_person and jr.group_id = p_group_id and jr.status = 'requested') then
        raise exception 'duplicate_request';
    end if;

    select r.rec_id into v_rec
    from app.recommendation r
    join app.recommendation_run run on run.run_id = r.run_id
    where run.person_id = v_person and run.is_current and r.group_id = p_group_id;

    begin
        insert into app.join_request (request_id, person_id, group_id, rec_id, status, member_note, requested_at)
        values (v_request, v_person, p_group_id, v_rec, 'requested', v_note, now());
    exception when unique_violation then
        raise exception 'duplicate_request';
    end;

    insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
    values ((select pu.user_id from app.portal_user pu where pu.person_id = v_person),
            'join_request_created', 'join_request', v_request,
            jsonb_build_object('group_id', p_group_id, 'from_recommendation', v_rec is not null,
                               'note_provided', v_note is not null));
    return v_request;
end;
$$;
revoke all on function app.request_to_join(uuid, text) from public;
grant execute on function app.request_to_join(uuid, text) to gathered_app;

-- The caller's own requests, with the leader's first name for "<Leader> will reach out if it's a
-- fit". The leader's first name is the only thing added to what the member could already read
-- from their own join_request rows.
create function app.my_join_requests()
returns table (request_id uuid, group_id uuid, status text, member_note text, requested_at timestamptz, leader_first_name text)
language sql stable security definer set search_path = app, pg_temp
as $$
    select jr.request_id, jr.group_id, jr.status, jr.member_note, jr.requested_at,
           (select p.first_name
            from app.group_leader gl join app.person p on p.person_id = gl.person_id
            where gl.group_id = jr.group_id
            order by gl.start_on asc nulls last, p.person_id
            limit 1)
    from app.join_request jr
    where jr.person_id = app._person()
    order by jr.requested_at desc
$$;
revoke all on function app.my_join_requests() from public;
grant execute on function app.my_join_requests() to gathered_app;
