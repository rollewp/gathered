-- Gathered Postgres spike: P3 row-level security test
-- Run in the Postgres SQL editor as the project OWNER. Works the same on Lakebase or Neon.

create schema if not exists spike;

create table if not exists spike.group_leader (group_id int, person_id int);
create table if not exists spike.group_membership (group_id int, person_id int, note text);
truncate spike.group_leader, spike.group_membership;
insert into spike.group_leader values (1, 900), (2, 901);           -- 900 leads G1, 901 leads G2
insert into spike.group_membership values
  (1, 101, 'Marcus in G1'), (1, 102, 'Dana in G1'), (2, 201, 'Ruth in G2');

-- App role: YOU create this and set its password yourself (P2 = can it log in from outside?)
-- create role gathered_app login password '<set this yourself>';
grant usage on schema spike to gathered_app;
grant select on all tables in schema spike to gathered_app;

alter table spike.group_membership enable row level security;
alter table spike.group_membership force row level security;
drop policy if exists persona_scope on spike.group_membership;
create policy persona_scope on spike.group_membership for select using (
     current_setting('app.role', true) = 'manager'
  or person_id = nullif(current_setting('app.person_id', true), '')::int
  or exists (select 1 from spike.group_leader gl
             where gl.group_id = group_membership.group_id
               and gl.person_id = nullif(current_setting('app.person_id', true), '')::int)
);
-- Then run: node pgtest.mjs  (it connects AS gathered_app and checks the three personas)
