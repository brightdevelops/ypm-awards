-- ============================================================
-- YPM Youth Awards — undo Migration 001.
--
-- Restores start_ballot, voting_status, get_tally and set_voting_open as
-- they were in supabase-setup.sql, and removes everything 001 added.
--
-- Ballots and votes are kept. What is lost: voting codes, which ballot used
-- which code, admin sessions, the audit log, and any admin key set with
-- set_admin_key (the old admin_keys table was never touched, so the keys
-- from before 001 work again).
--
-- NOTE: this reopens the hole that lets anyone resume an unfinished ballot
-- by typing its phone number.
-- ============================================================

begin;

-- Refuses to run over migration 003: this file would silently replace 003's
-- protected voting functions (save_vote, begin_ballot) with unprotected ones.
do $$
begin
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is not null
     or to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is not null then
    raise exception 'Migration 003 is installed. Running this file would replace its protected voting functions. Undo 004 and 003 first (in that order), or don''t run this file.';
  end if;
end;
$$;

drop function if exists public.begin_ballot(text, text, text, uuid);
drop function if exists public.admin_login(text);
drop function if exists public.admin_logout(text);
drop function if exists public.admin_dashboard(text);
drop function if exists public.admin_set_voting_open(text, boolean);
drop function if exists public.admin_set_code_required(text, boolean);
drop function if exists public.admin_issue_codes(text, int, text, text, int);
drop function if exists public.admin_list_codes(text);
drop function if exists public.admin_revoke_code(text, uuid);
drop function if exists public.admin_audit_log(text, int);

create or replace function public.voting_status()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'voting_open', coalesce((select voting_open from settings where id = 1), true)
  );
$$;

create or replace function public.start_ballot(p_name text, p_phone text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open   boolean;
  v_phone  text;
  v_ballot public.ballots;
  v_picks  json;
begin
  select voting_open into v_open from settings where id = 1;
  if not coalesce(v_open, true) then
    return json_build_object('status', 'closed');
  end if;

  v_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if v_phone like '234%' and length(v_phone) >= 12 then
    v_phone := '0' || substr(v_phone, 4);
  elsif length(v_phone) = 10 and v_phone not like '0%' then
    v_phone := '0' || v_phone;
  end if;

  if coalesce(btrim(p_name), '') = '' or length(v_phone) < 10 then
    return json_build_object('status', 'error', 'message', 'name and phone required');
  end if;

  select * into v_ballot from ballots where voter_phone = v_phone;

  if found then
    if v_ballot.completed_at is not null then
      return json_build_object('status', 'already_voted');
    end if;

    select coalesce(json_agg(json_build_object(
             'category_id', category_id, 'nominee_name', nominee_name)), '[]'::json)
      into v_picks
      from votes where ballot_id = v_ballot.id;

    return json_build_object('status', 'resumed',
                             'ballot_id', v_ballot.id, 'picks', v_picks);
  end if;

  begin
    insert into ballots (voter_name, voter_phone)
    values (btrim(p_name), v_phone)
    returning * into v_ballot;
  exception when unique_violation then
    select * into v_ballot from ballots where voter_phone = v_phone;

    if v_ballot.completed_at is not null then
      return json_build_object('status', 'already_voted');
    end if;

    select coalesce(json_agg(json_build_object(
             'category_id', category_id, 'nominee_name', nominee_name)), '[]'::json)
      into v_picks
      from votes where ballot_id = v_ballot.id;

    return json_build_object('status', 'resumed',
                             'ballot_id', v_ballot.id, 'picks', v_picks);
  end;

  return json_build_object('status', 'started',
                           'ballot_id', v_ballot.id, 'picks', '[]'::json);
end;
$$;

create or replace function public.get_tally(p_key text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
begin
  select label into v_label from admin_keys where key = p_key;
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;

  return json_build_object(
    'status', 'ok',
    'key_label', v_label,
    'voting_open', coalesce((select voting_open from settings where id = 1), true),
    'ballots_started',   (select count(*) from ballots),
    'ballots_completed', (select count(*) from ballots where completed_at is not null),
    'tally', (
      select coalesce(json_agg(t), '[]'::json) from (
        select v.category_id, v.nominee_name, count(*)::int as votes
          from votes v
          join ballots b on b.id = v.ballot_id
         where b.completed_at is not null
         group by v.category_id, v.nominee_name
         order by v.category_id, count(*) desc
      ) t
    ),
    'voters', (
      select coalesce(json_agg(x), '[]'::json) from (
        select voter_name, voter_phone, completed_at
          from ballots order by started_at desc
      ) x
    )
  );
end;
$$;

create or replace function public.set_voting_open(p_key text, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from admin_keys where key = p_key) then
    return json_build_object('status', 'unauthorized');
  end if;

  update settings set voting_open = p_open where id = 1;
  return json_build_object('status', 'ok', 'voting_open', p_open);
end;
$$;

drop index if exists public.ballots_voting_code_unique;
alter table public.ballots  drop column if exists voting_code_id;
alter table public.settings drop column if exists require_voting_code;

drop table if exists public.admin_sessions;
drop table if exists public.admin_users;
drop table if exists public.admin_audit;
drop table if exists public.rate_events;
drop table if exists public.voting_codes;

drop schema if exists ypm_private cascade;

commit;
