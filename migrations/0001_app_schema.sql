-- Gathered: app schema (tables only). Run as DATABASE_OWNER_URL via scripts/migrate.mjs.
-- Operational store per docs/Gathered - Data Model & Architecture.md D1: groups, memberships,
-- requests, profiles, recommendations. Engagement history (service/ministry/attendance_event/
-- serving_assignment) stays in Databricks/Delta, not here. person_features lands here, written
-- by the nightly notebook -- no seed CSV for it, it's created empty.

create schema if not exists app;

-- ---------------------------------------------------------------- people

create table app.household (
    household_id       uuid primary key,
    zip                 text not null,
    lat_approx          numeric not null,
    lng_approx          numeric not null,
    checkin_app_opt_in  boolean not null default false,
    app_opt_in_at       timestamptz
);

create table app.person (
    person_id           uuid primary key,
    household_id        uuid not null references app.household(household_id),
    first_name           text not null,
    last_name            text not null,
    gender               text not null check (gender in ('M','F')),
    birth_year           int not null,
    household_role       text not null check (household_role in ('adult','child')),
    first_attended_on    date,
    is_synthetic         boolean not null default true
);
create index on app.person (household_id);

create table app.member_profile (
    person_id         uuid primary key references app.person(person_id),
    opted_in_at        timestamptz not null,
    consent_version    text,
    life_stage         text check (life_stage in
                        ('single','married_no_kids','young_kids','school_age_kids','teens','empty_nest','retired')),
    available_slots    text[],
    max_distance_mi    int,
    group_pref         text check (group_pref in ('men','women','mixed','couples')),
    interests          text[],
    about_me           text,
    profile_source     text,
    confirmed_at       timestamptz
);

create table app.portal_user (
    user_id      uuid primary key,
    person_id     uuid not null unique references app.person(person_id),
    role          text not null check (role in ('member','leader','manager')),
    email         text not null unique
);

-- ---------------------------------------------------------------- person features
-- Empty on creation. Populated by the nightly Databricks notebook, not by scripts/load_seed.mjs.

create table app.person_features (
    person_id             uuid primary key references app.person(person_id),
    observed_weeks_12w     int,
    attendance_rate_12w     numeric,
    signal_sources          text[],
    signal_confidence       text check (signal_confidence in ('high','medium','low')),
    online_share_12w        numeric,
    consistency_score       numeric,
    busy_slots              text[],
    serving_areas           text[],
    kids_age_bands          text[],
    tenure_months           int,
    last_attended_on        date,
    computed_at             timestamptz
);

-- ---------------------------------------------------------------- groups

create table app.grp (
    group_id            uuid primary key,
    name                 text not null,
    description          text,
    gender_focus         text check (gender_focus in ('men','women','mixed','couples')),
    life_stage_focus     text check (life_stage_focus in
                         ('single','married_no_kids','young_kids','school_age_kids','teens','empty_nest','retired')),
    meeting_slot         text,
    frequency            text,
    lat_approx           numeric,
    lng_approx           numeric,
    is_online            boolean not null default false,
    capacity_min         int not null default 3,
    capacity_max         int not null default 8,
    childcare            boolean not null default false,
    status               text not null check (status in ('forming','open','full','closed','multiplying'))
);

create table app.group_tag (
    group_id   uuid not null references app.grp(group_id),
    tag         text not null,
    primary key (group_id, tag)
);

create table app.group_leader (
    group_id    uuid not null references app.grp(group_id),
    person_id    uuid not null references app.person(person_id),
    role         text not null default 'leader',
    start_on     date,
    primary key (group_id, person_id)
);

create table app.group_membership (
    group_id     uuid not null references app.grp(group_id),
    person_id     uuid not null references app.person(person_id),
    status        text not null check (status in ('active','left')),
    joined_at     timestamptz not null,
    left_at       timestamptz,
    left_reason   text,
    primary key (group_id, person_id)
);
create index on app.group_membership (person_id);

create table app.group_meeting (
    meeting_id   uuid primary key,
    group_id      uuid not null references app.grp(group_id),
    met_on        date not null
);

create table app.meeting_attendance (
    meeting_id   uuid not null references app.group_meeting(meeting_id),
    person_id     uuid not null references app.person(person_id),
    present       boolean not null,
    primary key (meeting_id, person_id)
);

-- ---------------------------------------------------------------- workflow / governance

create table app.recommendation (
    rec_id              uuid primary key,
    person_id            uuid not null references app.person(person_id),
    group_id             uuid not null references app.grp(group_id),
    rank                 int,
    score                numeric,
    score_breakdown      jsonb,
    internal_rationale   text, -- renamed from the doc's why_text: W10 "internal rationale", manager-audit only
    model                text,
    prompt_version       text,
    generated_at         timestamptz
);
create index on app.recommendation (person_id);

create table app.join_request (
    request_id      uuid primary key,
    person_id        uuid not null references app.person(person_id),
    group_id         uuid not null references app.grp(group_id),
    rec_id           uuid references app.recommendation(rec_id),
    status           text not null check (status in ('requested','accepted','declined','withdrawn','expired')),
    member_note      text,
    requested_at     timestamptz not null,
    decided_at       timestamptz,
    decided_by       uuid references app.portal_user(user_id),
    decline_reason   text
);
create index on app.join_request (person_id);
create index on app.join_request (group_id);

create table app.escalation (
    escalation_id    uuid primary key,
    source            text not null check (source in ('rule','ai')),
    kind              text,
    severity          text,
    group_id          uuid references app.grp(group_id),
    person_id         uuid references app.person(person_id),
    summary           text,
    evidence          jsonb,
    status            text not null default 'open' check (status in ('open','acknowledged','resolved')),
    created_at        timestamptz not null default now(),
    resolved_by       uuid references app.portal_user(user_id)
);
create index on app.escalation (group_id);

create table app.audit_log (
    id               bigserial primary key,
    actor_user_id     uuid references app.portal_user(user_id),
    action            text not null,
    entity            text,
    entity_id         uuid,
    detail            jsonb,
    at                timestamptz not null default now()
);
