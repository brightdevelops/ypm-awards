-- ============================================================
-- YPM Youth Awards — Supabase setup
-- Paste into Supabase -> SQL Editor -> New query -> Run.
-- IMPORTANT: change the admin key on line 42 before you run it.
-- ============================================================

-- ---------- 1. Tables ----------

create table if not exists public.settings (
  id           int primary key default 1,
  voting_open  boolean not null default true,
  constraint settings_singleton check (id = 1)
);

create table if not exists public.admin_config (
  id         int primary key default 1,
  admin_key  text not null,
  constraint admin_config_singleton check (id = 1)
);

create table if not exists public.ballots (
  id            uuid primary key default gen_random_uuid(),
  voter_name    text not null,
  voter_phone   text not null unique,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create table if not exists public.votes (
  id            uuid primary key default gen_random_uuid(),
  ballot_id     uuid not null references public.ballots(id) on delete cascade,
  category_id   text not null,
  nominee_name  text not null,
  created_at    timestamptz not null default now(),
  unique (ballot_id, category_id)
);

-- ---------- 2. Seed ----------

insert into public.settings (id, voting_open)
values (1, true)
on conflict (id) do nothing;

-- >>> CHANGE 'change-this-key' TO YOUR OWN SECRET <<<
insert into public.admin_config (id, admin_key)
values (1, 'change-this-key')
on conflict (id) do nothing;

-- ---------- 3. Lock the tables ----------
-- RLS on with no policies means the public anon key cannot read or write
-- these tables at all. Every action goes through the functions below, so
-- nobody can read the votes from the browser before the announcement.

alter table public.settings     enable row level security;
alter table public.admin_config enable row level security;
alter table public.ballots      enable row level security;
alter table public.votes        enable row level security;

-- ---------- 4. Public functions (used by the voting page) ----------

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

create or replace function public.save_vote(
  p_ballot_id uuid, p_category_id text, p_nominee_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open      boolean;
  v_completed timestamptz;
begin
  select voting_open into v_open from settings where id = 1;
  if not coalesce(v_open, true) then
    return json_build_object('status', 'closed');
  end if;

  select completed_at into v_completed from ballots where id = p_ballot_id;
  if not found then
    return json_build_object('status', 'error', 'message', 'unknown ballot');
  end if;
  if v_completed is not null then
    return json_build_object('status', 'error', 'message', 'already submitted');
  end if;

  insert into votes (ballot_id, category_id, nominee_name)
  values (p_ballot_id, p_category_id, p_nominee_name)
  on conflict (ballot_id, category_id)
  do update set nominee_name = excluded.nominee_name, created_at = now();

  return json_build_object('status', 'ok');
end;
$$;

create or replace function public.submit_ballot(p_ballot_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open boolean;
begin
  select voting_open into v_open from settings where id = 1;
  if not coalesce(v_open, true) then
    return json_build_object('status', 'closed');
  end if;

  update ballots
     set completed_at = coalesce(completed_at, now())
   where id = p_ballot_id;

  if not found then
    return json_build_object('status', 'error', 'message', 'unknown ballot');
  end if;

  return json_build_object('status', 'ok');
end;
$$;

-- ---------- 5. Admin functions (key required) ----------

create or replace function public.get_tally(p_key text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  select (admin_key = p_key) into v_ok from admin_config where id = 1;
  if not coalesce(v_ok, false) then
    return json_build_object('status', 'unauthorized');
  end if;

  return json_build_object(
    'status', 'ok',
    'voting_open', coalesce((select voting_open from settings where id = 1), true),
    'ballots_started',   (select count(*) from ballots),
    'ballots_completed', (select count(*) from ballots where completed_at is not null),
    -- only submitted ballots are counted
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
declare
  v_ok boolean;
begin
  select (admin_key = p_key) into v_ok from admin_config where id = 1;
  if not coalesce(v_ok, false) then
    return json_build_object('status', 'unauthorized');
  end if;

  update settings set voting_open = p_open where id = 1;
  return json_build_object('status', 'ok', 'voting_open', p_open);
end;
$$;

-- ---------- 6. Grants ----------

grant execute on function public.voting_status()                        to anon;
grant execute on function public.start_ballot(text, text)               to anon;
grant execute on function public.save_vote(uuid, text, text)            to anon;
grant execute on function public.submit_ballot(uuid)                    to anon;
grant execute on function public.get_tally(text)                        to anon;
grant execute on function public.set_voting_open(text, boolean)         to anon;

-- ---------- Handy queries for the night ----------
-- Change the admin key later:
--   update public.admin_config set admin_key = 'new-key' where id = 1;
-- Close voting from SQL instead of the dashboard:
--   update public.settings set voting_open = false where id = 1;
-- Remove a test ballot (votes go with it):
--   delete from public.ballots where voter_phone = '08012345678';
