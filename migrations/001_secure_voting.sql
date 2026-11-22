-- ============================================================
-- YPM Youth Awards — Migration 001: secure voting
--
--   1. Fix: an unfinished ballot can no longer be reopened (and its picks
--      read) by typing someone's phone number. Resuming now needs the same
--      device, or a voting code.
--   2. Single-use voting codes, issued by admins. Optional until you switch
--      on settings.require_voting_code — the default is OFF.
--   3. Admin sign-in returns a short-lived session; keys are stored hashed.
--   4. Rate limits on failed codes, resume attempts and admin sign-ins.
--   5. An audit log of admin actions.
--
-- DOES NOT modify or delete any existing ballot or vote. It adds one empty
-- column to ballots (voting_code_id), new tables, and new functions.
-- Existing function signatures keep working for pages already open.
--
-- Review before running. Test on the DEVELOPMENT project first.
-- Safe to run more than once. Undo with 001_secure_voting.down.sql.
-- See migrations/README.md for the deploy order.
--
-- Written with ":=" assignments, not "SELECT ... INTO", because the
-- Supabase SQL editor can misread "INTO v_xxx" as a table name.
-- ============================================================

begin;

-- ---------- 0. Private schema for internal helpers ----------
-- Not exposed by the Supabase API, and the public roles can't use it.

create schema if not exists ypm_private;
revoke all on schema ypm_private from public;

-- ---------- 1. Tables and columns ----------

alter table public.settings
  add column if not exists require_voting_code boolean not null default false;

create table if not exists public.voting_codes (
  id           uuid primary key default gen_random_uuid(),
  code_hash    text not null unique,      -- sha256 of the code; the code itself is never stored
  phone        text,                      -- normalised; null = usable with any number
  note         text,
  created_by   text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,               -- only applies before the code is used
  redeemed_at  timestamptz,
  revoked_at   timestamptz
);

-- Nullable, no default: existing ballots stay exactly as they are.
alter table public.ballots
  add column if not exists voting_code_id uuid references public.voting_codes(id);

-- One code opens one ballot. Also what stops two devices redeeming the
-- same code at the same instant.
create unique index if not exists ballots_voting_code_unique
  on public.ballots (voting_code_id);

create table if not exists public.admin_users (
  label       text primary key,
  key_hash    text not null unique,       -- sha256 of the admin key
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table if not exists public.admin_sessions (
  token_hash  text primary key,           -- sha256 of the session token
  label       text not null references public.admin_users(label) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

create table if not exists public.admin_audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  actor   text not null,
  action  text not null,
  detail  jsonb not null default '{}'::jsonb
);

create table if not exists public.rate_events (
  id      bigserial primary key,
  bucket  text not null,
  at      timestamptz not null default now()
);

create index if not exists rate_events_bucket_at on public.rate_events (bucket, at);
create index if not exists rate_events_at        on public.rate_events (at);

-- Carry the existing admin keys over, hashed. admin_keys is left in place
-- (still plaintext) so you can roll back; drop it once you're happy.
insert into public.admin_users (label, key_hash)
select distinct on (label) label, encode(sha256(convert_to(key, 'UTF8')), 'hex')
  from public.admin_keys
 order by label, created_at
on conflict do nothing;

-- ---------- 2. Lock the new tables ----------

alter table public.voting_codes    enable row level security;
alter table public.admin_users     enable row level security;
alter table public.admin_sessions  enable row level security;
alter table public.admin_audit     enable row level security;
alter table public.rate_events     enable row level security;

revoke all on public.voting_codes, public.admin_users, public.admin_sessions,
              public.admin_audit, public.rate_events
  from anon, authenticated;
revoke all on sequence public.admin_audit_id_seq, public.rate_events_id_seq
  from anon, authenticated;

-- ---------- 3. Internal helpers ----------

create or replace function ypm_private.sha256_hex(p text)
returns text language sql immutable as $$
  select encode(sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex');
$$;

-- 244 random bits, as hex.
create or replace function ypm_private.random_token()
returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- Must match normalizePhone() in src/lib/phone.js.
create or replace function ypm_private.normalize_phone(p text)
returns text language plpgsql immutable as $$
declare
  d text := regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g');
begin
  if d like '234%' and length(d) >= 12 then
    d := '0' || substr(d, 4);
  elsif length(d) = 10 and d not like '0%' then
    d := '0' || d;
  end if;
  return d;
end;
$$;

-- "abcde-fghij", "ABCDE FGHIJ" and "ABCDEFGHIJ" are the same code.
create or replace function ypm_private.normalize_code(p text)
returns text language sql immutable as $$
  select nullif(upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')), '');
$$;

-- 10 characters from a 32-letter alphabet with no 0/O or 1/I: 50 random bits.
-- Takes 5 bits from each of 10 random bytes of a v4 UUID, skipping byte 6
-- (whose high nibble is the fixed version number).
create or replace function ypm_private.new_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_out   text  := '';
  i       int;
begin
  foreach i in array array[0, 1, 2, 3, 4, 5, 7, 9, 10, 11] loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return substr(v_out, 1, 5) || '-' || substr(v_out, 6, 5);
end;
$$;

-- Best effort only: Supabase passes request headers through, but a client
-- can add its own X-Forwarded-For. The per-phone limits don't depend on it.
create or replace function ypm_private.client_ip()
returns text language plpgsql stable as $$
declare
  h json;
begin
  begin
    h := nullif(current_setting('request.headers', true), '')::json;
  exception when others then
    h := null;
  end;
  return coalesce(
    nullif(btrim(h->>'cf-connecting-ip'), ''),
    nullif(btrim(split_part(h->>'x-forwarded-for', ',', 1)), ''),
    'unknown'
  );
end;
$$;

create or replace function ypm_private.rate_limited(p_bucket text, p_max int, p_window interval)
returns boolean language sql stable as $$
  select count(*) >= p_max
    from public.rate_events
   where bucket = p_bucket and at > now() - p_window;
$$;

create or replace function ypm_private.rate_hit(p_bucket text)
returns void language sql as $$
  delete from public.rate_events where at < now() - interval '1 day';
  insert into public.rate_events (bucket) values (p_bucket);
$$;

create or replace function ypm_private.audit(p_actor text, p_action text, p_detail jsonb default '{}'::jsonb)
returns void language sql as $$
  insert into public.admin_audit (actor, action, detail)
  values (p_actor, p_action, coalesce(p_detail, '{}'::jsonb));
$$;

-- Voter-side limits: 8 failed attempts per phone and 30 per IP address per
-- 15 minutes. Only failures count, so a whole church on one Wi-Fi is fine.
create or replace function ypm_private.voter_blocked(p_phone text, p_ip text)
returns boolean language sql stable as $$
  select ypm_private.rate_limited('voter:phone:' || p_phone, 8, interval '15 minutes')
      or (p_ip <> 'unknown'
          and ypm_private.rate_limited('voter:ip:' || p_ip, 30, interval '15 minutes'));
$$;

create or replace function ypm_private.voter_failure(p_phone text, p_ip text)
returns void language plpgsql as $$
begin
  perform ypm_private.rate_hit('voter:phone:' || p_phone);
  if p_ip <> 'unknown' then
    perform ypm_private.rate_hit('voter:ip:' || p_ip);
  end if;
end;
$$;

create or replace function ypm_private.ballot_picks(p_ballot_id uuid)
returns json language sql stable as $$
  select coalesce(json_agg(json_build_object(
           'category_id', category_id, 'nominee_name', nominee_name)), '[]'::json)
    from public.votes
   where ballot_id = p_ballot_id;
$$;

-- Admin key check with limits: 10 failures per IP address and 60 overall per
-- 15 minutes. Returns {ok, label} or {ok:false, reason}.
create or replace function ypm_private.admin_check_key(p_key text)
returns json language plpgsql as $$
declare
  v_ip    text := ypm_private.client_ip();
  v_label text;
begin
  if ypm_private.rate_limited('admin:all', 60, interval '15 minutes')
     or (v_ip <> 'unknown'
         and ypm_private.rate_limited('admin:ip:' || v_ip, 10, interval '15 minutes')) then
    return json_build_object('ok', false, 'reason', 'rate_limited');
  end if;

  v_label := (select label from public.admin_users
               where key_hash = ypm_private.sha256_hex(p_key) and revoked_at is null);

  if v_label is null then
    perform ypm_private.rate_hit('admin:all');
    if v_ip <> 'unknown' then
      perform ypm_private.rate_hit('admin:ip:' || v_ip);
    end if;
    perform ypm_private.audit('anonymous', 'login_failed', jsonb_build_object('ip', v_ip));
    return json_build_object('ok', false, 'reason', 'unauthorized');
  end if;

  return json_build_object('ok', true, 'label', v_label);
end;
$$;

create or replace function ypm_private.admin_session_label(p_session text)
returns text language sql stable as $$
  select s.label
    from public.admin_sessions s
    join public.admin_users u on u.label = s.label
   where s.token_hash = ypm_private.sha256_hex(p_session)
     and s.expires_at > now()
     and u.revoked_at is null;
$$;

create or replace function ypm_private.dashboard_json(p_label text)
returns json language sql stable as $$
  select json_build_object(
    'status', 'ok',
    'key_label', p_label,
    'voting_open',         coalesce((select voting_open         from public.settings where id = 1), true),
    'require_voting_code', coalesce((select require_voting_code from public.settings where id = 1), false),
    'ballots_started',   (select count(*) from public.ballots),
    'ballots_completed', (select count(*) from public.ballots where completed_at is not null),
    -- only submitted ballots are counted
    'tally', (
      select coalesce(json_agg(t), '[]'::json) from (
        select v.category_id, v.nominee_name, count(*)::int as votes
          from public.votes v
          join public.ballots b on b.id = v.ballot_id
         where b.completed_at is not null
         group by v.category_id, v.nominee_name
         order by v.category_id, count(*) desc
      ) t
    ),
    'voters', (
      select coalesce(json_agg(x), '[]'::json) from (
        select voter_name, voter_phone, completed_at,
               (voting_code_id is not null) as via_code
          from public.ballots order by started_at desc
      ) x
    ),
    'codes', (
      select json_build_object(
        'issued',    count(*),
        'redeemed',  count(*) filter (where redeemed_at is not null),
        'revoked',   count(*) filter (where revoked_at is not null),
        'available', count(*) filter (where redeemed_at is null and revoked_at is null
                                        and (expires_at is null or expires_at > now()))
      ) from public.voting_codes
    )
  );
$$;

-- Issue codes. Used by admin_issue_codes, and callable from the SQL editor:
--   select ypm_private.issue_codes('leader', 20, null, 'Sunday service', null);
create or replace function ypm_private.issue_codes(
  p_actor text, p_count int, p_phone text, p_note text, p_expires_hours int
)
returns json language plpgsql as $$
declare
  v_phone   text;
  v_expires timestamptz;
  v_code    text;
  v_id      uuid;
  v_out     json[] := '{}';
  v_tries   int := 0;
begin
  if p_count is null or p_count < 1 or p_count > 200 then
    return json_build_object('status', 'error', 'message', 'count must be 1 to 200');
  end if;

  if nullif(btrim(coalesce(p_phone, '')), '') is not null then
    v_phone := ypm_private.normalize_phone(p_phone);
    if length(v_phone) < 10 then
      return json_build_object('status', 'error', 'message', 'invalid phone');
    end if;
    if p_count <> 1 then
      return json_build_object('status', 'error', 'message', 'a code tied to a phone must be issued singly');
    end if;
  end if;

  if p_expires_hours is not null then
    if p_expires_hours < 1 or p_expires_hours > 24 * 60 then
      return json_build_object('status', 'error', 'message', 'expiry must be 1 hour to 60 days');
    end if;
    v_expires := now() + make_interval(hours => p_expires_hours);
  end if;

  while coalesce(array_length(v_out, 1), 0) < p_count loop
    v_tries := v_tries + 1;
    if v_tries > p_count * 5 then
      raise exception 'could not generate unique codes';
    end if;

    v_code := ypm_private.new_code();
    v_id   := gen_random_uuid();

    insert into public.voting_codes (id, code_hash, phone, note, created_by, expires_at)
    values (v_id, ypm_private.sha256_hex(ypm_private.normalize_code(v_code)),
            v_phone, nullif(btrim(coalesce(p_note, '')), ''), p_actor, v_expires)
    on conflict (code_hash) do nothing;

    if found then
      v_out := array_append(v_out, json_build_object(
                 'id', v_id, 'code', v_code, 'phone', v_phone,
                 'note', p_note, 'expires_at', v_expires));
    end if;
  end loop;

  perform ypm_private.audit(p_actor, 'codes_issued', jsonb_build_object(
    'count', p_count, 'phone_bound', v_phone is not null, 'note', p_note,
    'expires_at', v_expires));

  return json_build_object('status', 'ok', 'codes', array_to_json(v_out));
end;
$$;

-- Set or replace an admin key from the SQL editor (signs that person out):
--   select ypm_private.set_admin_key('leader', 'a-long-random-secret');
create or replace function ypm_private.set_admin_key(p_label text, p_key text)
returns text language plpgsql as $$
begin
  if coalesce(btrim(p_label), '') = '' then
    raise exception 'label required';
  end if;
  if length(coalesce(p_key, '')) < 16 then
    raise exception 'admin keys must be at least 16 characters';
  end if;

  insert into public.admin_users (label, key_hash)
  values (btrim(p_label), ypm_private.sha256_hex(p_key))
  on conflict (label) do update
    set key_hash = excluded.key_hash, revoked_at = null;

  delete from public.admin_sessions where label = btrim(p_label);
  perform ypm_private.audit('sql-editor', 'admin_key_set', jsonb_build_object('label', btrim(p_label)));
  return 'ok';
end;
$$;

-- Revoke an admin from the SQL editor (signs them out immediately):
--   select ypm_private.revoke_admin('leader');
create or replace function ypm_private.revoke_admin(p_label text)
returns text language plpgsql as $$
begin
  update public.admin_users set revoked_at = now() where label = p_label and revoked_at is null;
  delete from public.admin_sessions where label = p_label;
  perform ypm_private.audit('sql-editor', 'admin_revoked', jsonb_build_object('label', p_label));
  return 'ok';
end;
$$;

revoke all on all functions in schema ypm_private from public;

-- ---------- 4. Voter functions ----------

create or replace function public.voting_status()
returns json
language sql
security definer
set search_path = public
as $$
  select json_build_object(
    'voting_open',         coalesce((select voting_open         from settings where id = 1), true),
    'require_voting_code', coalesce((select require_voting_code from settings where id = 1), false)
  );
$$;

-- Start a ballot, or reopen your own unfinished one.
--
-- An unfinished ballot is reopened only for:
--   * the device that started it (it sends p_ballot_id), or
--   * the voting code it was started with, or
--   * an unused code a leader issued for this phone number.
-- Anyone else gets "resume_required" with no ballot id and no picks.
--
-- Statuses: started | resumed | already_voted | closed | code_required
--           | invalid_code | resume_required | rate_limited | error
create or replace function public.begin_ballot(
  p_name      text,
  p_phone     text,
  p_code      text default null,
  p_ballot_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings   public.settings;
  v_phone      text;
  v_ip         text;
  v_code_norm  text;
  v_code       public.voting_codes;
  v_code_ok    boolean := false;
  v_code_fresh boolean := false;   -- valid, unused and unexpired
  v_ballot     public.ballots;
  v_id         uuid;
  v_constraint text;
begin
  v_settings := (select s from settings s where s.id = 1);
  if not coalesce(v_settings.voting_open, true) then
    return json_build_object('status', 'closed');
  end if;

  v_phone := ypm_private.normalize_phone(p_phone);
  if coalesce(btrim(p_name), '') = '' or length(v_phone) < 10 then
    return json_build_object('status', 'error', 'message', 'name and phone required');
  end if;

  v_ip := ypm_private.client_ip();
  if ypm_private.voter_blocked(v_phone, v_ip) then
    return json_build_object('status', 'rate_limited');
  end if;

  -- A code, if given, must exist, not be revoked, and match this number if
  -- it was issued for one.
  v_code_norm := ypm_private.normalize_code(p_code);
  if v_code_norm is not null then
    v_code := (select c from voting_codes c where c.code_hash = ypm_private.sha256_hex(v_code_norm));
    v_code_ok := v_code.id is not null
                 and v_code.revoked_at is null
                 and (v_code.phone is null or v_code.phone = v_phone);
    if not v_code_ok then
      perform ypm_private.voter_failure(v_phone, v_ip);
      return json_build_object('status', 'invalid_code');
    end if;
    v_code_fresh := v_code.redeemed_at is null
                    and (v_code.expires_at is null or v_code.expires_at > now());
  end if;

  v_ballot := (select b from ballots b where b.voter_phone = v_phone);

  -- ---- This number already has a ballot ----
  if v_ballot.id is not null then
    if v_ballot.completed_at is not null then
      -- The code, if any, is not used up.
      return json_build_object('status', 'already_voted');
    end if;

    if p_ballot_id is not null and p_ballot_id = v_ballot.id then
      null;  -- the device that started it

    elsif v_code_ok and v_ballot.voting_code_id = v_code.id then
      null;  -- the code it was started with

    elsif v_code_ok and v_code_fresh and v_code.phone = v_phone then
      -- A leader issued a code for this number (lost phone, cleared browser,
      -- or a ballot started before codes existed). Attach it, so the voter
      -- can reopen the ballot with it from now on.
      update voting_codes set redeemed_at = now()
       where id = v_code.id and redeemed_at is null;
      if not found then
        return json_build_object('status', 'invalid_code');
      end if;
      update ballots set voting_code_id = v_code.id where id = v_ballot.id;

    else
      perform ypm_private.voter_failure(v_phone, v_ip);
      return json_build_object('status', 'resume_required');
    end if;

    return json_build_object('status', 'resumed',
                             'ballot_id', v_ballot.id,
                             'picks', ypm_private.ballot_picks(v_ballot.id));
  end if;

  -- ---- New ballot ----
  if coalesce(v_settings.require_voting_code, false) and not v_code_ok then
    return json_build_object('status', 'code_required');
  end if;

  if v_code_ok and not v_code_fresh then
    perform ypm_private.voter_failure(v_phone, v_ip);
    return json_build_object('status', 'invalid_code');
  end if;

  v_id := gen_random_uuid();
  begin
    insert into ballots (id, voter_name, voter_phone, voting_code_id)
    values (v_id, btrim(p_name), v_phone, case when v_code_ok then v_code.id end);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'ballots_voting_code_unique' then
      -- Someone redeemed this code a moment ago.
      return json_build_object('status', 'invalid_code');
    end if;
    -- Two devices started the same number at the same instant. Retrying
    -- goes through the "already has a ballot" path above.
    return json_build_object('status', 'error', 'message', 'please try again');
  end;

  if v_code_ok then
    update voting_codes set redeemed_at = now() where id = v_code.id;
  end if;

  return json_build_object('status', 'started', 'ballot_id', v_id, 'picks', '[]'::json);
end;
$$;

-- Kept for voting pages opened before this migration. Same behaviour as
-- begin_ballot with no code and no device, so it no longer reopens someone
-- else's ballot. Anything an old page can't display becomes an error, which
-- it shows as "Could not start".
create or replace function public.start_ballot(p_name text, p_phone text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result json;
begin
  v_result := public.begin_ballot(p_name, p_phone, null, null);
  if v_result->>'status' in ('started', 'resumed', 'closed', 'already_voted') then
    return v_result;
  end if;
  raise exception 'start_ballot: %', v_result->>'status'
    using hint = 'This voting page is out of date. Reload it.';
end;
$$;

-- save_vote and submit_ballot are unchanged: the ballot id itself is the
-- credential, and only the device that started or reopened a ballot has it.

-- ---------- 5. Admin functions (session required) ----------

create or replace function public.admin_login(p_key text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check   json;
  v_token   text;
  v_expires timestamptz := now() + interval '12 hours';
begin
  v_check := ypm_private.admin_check_key(p_key);
  if not (v_check->>'ok')::boolean then
    return json_build_object('status', v_check->>'reason');
  end if;

  v_token := ypm_private.random_token();
  delete from admin_sessions where expires_at < now();
  insert into admin_sessions (token_hash, label, expires_at)
  values (ypm_private.sha256_hex(v_token), v_check->>'label', v_expires);

  perform ypm_private.audit(v_check->>'label', 'login');

  return json_build_object(
    'status', 'ok',
    'session', v_token,
    'label', v_check->>'label',
    'expires_at', v_expires,
    'weak_key', length(coalesce(p_key, '')) < 16
  );
end;
$$;

create or replace function public.admin_logout(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from admin_sessions where token_hash = ypm_private.sha256_hex(p_session);
  return json_build_object('status', 'ok');
end;
$$;

create or replace function public.admin_dashboard(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return ypm_private.dashboard_json(v_label);
end;
$$;

create or replace function public.admin_set_voting_open(p_session text, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  update settings set voting_open = p_open where id = 1;
  perform ypm_private.audit(v_label, 'set_voting_open', jsonb_build_object('open', p_open));
  return json_build_object('status', 'ok', 'voting_open', p_open);
end;
$$;

create or replace function public.admin_set_code_required(p_session text, p_required boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  update settings set require_voting_code = p_required where id = 1;
  perform ypm_private.audit(v_label, 'set_code_required', jsonb_build_object('required', p_required));
  return json_build_object('status', 'ok', 'require_voting_code', p_required);
end;
$$;

-- Returns the codes in plain text. This is the only time they are visible.
create or replace function public.admin_issue_codes(
  p_session       text,
  p_count         int,
  p_phone         text default null,
  p_note          text default null,
  p_expires_hours int  default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return ypm_private.issue_codes(v_label, p_count, p_phone, p_note, p_expires_hours);
end;
$$;

create or replace function public.admin_list_codes(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return json_build_object('status', 'ok', 'codes', (
    select coalesce(json_agg(x), '[]'::json) from (
      select c.id, c.note, c.phone, c.created_by, c.created_at, c.expires_at,
             c.redeemed_at, c.revoked_at, b.voter_name,
             case
               when c.revoked_at  is not null then 'revoked'
               when c.redeemed_at is not null then 'used'
               when c.expires_at  is not null and c.expires_at <= now() then 'expired'
               else 'available'
             end as state
        from voting_codes c
        left join ballots b on b.voting_code_id = c.id
       order by c.created_at desc
       limit 500
    ) x
  ));
end;
$$;

create or replace function public.admin_revoke_code(p_session text, p_code_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  update voting_codes set revoked_at = now() where id = p_code_id and revoked_at is null;
  if not found then
    return json_build_object('status', 'error', 'message', 'no such active code');
  end if;
  perform ypm_private.audit(v_label, 'code_revoked', jsonb_build_object('code_id', p_code_id));
  return json_build_object('status', 'ok');
end;
$$;

create or replace function public.admin_audit_log(p_session text, p_limit int default 100)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return json_build_object('status', 'ok', 'events', (
    select coalesce(json_agg(x), '[]'::json) from (
      select at, actor, action, detail
        from admin_audit
       order by at desc, id desc
       limit least(greatest(coalesce(p_limit, 100), 1), 500)
    ) x
  ));
end;
$$;

-- ---------- 6. Old admin functions, kept for pages opened before this ----------
-- Same signatures and response shape; now checked against hashed keys and
-- rate limited. Drop them in a later migration once nobody uses them.

create or replace function public.get_tally(p_key text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check json := ypm_private.admin_check_key(p_key);
begin
  if not (v_check->>'ok')::boolean then
    return json_build_object('status', 'unauthorized');
  end if;
  return ypm_private.dashboard_json(v_check->>'label');
end;
$$;

create or replace function public.set_voting_open(p_key text, p_open boolean)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_check json := ypm_private.admin_check_key(p_key);
begin
  if not (v_check->>'ok')::boolean then
    return json_build_object('status', 'unauthorized');
  end if;
  update settings set voting_open = p_open where id = 1;
  perform ypm_private.audit(v_check->>'label', 'set_voting_open', jsonb_build_object('open', p_open));
  return json_build_object('status', 'ok', 'voting_open', p_open);
end;
$$;

-- ---------- 7. Grants ----------

grant execute on function public.voting_status()                              to anon;
grant execute on function public.begin_ballot(text, text, text, uuid)         to anon;
grant execute on function public.start_ballot(text, text)                     to anon;
grant execute on function public.admin_login(text)                            to anon;
grant execute on function public.admin_logout(text)                           to anon;
grant execute on function public.admin_dashboard(text)                        to anon;
grant execute on function public.admin_set_voting_open(text, boolean)         to anon;
grant execute on function public.admin_set_code_required(text, boolean)       to anon;
grant execute on function public.admin_issue_codes(text, int, text, text, int) to anon;
grant execute on function public.admin_list_codes(text)                       to anon;
grant execute on function public.admin_revoke_code(text, uuid)                to anon;
grant execute on function public.admin_audit_log(text, int)                   to anon;
grant execute on function public.get_tally(text)                              to anon;
grant execute on function public.set_voting_open(text, boolean)               to anon;

commit;

-- ---------- Handy queries ----------
-- Who can sign in:
--   select label, created_at, revoked_at from public.admin_users;
-- Set or change a key (16+ characters; signs that person out):
--   select ypm_private.set_admin_key('leader', 'a-long-random-secret');
-- Revoke someone:
--   select ypm_private.revoke_admin('leader');
-- Issue 20 codes from the SQL editor:
--   select ypm_private.issue_codes('leader', 20, null, 'Sunday service', null);
-- Turn the code requirement on or off:
--   update public.settings set require_voting_code = true where id = 1;
-- Recent admin activity:
--   select * from public.admin_audit order by at desc limit 50;
-- Once everything works, remove the old plaintext keys:
--   drop table public.admin_keys;
