-- ============================================================
-- YPM Youth Awards — upgrade an EXISTING database.
--
-- Run this ONCE in Supabase -> SQL Editor if your project was set up
-- before the /inventor page existed. It is safe on a live database:
-- it adds to what is there and does not touch your ballots or votes.
--
-- It does two things:
--   1. Adds a second admin key, so you and your leader have separate doors.
--   2. Fixes phone normalisation in start_ballot, so +234... and 0...
--      resolve to the same voter server-side as well as in the browser.
--
-- Change 'your-developer-key' below before running.
-- ============================================================

create table if not exists public.admin_keys (
  key         text primary key,
  label       text not null,
  created_at  timestamptz not null default now()
);

alter table public.admin_keys enable row level security;

-- Carry the key you already set over as the leader's key.
insert into public.admin_keys (key, label)
select admin_key, 'leader' from public.admin_config where id = 1
on conflict (key) do nothing;

-- >>> CHANGE 'your-developer-key' TO YOUR OWN SECRET <<<
insert into public.admin_keys (key, label)
values ('your-developer-key', 'inventor')
on conflict (key) do nothing;

-- ---------- Point the admin functions at the new table ----------

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

-- ---------- Phone normalisation fix ----------
-- Without this, a number typed as +2348031234567 creates a second ballot
-- instead of matching 08031234567.

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

  -- Must match normalizePhone() in src/lib/phone.js, so the same person
  -- is one voter however they type their number.
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
    -- Two devices started at the same instant; fall back to the existing ballot.
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

grant execute on function public.get_tally(text)                to anon;
grant execute on function public.set_voting_open(text, boolean) to anon;
grant execute on function public.start_ballot(text, text)       to anon;

-- ---------- Managing keys later ----------
-- See who has a key (labels only, keys are visible here too):
--   select label, key from public.admin_keys;
-- Change the leader's key:
--   update public.admin_keys set key = 'new-key' where label = 'leader';
-- Revoke a key entirely:
--   delete from public.admin_keys where label = 'leader';
-- Add another person:
--   insert into public.admin_keys (key, label) values ('some-key', 'pastor');
