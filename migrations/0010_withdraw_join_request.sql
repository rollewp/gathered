-- Gathered: a member withdraws their own pending join request. Run as DATABASE_OWNER_URL via
-- scripts/migrate.mjs, after 0009.
--
-- 0002 lets only a manager or the group's leader UPDATE app.join_request, and 0006 deliberately gave
-- members no direct write (a direct UPDATE would let them choose any status). Withdrawal is therefore
-- one narrow SECURITY DEFINER function, the same shape as app.request_to_join:
--   * only a member (role 'member') acting on their OWN request; a leader or manager persona cannot
--     withdraw on a member's behalf, and a crafted request id for someone else's request finds nothing
--   * only a request that is still 'requested'; the update is conditional, so a second submission
--     (double click, repeated POST) matches no row and is rejected with 'not_pending' without writing
--   * the row is kept: status becomes 'withdrawn' and nothing else on it changes (no decided_at or
--     decided_by: those record a leader/manager decision, and this is not one)
--   * no membership is created, no profile is touched, and nothing here invalidates a recommendation
--     run (the invalidation triggers do not listen to join_request; architecture §6.3)
--   * one audit_log row, ids and statuses only (never the member's note)
-- No table, policy, grant or status value changes. gathered_app only gains EXECUTE on the function.

create function app.withdraw_join_request(p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = app, pg_temp
as $$
declare
    v_person uuid := app._person();
    v_group  uuid;
begin
    if app._role() is distinct from 'member' or v_person is null then
        raise exception 'not_allowed';
    end if;

    update app.join_request jr
       set status = 'withdrawn'
     where jr.request_id = p_request_id
       and jr.person_id = v_person
       and jr.status = 'requested'
    returning jr.group_id into v_group;

    if v_group is null then
        raise exception 'not_pending';
    end if;

    insert into app.audit_log (actor_user_id, action, entity, entity_id, detail)
    values ((select pu.user_id from app.portal_user pu where pu.person_id = v_person),
            'join_request_withdrawn', 'join_request', p_request_id,
            jsonb_build_object('group_id', v_group, 'from_status', 'requested', 'to_status', 'withdrawn'));
    return v_group;
end;
$$;
revoke all on function app.withdraw_join_request(uuid) from public;
grant execute on function app.withdraw_join_request(uuid) to gathered_app;
