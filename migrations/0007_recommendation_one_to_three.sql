-- Gathered: recommendation size is 1 to 3 (was exactly min(3, shortlist size)).
-- Run as DATABASE_OWNER_URL via scripts/migrate.mjs, after 0006.
--
-- The ranking model now returns only the groups it can positively support, between one and three,
-- and is not asked to fill unused slots. app.persist_recommendation_run() is the only writer of
-- runs, so this is the only place the rule lives in the database. The change is deliberately
-- narrow: the signature, grants, locking, eligibility, shortlist-changed check, supersession,
-- duplicate and shortlist-subset checks, and the table constraints (rank 1..3, unique rank per
-- run) are unchanged.
--
--   * llm / llm_after_retry : 1 to least(3, shortlist size) ranked groups (was exactly that many).
--   * score_fallback        : still exactly the top least(3, shortlist size) in score order. The
--                             fallback is deterministic, not a judgement of fit, so it does not
--                             shrink.
--   * no_candidates         : unchanged (empty shortlist, zero ranked groups).
create or replace function app.persist_recommendation_run(
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
        if cardinality(v_ranked) < 1 or cardinality(v_ranked) > least(3, v_n) then
            raise exception 'invalid_ranking: expected 1 to % ranked groups', least(3, v_n);
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
