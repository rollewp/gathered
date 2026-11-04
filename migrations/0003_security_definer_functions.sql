-- Gathered: SECURITY DEFINER functions. Run as DATABASE_OWNER_URL via scripts/migrate.mjs, after
-- 0002_rls_policies.sql. Both are owned by the connecting (owner) role and run with its
-- unforced, bypass-RLS view of the tables, regardless of the caller's gathered_app session
-- context -- each function then decides for itself what to expose. search_path is pinned
-- because these are SECURITY DEFINER (defense against search_path tricks), even though every
-- reference below is already schema-qualified.

-- Public group card: the doc is explicit that members see a named area, never coordinates or an
-- address, and that group_tag/open-seats/etc are the same for everyone. This is the only way the
-- app should read group cards -- gathered_app's grant on app.grp omits lat_approx/lng_approx
-- entirely (0002), so there is no base-table path to raw coordinates at all.
--
-- Deliberately takes no viewer argument and computes no distance: the per-viewer "about 3 mi"
-- phrasing in the doc is relative to the member's own household and belongs to the future
-- recommend_groups(), not this static public card.
create function app.group_card()
returns table (
    group_id            uuid,
    name                text,
    description         text,
    gender_focus        text,
    life_stage_focus    text,
    meeting_slot        text,
    frequency           text,
    is_online           boolean,
    capacity_max        int,
    childcare           boolean,
    status              text,
    tags                text[],
    open_seats          int,
    area_label          text
)
language sql
security definer
set search_path = app, pg_temp
as $$
    select
        g.group_id,
        g.name,
        g.description,
        g.gender_focus,
        g.life_stage_focus,
        g.meeting_slot,
        g.frequency,
        g.is_online,
        g.capacity_max,
        g.childcare,
        g.status,
        coalesce(t.tags, '{}'::text[])                           as tags,
        greatest(0, g.capacity_max - coalesce(m.active_count, 0)) as open_seats,
        coalesce(a.area_label, 'Winter Garden area')              as area_label
    from app.grp g
    left join (
        select group_id, array_agg(tag order by tag) as tags
        from app.group_tag
        group by group_id
    ) t on t.group_id = g.group_id
    left join (
        select group_id, count(*) as active_count
        from app.group_membership
        where status = 'active'
        group by group_id
    ) m on m.group_id = g.group_id
    left join lateral (
        -- host household's zip, mapped to a named area (W12's five zips). Best-guess area
        -- names, not specified in the doc -- easy to rename later.
        select case h.zip
                   when '34787' then 'Winter Garden'
                   when '34786' then 'Windermere'
                   when '34761' then 'Ocoee'
                   when '34734' then 'Gotha'
                   when '34711' then 'Clermont'
                   else 'Winter Garden area'
               end as area_label
        from app.group_leader gl
        join app.person p on p.person_id = gl.person_id
        join app.household h on h.household_id = p.household_id
        where gl.group_id = g.group_id
        order by gl.start_on asc nulls last
        limit 1
    ) a on true;
$$;

revoke all on function app.group_card() from public;
grant execute on function app.group_card() to gathered_app;

-- Manager-only audit view of recommendation, including score_breakdown and internal_rationale
-- (W10). This exists because gathered_app is one DB role shared by all three personas, so a
-- row-level policy alone can't hide two columns from two of the three sessions sharing it --
-- 0002 revokes column-level SELECT on these from gathered_app entirely, and this function is the
-- only path back to them, gated on app.role at call time rather than on a DB-level grant.
create function app.manager_recommendation_audit(p_person_id uuid default null, p_group_id uuid default null)
returns table (
    rec_id              uuid,
    person_id            uuid,
    group_id             uuid,
    rank                 int,
    score                numeric,
    score_breakdown      jsonb,
    internal_rationale   text,
    model                text,
    prompt_version       text,
    generated_at         timestamptz
)
language plpgsql
security definer
set search_path = app, pg_temp
as $$
begin
    if current_setting('app.role', true) is distinct from 'manager' then
        raise exception 'manager only';
    end if;

    return query
        select r.rec_id, r.person_id, r.group_id, r.rank, r.score, r.score_breakdown,
               r.internal_rationale, r.model, r.prompt_version, r.generated_at
        from app.recommendation r
        where (p_person_id is null or r.person_id = p_person_id)
          and (p_group_id is null or r.group_id = p_group_id);
end;
$$;

revoke all on function app.manager_recommendation_audit(uuid, uuid) from public;
grant execute on function app.manager_recommendation_audit(uuid, uuid) to gathered_app;
