-- AI escalations (source = 'ai') are Manager-only evidence: only a manager may insert or read them.
-- Rule escalations keep the original behavior (any role may insert an open one; a group's own
-- leaders may read those for their groups), so the future rule-escalation path is unchanged.
-- Updates were already manager-only.

drop policy select_escalation on app.escalation;
create policy select_escalation on app.escalation for select using (
    app._role() = 'manager'
    or (source = 'rule'
        and exists (select 1 from app.group_leader gl
                    where gl.group_id = escalation.group_id and gl.person_id = app._person()))
);

drop policy insert_escalation on app.escalation;
create policy insert_escalation on app.escalation for insert with check (
    status = 'open'
    and (
        (source = 'ai' and app._role() = 'manager')
        or source = 'rule'
    )
);
