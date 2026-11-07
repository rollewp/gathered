-- Gathered: Slice 1 recommendation lifecycle (architecture W14-W17, §5, §6). Run as
-- DATABASE_OWNER_URL via scripts/migrate.mjs, after 0003.
--
-- What this does:
--   * replaces the single-table app.recommendation with a first-class run:
--       recommendation_run             one generation event per member (current/invalid state,
--                                      provenance, Manager-only rationale)
--       recommendation_run_candidate   the complete deterministic shortlist of the run
--       recommendation                 the ordered result (run, person, group, rank only)
--   * app.recommendation_shortlist()   the deterministic stage (hard filters + weighted score)
--   * app.current_recommendation_run() reuse lookup + lazy prompt-version invalidation
--   * app.persist_recommendation_run() the only writer of runs
--   * triggers that invalidate affected current runs on matching-relevant changes
--   * app.manager_recommendation_audit() rewritten for runs
--
-- Safe as a forward migration: the old app.recommendation was never populated (the seed CSV is
-- header-only), which the guard below verifies before dropping it.

do $$
begin
    if exists (select 1 from app.recommendation) then
        raise exception '0004 expects an empty app.recommendation; reseed before migrating';
    end if;
    if exists (select 1 from app.join_request where rec_id is not null) then
        raise exception '0004 expects join_request.rec_id to be null everywhere';
    end if;
end $$;

drop function if exists app.manager_recommendation_audit(uuid, uuid);
alter table app.join_request drop constraint if exists join_request_rec_id_fkey;
drop table app.recommendation;

-- ---------------------------------------------------------------- tables

create table app.recommendation_run (
    run_id               uuid primary key default gen_random_uuid(),
    person_id             uuid not null references app.person(person_id),
    is_current            boolean not null default true,
    generated_at          timestamptz not null default now(),
    invalidated_at        timestamptz,
    invalidation_reason   text check (invalidation_reason in (
        'profile_changed', 'person_features_changed', 'membership_changed', 'group_added',
        'group_changed', 'group_tags_changed', 'group_leader_changed', 'location_changed',
        'prompt_version_changed', 'superseded')),
    invalidation_detail   jsonb,
    outcome               text not null check (outcome in ('llm', 'llm_after_retry', 'score_fallback', 'no_candidates')),
    model                 text,
    prompt_version        text,
    confidence            text check (confidence in ('high', 'medium', 'low')),
    internal_rationale    text,  -- W10: Manager-audit only
    llm_usage             jsonb, -- aggregate tokens/latency/attempts; per-attempt rows live in audit_log
    check ((invalidated_at is null) = (invalidation_reason is null)),
    check (is_current = (invalidated_at is null)),
    check (outcome <> 'no_candidates'
           or (model is null and prompt_version is null and confidence is null and internal_rationale is null)),
    unique (run_id, person_id)
);
-- At most one current run per member.
create unique index recommendation_run_one_current on app.recommendation_run (person_id) where is_current;
create index on app.recommendation_run (person_id, generated_at desc);

create table app.recommendation_run_candidate (
    run_id               uuid not null references app.recommendation_run(run_id),
    group_id              uuid not null references app.grp(group_id),
    shortlist_position    int not null check (shortlist_position between 1 and 6),
    score                 numeric not null,
    score_breakdown       jsonb not null,
    primary key (run_id, group_id),
    unique (run_id, shortlist_position)
);
-- Invalidation finds every run that shortlisted a changed group.
create index on app.recommendation_run_candidate (group_id, run_id);

create table app.recommendation (
    rec_id       uuid primary key default gen_random_uuid(),
    run_id        uuid not null,
    person_id      uuid not null,
    group_id       uuid not null,
    rank           int not null check (rank between 1 and 3),
    unique (run_id, rank),
    unique (run_id, group_id),
    foreign key (run_id, person_id) references app.recommendation_run(run_id, person_id),
    -- the database itself enforces that a recommended group was on the run's shortlist
    foreign key (run_id, group_id) references app.recommendation_run_candidate(run_id, group_id)
);
create index on app.recommendation (person_id);

alter table app.join_request
    add constraint join_request_rec_id_fkey foreign key (rec_id) references app.recommendation(rec_id);

-- ---------------------------------------------------------------- RLS and grants
-- Nobody writes these tables directly: runs are written by app.persist_recommendation_run() and
-- invalidated by the triggers below, all SECURITY DEFINER. Members read the ordered groups of
-- their current run and nothing else. Score, breakdown, shortlist, rationale and provenance have
-- no grant for gathered_app, so they are unreadable by every persona; the Manager reads them
-- through app.manager_recommendation_audit() (W3, W10).

alter table app.recommendation_run enable row level security;
alter table app.recommendation_run_candidate enable row level security;
alter table app.recommendation enable row level security;

create policy select_recommendation_run on app.recommendation_run for select using (
    app._role() = 'manager' or (person_id = app._person() and is_current)
);
create policy select_recommendation on app.recommendation for select using (
    app._role() = 'manager'
    or (person_id = app._person()
        and exists (select 1 from app.recommendation_run r
                    where r.run_id = recommendation.run_id and r.is_current))
);
-- recommendation_run_candidate: RLS enabled, deliberately no policy and no grant.

grant select (run_id, person_id, is_current, generated_at) on app.recommendation_run to gathered_app;
grant select on app.recommendation to gathered_app;

-- ---------------------------------------------------------------- helpers

create function app._miles(lat1 double precision, lng1 double precision, lat2 double precision, lng2 double precision)
returns double precision language sql immutable as $$
    select 7917.5 * asin(sqrt(
        0.5 - cos(radians(lat2 - lat1)) / 2
        + cos(radians(lat1)) * cos(radians(lat2)) * (1 - cos(radians(lng2 - lng1))) / 2))
$$;
revoke all on function app._miles(double precision, double precision, double precision, double precision) from public;
grant execute on function app._miles(double precision, double precision, double precision, double precision) to gathered_app;

-- The single internal path that flips runs to invalid. Callable only from the SECURITY DEFINER
-- functions and triggers in this file (owner rights); gathered_app has no execute grant.
create function app._invalidate_runs(
    p_reason text, p_detail jsonb,
    p_person_ids uuid[] default null, p_group_ids uuid[] default null, p_all boolean default false)
returns int
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_count int;
begin
    update app.recommendation_run r
       set is_current = false, invalidated_at = now(),
           invalidation_reason = p_reason, invalidation_detail = p_detail
     where r.is_current
       and (p_all
            or r.person_id = any (coalesce(p_person_ids, '{}'))
            or exists (select 1 from app.recommendation_run_candidate c
                       where c.run_id = r.run_id and c.group_id = any (coalesce(p_group_ids, '{}'))));
    get diagnostics v_count = row_count;
    return v_count;
end;
$$;
revoke all on function app._invalidate_runs(text, jsonb, uuid[], uuid[], boolean) from public;

-- ---------------------------------------------------------------- deterministic stage
-- Hard filters (§5.2), weighted score (§5.3), shortlist of up to 6 (§5.4), for the calling
-- member. Returns nothing unless the caller is eligible (§5.1: opted-in, no active membership).
-- Mirrors lib/ranking/reference-shortlist.mjs; scripts/test_recommendations.mjs fails on any
-- difference. Consistency is neutral (7.5) until Databricks parity (architecture §3b).

create function app.recommendation_shortlist()
returns table (
    shortlist_position  int,
    group_id            uuid,
    name                text,
    description         text,
    tags                text[],
    meeting_slot        text,
    gender_focus        text,
    life_stage_focus    text,
    childcare           boolean,
    is_online           boolean,
    status              text,
    open_seats          int,
    group_mix           jsonb,
    score               numeric,
    score_breakdown     jsonb
)
language sql stable security definer set search_path = app, pg_temp
as $$
    with me as (
        select p.person_id, p.gender,
               h.lat_approx::double precision as lat, h.lng_approx::double precision as lng,
               mp.life_stage, mp.available_slots, mp.interests,
               coalesce(pf.busy_slots, '{}') as busy,
               coalesce(pf.serving_areas, '{}') as areas,
               coalesce(pf.kids_age_bands, '{}') as bands
        from app.person p
        join app.household h on h.household_id = p.household_id
        join app.member_profile mp on mp.person_id = p.person_id
        left join app.person_features pf on pf.person_id = p.person_id
        where p.person_id = app._person()
          and not exists (select 1 from app.group_membership gm
                          where gm.person_id = p.person_id and gm.status = 'active')
    ),
    cand as (
        select g.group_id, g.name, g.description, g.meeting_slot, g.gender_focus, g.life_stage_focus,
               g.childcare, g.is_online, g.status, g.capacity_max,
               me.life_stage as m_life_stage, me.interests as m_interests,
               me.areas as m_areas, me.bands as m_bands,
               (select count(*) from app.group_membership gm
                 where gm.group_id = g.group_id and gm.status = 'active')::int as n_active,
               case when g.is_online then null
                    else app._miles(me.lat, me.lng, g.lat_approx::double precision, g.lng_approx::double precision)
               end as dist
        from app.grp g
        cross join me
        where g.status in ('open', 'forming')
          and (select count(*) from app.group_membership gm
                where gm.group_id = g.group_id and gm.status = 'active') < g.capacity_max
          and (g.gender_focus is distinct from 'men' or me.gender = 'M')
          and (g.gender_focus is distinct from 'women' or me.gender = 'F')
          and g.meeting_slot = any (me.available_slots)
          and not (g.meeting_slot = any (me.busy))
          and (g.is_online
               or app._miles(me.lat, me.lng, g.lat_approx::double precision, g.lng_approx::double precision) <= 5)
    ),
    scored as (
        select c.*,
            case when c.life_stage_focus is not null
                 then (case when c.m_life_stage = c.life_stage_focus then 30 else 0 end)::double precision
                 else (select case when count(*) = 0 then 15::double precision
                                   else round(30.0 * count(*) filter (where mp2.life_stage = c.m_life_stage) / count(*))::double precision
                              end
                       from app.group_membership gm
                       join app.member_profile mp2 on mp2.person_id = gm.person_id
                       where gm.group_id = c.group_id and gm.status = 'active')
            end as s_life,
            (case when exists (select 1 from app.group_membership gm
                               join app.person_features pf on pf.person_id = gm.person_id
                               where gm.group_id = c.group_id and gm.status = 'active'
                                 and pf.kids_age_bands && c.m_bands)
                  then 20 else 0 end)::double precision as s_kids,
            (case when exists (select 1
                               from (select gm.person_id from app.group_membership gm
                                      where gm.group_id = c.group_id and gm.status = 'active'
                                     union
                                     select gl.person_id from app.group_leader gl where gl.group_id = c.group_id) x
                               join app.person_features pf on pf.person_id = x.person_id
                               where pf.serving_areas && c.m_areas)
                  then 15 else 0 end)::double precision as s_serv,
            7.5::double precision as s_cons,
            (case when exists (select 1 from app.group_tag t
                               where t.group_id = c.group_id and t.tag = any (c.m_interests))
                  then 10 else 0 end)::double precision as s_int,
            (case when c.is_online then 5 else greatest(0, 10 * (1 - c.dist / 5)) end)::double precision as s_dist
        from cand c
    ),
    ranked as (
        select s.*,
               (s.s_life + s.s_kids + s.s_serv + s.s_cons + s.s_int + s.s_dist) as total,
               row_number() over (
                   order by (s.s_life + s.s_kids + s.s_serv + s.s_cons + s.s_int + s.s_dist) desc,
                            s.dist asc nulls last,
                            s.group_id) as pos
        from scored s
    )
    select r.pos::int,
           r.group_id, r.name, r.description,
           coalesce((select array_agg(t.tag order by t.tag) from app.group_tag t where t.group_id = r.group_id), '{}'),
           r.meeting_slot, r.gender_focus, r.life_stage_focus, r.childcare, r.is_online, r.status,
           greatest(0, r.capacity_max - r.n_active),
           coalesce((select jsonb_object_agg(x.stage, x.cnt)
                     from (select mp2.life_stage as stage, count(*) as cnt
                           from app.group_membership gm
                           join app.member_profile mp2 on mp2.person_id = gm.person_id
                           where gm.group_id = r.group_id and gm.status = 'active' and mp2.life_stage is not null
                           group by mp2.life_stage) x), '{}'::jsonb),
           round(r.total::numeric, 4),
           jsonb_build_object('life_stage', r.s_life, 'kids_age', r.s_kids, 'serving_area', r.s_serv,
                              'consistency', r.s_cons, 'interests', r.s_int,
                              'distance', round(r.s_dist::numeric, 4))
    from ranked r
    where r.pos <= 6
    order by r.pos
$$;
revoke all on function app.recommendation_shortlist() from public;
grant execute on function app.recommendation_shortlist() to gathered_app;

-- ---------------------------------------------------------------- reuse lookup

-- State for the calling member: no_profile | in_group | none | current. A current run made under
-- a different ranking prompt version is invalidated here (lazily, with no LLM call) and reported
-- as none. Runs with a null prompt version (empty runs) involve no ranking and are never stale.
create function app.current_recommendation_run(p_prompt_version text)
returns table (out_state text, out_run_id uuid)
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_person uuid := app._person();
    v_run    app.recommendation_run%rowtype;
begin
    if v_person is null or not exists (select 1 from app.member_profile mp where mp.person_id = v_person) then
        return query select 'no_profile'::text, null::uuid; return;
    end if;
    if exists (select 1 from app.group_membership gm where gm.person_id = v_person and gm.status = 'active') then
        return query select 'in_group'::text, null::uuid; return;
    end if;

    select * into v_run from app.recommendation_run r where r.person_id = v_person and r.is_current;
    if not found then
        return query select 'none'::text, null::uuid; return;
    end if;
    if v_run.prompt_version is not null and v_run.prompt_version is distinct from p_prompt_version then
        perform app._invalidate_runs('prompt_version_changed',
            jsonb_build_object('from', v_run.prompt_version, 'to', p_prompt_version), array[v_person]);
        return query select 'none'::text, null::uuid; return;
    end if;
    return query select 'current'::text, v_run.run_id;
end;
$$;
revoke all on function app.current_recommendation_run(text) from public;
grant execute on function app.current_recommendation_run(text) to gathered_app;

-- ---------------------------------------------------------------- the only writer of runs

-- The caller passes the shortlist group IDs the ranking saw and the ordered ranked IDs. Under a
-- per-member lock the database recomputes the shortlist, rejects the write if it changed
-- (shortlist_changed) or if the ranking is not a valid ordered subset, supersedes any current
-- run, and writes the run, its candidates and its ordered rows. Scores and breakdowns always
-- come from the database. It writes no audit_log row: per-attempt LLM audit rows are written by
-- the application's ranking client, and the run itself records final provenance and usage.
create function app.persist_recommendation_run(
    p_shortlist_ids uuid[], p_ranked_ids uuid[], p_outcome text, p_confidence text,
    p_internal_rationale text, p_model text, p_prompt_version text, p_usage jsonb)
returns uuid
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_person   uuid := app._person();
    v_run      uuid := gen_random_uuid();
    v_expected uuid[];
    v_n        int;
    v_ranked   uuid[] := coalesce(p_ranked_ids, '{}');
begin
    if v_person is null then raise exception 'no_person_context'; end if;
    perform pg_advisory_xact_lock(hashtextextended(v_person::text, 0));

    if not exists (select 1 from app.member_profile mp where mp.person_id = v_person)
       or exists (select 1 from app.group_membership gm where gm.person_id = v_person and gm.status = 'active') then
        raise exception 'not_eligible';
    end if;

    select array_agg(s.group_id order by s.shortlist_position) into v_expected from app.recommendation_shortlist() s;
    v_n := coalesce(cardinality(v_expected), 0);

    if (select array_agg(x order by x) from unnest(v_expected) x)
       is distinct from (select array_agg(x order by x) from unnest(coalesce(p_shortlist_ids, '{}')) x) then
        raise exception 'shortlist_changed';
    end if;

    if v_n = 0 then
        if p_outcome <> 'no_candidates' or cardinality(v_ranked) <> 0 then
            raise exception 'invalid_ranking: an empty shortlist needs a no_candidates outcome and no ranked groups';
        end if;
    else
        if p_outcome not in ('llm', 'llm_after_retry', 'score_fallback') then
            raise exception 'invalid_ranking: outcome % needs a non-empty shortlist', p_outcome;
        end if;
        if cardinality(v_ranked) <> least(3, v_n) then
            raise exception 'invalid_ranking: expected % ranked groups', least(3, v_n);
        end if;
        if (select count(distinct x) from unnest(v_ranked) x) <> cardinality(v_ranked) then
            raise exception 'invalid_ranking: duplicate group';
        end if;
        if not (v_ranked <@ v_expected) then
            raise exception 'invalid_ranking: group not on the shortlist';
        end if;
        if p_outcome = 'score_fallback' and v_ranked <> v_expected[1:least(3, v_n)] then
            raise exception 'invalid_ranking: a score fallback must follow the score order';
        end if;
        if p_model is null or p_prompt_version is null then
            raise exception 'invalid_ranking: model and prompt version are required';
        end if;
    end if;

    perform app._invalidate_runs('superseded', jsonb_build_object('by', v_run), array[v_person]);

    insert into app.recommendation_run
        (run_id, person_id, outcome, model, prompt_version, confidence, internal_rationale, llm_usage)
    values
        (v_run, v_person, p_outcome,
         case when v_n = 0 then null else p_model end,
         case when v_n = 0 then null else p_prompt_version end,
         case when v_n = 0 then null else p_confidence end,
         case when v_n = 0 then null else p_internal_rationale end,
         case when v_n = 0 then null else p_usage end);

    insert into app.recommendation_run_candidate (run_id, group_id, shortlist_position, score, score_breakdown)
        select v_run, s.group_id, s.shortlist_position, s.score, s.score_breakdown
        from app.recommendation_shortlist() s;

    insert into app.recommendation (run_id, person_id, group_id, rank)
        select v_run, v_person, t.g, t.ord::int from unnest(v_ranked) with ordinality as t(g, ord);

    return v_run;
end;
$$;
revoke all on function app.persist_recommendation_run(uuid[], uuid[], text, text, text, text, text, jsonb) from public;
grant execute on function app.persist_recommendation_run(uuid[], uuid[], text, text, text, text, text, jsonb) to gathered_app;

-- ---------------------------------------------------------------- Manager audit

create function app.manager_recommendation_audit(p_person_id uuid default null, p_group_id uuid default null)
returns table (
    run_id               uuid,
    person_id             uuid,
    is_current            boolean,
    generated_at          timestamptz,
    invalidated_at        timestamptz,
    invalidation_reason   text,
    invalidation_detail   jsonb,
    outcome               text,
    model                 text,
    prompt_version        text,
    confidence            text,
    internal_rationale    text,
    llm_usage             jsonb,
    group_id              uuid,
    shortlist_position    int,
    score                 numeric,
    score_breakdown       jsonb,
    rank                  int
)
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
    if current_setting('app.role', true) is distinct from 'manager' then
        raise exception 'manager only';
    end if;

    return query
        select r.run_id, r.person_id, r.is_current, r.generated_at, r.invalidated_at,
               r.invalidation_reason, r.invalidation_detail, r.outcome, r.model, r.prompt_version,
               r.confidence, r.internal_rationale, r.llm_usage,
               c.group_id, c.shortlist_position, c.score, c.score_breakdown, rec.rank
        from app.recommendation_run r
        left join app.recommendation_run_candidate c on c.run_id = r.run_id
        left join app.recommendation rec on rec.run_id = r.run_id and rec.group_id = c.group_id
        where (p_person_id is null or r.person_id = p_person_id)
          and (p_group_id is null or c.group_id = p_group_id)
        order by r.generated_at desc, r.run_id, c.shortlist_position;
end;
$$;
revoke all on function app.manager_recommendation_audit(uuid, uuid) from public;
grant execute on function app.manager_recommendation_audit(uuid, uuid) to gathered_app;

-- ---------------------------------------------------------------- invalidation triggers (W17)
-- AFTER ROW triggers owned by the owner role (SECURITY DEFINER), so a Leader's accept can
-- invalidate other members' runs without any widening of Leader row-level security. They fire
-- for every writer (app, nightly job, seed and admin scripts), in the writer's transaction, and
-- only when a matching-relevant column actually changed. They never call the LLM.

-- member_profile: the member's own run, and runs shortlisting groups they belong to (group mix).
create function app._trg_member_profile() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_pid uuid := case when tg_op = 'DELETE' then old.person_id else new.person_id end;
begin
    perform app._invalidate_runs('profile_changed',
        jsonb_build_object('table', 'member_profile', 'person_id', v_pid, 'op', tg_op),
        array[v_pid],
        (select array_agg(gm.group_id) from app.group_membership gm where gm.person_id = v_pid and gm.status = 'active'));
    return null;
end;
$$;
create trigger member_profile_ins_del after insert or delete on app.member_profile
    for each row execute function app._trg_member_profile();
create trigger member_profile_upd after update on app.member_profile
    for each row when (row(old.life_stage, old.available_slots, old.group_pref, old.interests, old.about_me)
                       is distinct from row(new.life_stage, new.available_slots, new.group_pref, new.interests, new.about_me))
    execute function app._trg_member_profile();

-- group_membership: the member's own run (eligibility), and runs shortlisting the group.
create function app._trg_group_membership() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_pid uuid := case when tg_op = 'DELETE' then old.person_id else new.person_id end;
    v_gid uuid := case when tg_op = 'DELETE' then old.group_id else new.group_id end;
begin
    perform app._invalidate_runs('membership_changed',
        jsonb_build_object('table', 'group_membership', 'group_id', v_gid, 'person_id', v_pid, 'op', tg_op),
        array[v_pid], array[v_gid]);
    return null;
end;
$$;
create trigger group_membership_ins_del after insert or delete on app.group_membership
    for each row execute function app._trg_group_membership();
create trigger group_membership_upd after update on app.group_membership
    for each row when (old.status is distinct from new.status)
    execute function app._trg_group_membership();

-- person_features: the person's run, and runs shortlisting groups they belong to.
create function app._trg_person_features() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_pid uuid := case when tg_op = 'DELETE' then old.person_id else new.person_id end;
begin
    perform app._invalidate_runs('person_features_changed',
        jsonb_build_object('table', 'person_features', 'person_id', v_pid, 'op', tg_op),
        array[v_pid],
        (select array_agg(gm.group_id) from app.group_membership gm where gm.person_id = v_pid and gm.status = 'active'));
    return null;
end;
$$;
create trigger person_features_ins_del after insert or delete on app.person_features
    for each row execute function app._trg_person_features();
create trigger person_features_upd after update on app.person_features
    for each row when (row(old.busy_slots, old.kids_age_bands, old.serving_areas, old.consistency_score,
                           old.signal_confidence, old.online_share_12w)
                       is distinct from row(new.busy_slots, new.kids_age_bands, new.serving_areas, new.consistency_score,
                                            new.signal_confidence, new.online_share_12w))
    execute function app._trg_person_features();

-- grp: a new group can be eligible for anyone; an edit invalidates runs that shortlisted it, and
-- every current run when the edit can make the group newly eligible.
create function app._trg_grp_insert() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
    perform app._invalidate_runs('group_added', jsonb_build_object('table', 'grp', 'group_id', new.group_id),
                                 null, null, true);
    return null;
end;
$$;
create trigger grp_ins after insert on app.grp for each row execute function app._trg_grp_insert();

create function app._trg_grp_update() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare v_newly_eligible boolean;
begin
    v_newly_eligible :=
           (new.status in ('open', 'forming') and old.status not in ('open', 'forming'))
        or new.capacity_max > old.capacity_max
        or new.meeting_slot is distinct from old.meeting_slot
        or new.gender_focus is distinct from old.gender_focus
        or new.is_online is distinct from old.is_online
        or new.lat_approx is distinct from old.lat_approx
        or new.lng_approx is distinct from old.lng_approx;
    perform app._invalidate_runs('group_changed', jsonb_build_object('table', 'grp', 'group_id', new.group_id),
                                 null, array[new.group_id], v_newly_eligible);
    return null;
end;
$$;
create trigger grp_upd after update on app.grp
    for each row when (row(old.status, old.capacity_max, old.meeting_slot, old.gender_focus, old.life_stage_focus,
                           old.is_online, old.description, old.childcare, old.lat_approx, old.lng_approx)
                       is distinct from row(new.status, new.capacity_max, new.meeting_slot, new.gender_focus, new.life_stage_focus,
                                            new.is_online, new.description, new.childcare, new.lat_approx, new.lng_approx))
    execute function app._trg_grp_update();

-- group_tag: runs shortlisting the group, and runs of members whose interests include the tag.
create function app._trg_group_tag() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_gid  uuid := case when tg_op = 'DELETE' then old.group_id else new.group_id end;
    v_tags text[] := array_remove(array[case when tg_op <> 'INSERT' then old.tag end,
                                        case when tg_op <> 'DELETE' then new.tag end], null);
begin
    perform app._invalidate_runs('group_tags_changed', jsonb_build_object('table', 'group_tag', 'group_id', v_gid),
        (select array_agg(mp.person_id) from app.member_profile mp where mp.interests && v_tags),
        array[v_gid]);
    return null;
end;
$$;
create trigger group_tag_chg after insert or update or delete on app.group_tag
    for each row execute function app._trg_group_tag();

-- group_leader: the group's location or existence for matching changed.
create function app._trg_group_leader() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
    perform app._invalidate_runs('group_leader_changed',
        jsonb_build_object('table', 'group_leader', 'group_id', case when tg_op = 'DELETE' then old.group_id else new.group_id end),
        null, null, true);
    return null;
end;
$$;
create trigger group_leader_chg after insert or update or delete on app.group_leader
    for each row execute function app._trg_group_leader();

-- household: residents' runs; every current run if a group leader lives there (group location).
create function app._trg_household() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
    perform app._invalidate_runs('location_changed', jsonb_build_object('table', 'household', 'household_id', new.household_id),
        (select array_agg(p.person_id) from app.person p where p.household_id = new.household_id),
        null,
        exists (select 1 from app.group_leader gl join app.person p on p.person_id = gl.person_id
                where p.household_id = new.household_id));
    return null;
end;
$$;
create trigger household_upd after update on app.household
    for each row when (row(old.lat_approx, old.lng_approx, old.zip) is distinct from row(new.lat_approx, new.lng_approx, new.zip))
    execute function app._trg_household();

-- person: gender or household changes the person's own eligibility and distance.
create function app._trg_person() returns trigger
language plpgsql security definer set search_path = app, pg_temp
as $$
begin
    perform app._invalidate_runs('profile_changed', jsonb_build_object('table', 'person', 'person_id', new.person_id),
                                 array[new.person_id]);
    return null;
end;
$$;
create trigger person_upd after update on app.person
    for each row when (row(old.gender, old.household_id) is distinct from row(new.gender, new.household_id))
    execute function app._trg_person();

revoke all on function app._trg_member_profile(), app._trg_group_membership(), app._trg_person_features(),
    app._trg_grp_insert(), app._trg_grp_update(), app._trg_group_tag(), app._trg_group_leader(),
    app._trg_household(), app._trg_person() from public;
