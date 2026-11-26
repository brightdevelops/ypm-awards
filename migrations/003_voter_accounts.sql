-- ============================================================
-- YPM Youth Awards — Migration 003: registered voter accounts
--
--   1. Voter accounts, each with a reusable voter login code
--      ("YPM-XXXX-XXXX-XXXX", about 60 random bits). Codes are shown once
--      and stored only as a keyed hash (HMAC-SHA-256). The key lives in
--      Supabase Vault, not in any table.
--   2. Self-registration with a verification step, plus a review queue
--      for possible duplicates. NO biometric data: the only provider is a
--      development simulator (migrations/dev/simulated_verification.sql),
--      which refuses to run in production.
--   3. Registration by an admin, in person, without biometrics. This is
--      also how an existing anonymous ballot is attached to a voter, after
--      checking who they are. Nothing is ever linked by phone number alone.
--   4. Voter sign-in sessions; code replacement and revocation.
--   5. One ballot per registered voter (unique index + locks).
--   6. The existing voting functions can't be used to get around this:
--      a registered voter's number can't start or reopen an anonymous
--      ballot, and a voter's ballot can't be changed through save_vote or
--      submit_ballot.
--
-- Registration is OFF by default (settings.registration_mode = 'off').
-- With it off and no voters registered, voting works exactly as before.
--
-- DOES NOT modify or delete any existing ballot or vote. Adds one empty,
-- nullable column (ballots.voter_id).
--
-- The original begin_ballot (001), save_vote (002) and submit_ballot
-- (setup) are MOVED, unchanged, into ypm_private and wrapped by new public
-- functions with the same names, arguments and responses. 001, 002 and
-- their undo files refuse to run while this is installed (they would
-- replace the wrappers with the unprotected versions), and this file
-- refuses to run while 004 is installed.
--
-- Requires: 001 and 002 applied, and Supabase Vault (the supabase_vault
-- extension). Review before running. Development project first.
-- Safe to run more than once. Undo with 003_voter_accounts.down.sql.
--
-- Written with ":=" assignments, not "SELECT ... INTO" (Supabase SQL
-- editor quirk; see 001).
-- ============================================================

begin;

-- Refuses to run while migration 004 is installed: it would silently
-- replace 004's development-only wrappers with the unguarded 003 versions.
do $$
begin
  if to_regprocedure('ypm_private.voter_accounts_enabled()') is not null then
    raise exception 'Migration 004 is installed. Run 004_voter_safeguards.down.sql first, then 003, then 004 again.';
  end if;
end;
$$;

-- ---------- 0. Preconditions ----------

do $$
begin
  if to_regprocedure('ypm_private.admin_session_label(text)') is null then
    raise exception 'Run 001_secure_voting.sql first.';
  end if;
  if to_regclass('public.ballot_nominees') is null then
    raise exception 'Run 002_ballot_validation.sql first.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'Supabase Vault is not available. Enable the supabase_vault extension (Database > Extensions) and run this again.';
  end if;
end;
$$;

-- ---------- 1. Where this database runs ----------
-- Defaults to production. Only someone with SQL-editor access can mark a
-- project as development, which the simulated provider requires.
--   update ypm_private.deployment set environment = 'development';

create table if not exists ypm_private.deployment (
  id           int primary key default 1 check (id = 1),
  environment  text not null default 'production'
               check (environment in ('production', 'development'))
);
insert into ypm_private.deployment (id) values (1) on conflict do nothing;
revoke all on ypm_private.deployment from public;

create or replace function ypm_private.is_development()
returns boolean language sql stable as $$
  select coalesce((select environment = 'development' from ypm_private.deployment where id = 1), false);
$$;

-- ---------- 2. Settings ----------

alter table public.settings
  add column if not exists registration_mode text not null default 'off'
    check (registration_mode in ('off', 'optional', 'required'));
alter table public.settings
  add column if not exists verification_provider text not null default 'none'
    check (verification_provider in ('none', 'simulated'));

-- The simulator can only be switched on in a development project.
create or replace function ypm_private.guard_settings()
returns trigger language plpgsql as $$
begin
  if new.verification_provider = 'simulated' and not ypm_private.is_development() then
    raise exception 'The simulated verification provider is only allowed in a development project.';
  end if;
  return new;
end;
$$;

drop trigger if exists settings_guard on public.settings;
create trigger settings_guard
  before insert or update on public.settings
  for each row execute function ypm_private.guard_settings();

-- ---------- 3. Tables ----------

create table if not exists public.voters (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null check (btrim(full_name) <> ''),
  phone            text not null unique,             -- normalised
  status           text not null default 'active' check (status in ('active', 'revoked')),
  method           text not null check (method in ('in_person', 'face_simulated')),
  code_hash        text not null unique,             -- HMAC-SHA-256 of the code
  code_issued_at   timestamptz not null default now(),
  consent_version  text,
  consent_at       timestamptz,
  adult_confirmed  boolean not null default false,
  created_by       text not null,                    -- 'self' or an admin label
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz,
  revoked_at       timestamptz,
  revoked_reason   text
);

create table if not exists public.voter_registrations (
  id               uuid primary key default gen_random_uuid(),
  token_hash       text not null unique,
  full_name        text not null,
  phone            text not null,
  consent_version  text not null,
  consent_at       timestamptz not null default now(),
  adult_confirmed  boolean not null,
  provider         text not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'approved', 'review', 'failed',
                                     'claimed', 'rejected', 'expired')),
  provider_ref     text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  voter_id         uuid references public.voters(id),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);
create index if not exists voter_registrations_status on public.voter_registrations (status);

create table if not exists public.voter_sessions (
  token_hash  text primary key,
  voter_id    uuid not null references public.voters(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);

-- Nullable, no default: existing ballots stay exactly as they are.
alter table public.ballots
  add column if not exists voter_id uuid references public.voters(id);
-- One ballot per registered voter.
create unique index if not exists ballots_voter_unique on public.ballots (voter_id);

alter table public.voters               enable row level security;
alter table public.voter_registrations  enable row level security;
alter table public.voter_sessions       enable row level security;
revoke all on public.voters, public.voter_registrations, public.voter_sessions
  from anon, authenticated;

-- ---------- 4. The hashing key, in Vault ----------
-- Created once, randomly, and never displayed. Replacing it makes every
-- existing voter code stop working.

do $$
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'ypm_voter_code_pepper') then
    perform vault.create_secret(
      ypm_private.random_token() || ypm_private.random_token(),
      'ypm_voter_code_pepper',
      'YPM Awards: key for hashing voter login codes. Never share or change it.'
    );
  end if;
end;
$$;

create or replace function ypm_private.voter_pepper()
returns bytea language plpgsql stable as $$
declare
  v text;
begin
  v := (select decrypted_secret from vault.decrypted_secrets
         where name = 'ypm_voter_code_pepper' limit 1);
  if v is null or length(v) < 32 then
    raise exception 'voter code key is missing from Vault';
  end if;
  return convert_to(v, 'UTF8');
end;
$$;

-- HMAC-SHA-256 (RFC 2104) on the built-in sha256(), so no extension is needed.
create or replace function ypm_private.hmac_sha256(p_key bytea, p_msg bytea)
returns bytea language plpgsql immutable as $$
declare
  k     bytea := p_key;
  ipad  bytea;
  opad  bytea;
  i     int;
begin
  if length(k) > 64 then
    k := sha256(k);
  end if;
  k := k || decode(repeat('00', 64 - length(k)), 'hex');
  ipad := k;
  opad := k;
  for i in 0..63 loop
    ipad := set_byte(ipad, i, get_byte(k, i) # 54);   -- 0x36
    opad := set_byte(opad, i, get_byte(k, i) # 92);   -- 0x5c
  end loop;
  return sha256(opad || sha256(ipad || p_msg));
end;
$$;

-- ---------- 5. Voter codes ----------

-- "ypm-abcd 2345-hjkm" -> "YPMABCD2345HJKM"; null if it isn't a voter code.
create or replace function ypm_private.normalize_voter_code(p text)
returns text language sql immutable as $$
  select case
    when s ~ '^YPM[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$' then s
  end
  from (select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g')) as s) x;
$$;

-- 12 characters from the same 32-letter alphabet as voting codes: 60 random
-- bits, taken 5 at a time from 12 random bytes of a v4 UUID (byte 6 skipped,
-- its high bits hold the version number).
create or replace function ypm_private.new_voter_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_out   text  := '';
  i       int;
begin
  foreach i in array array[0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12] loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return 'YPM-' || substr(v_out, 1, 4) || '-' || substr(v_out, 5, 4) || '-' || substr(v_out, 9, 4);
end;
$$;

create or replace function ypm_private.voter_code_hash(p_code text)
returns text language plpgsql stable as $$
declare
  v_norm text := ypm_private.normalize_voter_code(p_code);
begin
  if v_norm is null then
    return null;
  end if;
  return encode(ypm_private.hmac_sha256(ypm_private.voter_pepper(), convert_to(v_norm, 'UTF8')), 'hex');
end;
$$;

-- Serialises everything that creates a voter or a ballot for one number.
create or replace function ypm_private.lock_phone(p_phone text)
returns void language sql as $$
  select pg_advisory_xact_lock(hashtextextended('ypm:phone:' || p_phone, 0));
$$;

create or replace function ypm_private.mask_phone(p text)
returns text language sql immutable as $$
  select case when length(coalesce(p, '')) <= 4 then '••••' else '•••• ' || right(p, 4) end;
$$;

-- Creates the voter and returns { voter_id, code }. Caller holds the
-- phone lock and has checked the number is free.
create or replace function ypm_private.create_voter(
  p_name text, p_phone text, p_method text, p_created_by text,
  p_consent_version text, p_consent_at timestamptz, p_adult boolean
)
returns json language plpgsql as $$
declare
  v_code  text;
  v_id    uuid := gen_random_uuid();
  v_tries int := 0;
begin
  loop
    v_tries := v_tries + 1;
    v_code := ypm_private.new_voter_code();
    begin
      insert into public.voters (id, full_name, phone, method, code_hash, created_by,
                                 consent_version, consent_at, adult_confirmed)
      values (v_id, btrim(p_name), p_phone, p_method, ypm_private.voter_code_hash(v_code),
              p_created_by, p_consent_version, p_consent_at, coalesce(p_adult, false));
      exit;
    exception when unique_violation then
      if v_tries >= 5 then
        raise;
      end if;
    end;
  end loop;
  return json_build_object('voter_id', v_id, 'code', v_code);
end;
$$;

create or replace function ypm_private.new_voter_session(p_voter_id uuid)
returns json language plpgsql as $$
declare
  v_token   text := ypm_private.random_token();
  v_expires timestamptz := now() + interval '24 hours';
begin
  delete from public.voter_sessions where expires_at < now();
  insert into public.voter_sessions (token_hash, voter_id, expires_at)
  values (ypm_private.sha256_hex(v_token), p_voter_id, v_expires);
  return json_build_object('session', v_token, 'expires_at', v_expires);
end;
$$;

-- The active voter behind a session, or null.
create or replace function ypm_private.voter_from_session(p_session text)
returns public.voters language sql stable as $$
  select v
    from public.voter_sessions s
    join public.voters v on v.id = s.voter_id
   where s.token_hash = ypm_private.sha256_hex(p_session)
     and s.expires_at > now()
     and v.status = 'active';
$$;

create or replace function ypm_private.ballot_state(p_voter_id uuid)
returns json language sql stable as $$
  select coalesce(
    (select json_build_object(
              'state', case when b.completed_at is not null then 'submitted' else 'in_progress' end,
              'answered', (select count(*) from public.votes v where v.ballot_id = b.id))
       from public.ballots b where b.voter_id = p_voter_id),
    json_build_object('state', 'none', 'answered', 0));
$$;

create or replace function ypm_private.first_name(p text)
returns text language sql immutable as $$
  select split_part(btrim(p), ' ', 1);
$$;

revoke all on all functions in schema ypm_private from public;
revoke all on all tables in schema ypm_private from public;

-- ---------- 6. Move the original voting functions behind wrappers ----------
-- Moved unchanged (same body, owner, security definer, search_path).

do $$
begin
  if to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is null then
    alter function public.begin_ballot(text, text, text, uuid) set schema ypm_private;
    alter function ypm_private.begin_ballot(text, text, text, uuid) rename to begin_ballot_001;
  end if;
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is null then
    alter function public.save_vote(uuid, text, text) set schema ypm_private;
    alter function ypm_private.save_vote(uuid, text, text) rename to save_vote_002;
  end if;
  if to_regprocedure('ypm_private.submit_ballot_000(uuid)') is null then
    alter function public.submit_ballot(uuid) set schema ypm_private;
    alter function ypm_private.submit_ballot(uuid) rename to submit_ballot_000;
  end if;
end;
$$;

revoke all on function ypm_private.begin_ballot_001(text, text, text, uuid) from public, anon, authenticated;
revoke all on function ypm_private.save_vote_002(uuid, text, text)          from public, anon, authenticated;
revoke all on function ypm_private.submit_ballot_000(uuid)                  from public, anon, authenticated;

-- Same arguments and responses as before, plus two refusals:
--   registered_voter       this number belongs to a registered voter: sign
--                          in with the voter code instead
--   registration_required  registration_mode = 'required' and this number
--                          has no ballot yet
-- Old pages show both as "Could not start" (start_ballot raises on them).
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
  v_settings public.settings;
  v_phone    text := ypm_private.normalize_phone(p_phone);
begin
  v_settings := (select s from settings s where s.id = 1);
  if coalesce(v_settings.voting_open, true) and length(v_phone) >= 10 then
    perform ypm_private.lock_phone(v_phone);
    if exists (select 1 from voters where phone = v_phone)
       or exists (select 1 from ballots where voter_phone = v_phone and voter_id is not null) then
      return json_build_object('status', 'registered_voter');
    end if;
    if v_settings.registration_mode = 'required'
       and not exists (select 1 from ballots where voter_phone = v_phone) then
      return json_build_object('status', 'registration_required');
    end if;
  end if;
  return ypm_private.begin_ballot_001(p_name, p_phone, p_code, p_ballot_id);
end;
$$;

-- A registered voter's ballot can only be changed through voter_save_vote.
create or replace function public.save_vote(
  p_ballot_id uuid, p_category_id text, p_nominee_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from ballots where id = p_ballot_id and voter_id is not null) then
    return json_build_object('status', 'error', 'message', 'sign in with your voter code');
  end if;
  return ypm_private.save_vote_002(p_ballot_id, p_category_id, p_nominee_name);
end;
$$;

create or replace function public.submit_ballot(p_ballot_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from ballots where id = p_ballot_id and voter_id is not null) then
    return json_build_object('status', 'error', 'message', 'sign in with your voter code');
  end if;
  return ypm_private.submit_ballot_000(p_ballot_id);
end;
$$;

-- ---------- 7. Self-registration ----------

-- Statuses: ok | registration_off | verification_unavailable | adult_required
--           | needs_assistance | rate_limited | error
-- "needs_assistance" covers both "already registered" and "already has a
-- ballot", so this can't be used to find out who has registered.
create or replace function public.voter_registration_start(
  p_name text, p_phone text, p_consent_version text, p_adult boolean
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.settings;
  v_phone    text := ypm_private.normalize_phone(p_phone);
  v_ip       text := ypm_private.client_ip();
  v_token    text;
  v_expires  timestamptz := now() + interval '30 minutes';
begin
  v_settings := (select s from settings s where s.id = 1);
  if v_settings.registration_mode = 'off' then
    return json_build_object('status', 'registration_off');
  end if;
  if v_settings.verification_provider = 'none' then
    return json_build_object('status', 'verification_unavailable');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(v_phone) < 10
     or coalesce(btrim(p_consent_version), '') = '' then
    return json_build_object('status', 'error', 'message', 'name, phone and consent required');
  end if;
  if coalesce(p_adult, false) is not true then
    return json_build_object('status', 'adult_required');
  end if;

  if ypm_private.rate_limited('register:phone:' || v_phone, 5, interval '1 hour')
     or (v_ip <> 'unknown'
         and ypm_private.rate_limited('register:ip:' || v_ip, 60, interval '15 minutes')) then
    return json_build_object('status', 'rate_limited');
  end if;
  perform ypm_private.rate_hit('register:phone:' || v_phone);
  if v_ip <> 'unknown' then
    perform ypm_private.rate_hit('register:ip:' || v_ip);
  end if;

  if exists (select 1 from voters where phone = v_phone)
     or exists (select 1 from ballots where voter_phone = v_phone) then
    return json_build_object('status', 'needs_assistance');
  end if;

  delete from voter_registrations
   where expires_at < now() - interval '1 day' and status in ('pending', 'approved', 'failed', 'expired');

  v_token := ypm_private.random_token();
  insert into voter_registrations (token_hash, full_name, phone, consent_version,
                                   adult_confirmed, provider, expires_at)
  values (ypm_private.sha256_hex(v_token), btrim(p_name), v_phone, btrim(p_consent_version),
          true, v_settings.verification_provider, v_expires);

  return json_build_object('status', 'ok', 'registration_token', v_token, 'expires_at', v_expires);
end;
$$;

-- Statuses: pending | approved | review | failed | claimed | rejected
--           | expired | invalid
create or replace function public.voter_registration_status(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg public.voter_registrations;
begin
  v_reg := (select r from voter_registrations r where r.token_hash = ypm_private.sha256_hex(p_token));
  if v_reg.id is null then
    return json_build_object('status', 'invalid');
  end if;
  if v_reg.status in ('pending', 'approved') and v_reg.expires_at <= now() then
    update voter_registrations set status = 'expired' where id = v_reg.id;
    return json_build_object('status', 'expired');
  end if;
  return json_build_object('status', v_reg.status);
end;
$$;

-- Once only: returns the voter code and a session. Statuses: ok | invalid
-- | not_ready | expired | needs_assistance
create or replace function public.voter_registration_claim(p_token text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reg     public.voter_registrations;
  v_created json;
  v_session json;
begin
  v_reg := (select r from voter_registrations r
             where r.token_hash = ypm_private.sha256_hex(p_token) for update);
  if v_reg.id is null or v_reg.status in ('claimed', 'rejected') then
    return json_build_object('status', 'invalid');
  end if;
  if v_reg.expires_at <= now() then
    update voter_registrations set status = 'expired'
     where id = v_reg.id and status in ('pending', 'approved');
    return json_build_object('status', 'expired');
  end if;
  if v_reg.status <> 'approved' then
    return json_build_object('status', 'not_ready', 'registration', v_reg.status);
  end if;

  perform ypm_private.lock_phone(v_reg.phone);
  if exists (select 1 from voters where phone = v_reg.phone)
     or exists (select 1 from ballots where voter_phone = v_reg.phone) then
    update voter_registrations set status = 'review' where id = v_reg.id;
    return json_build_object('status', 'needs_assistance');
  end if;

  v_created := ypm_private.create_voter(
    v_reg.full_name, v_reg.phone,
    case v_reg.provider when 'simulated' then 'face_simulated' end,
    'self', v_reg.consent_version, v_reg.consent_at, v_reg.adult_confirmed);

  update voter_registrations
     set status = 'claimed', voter_id = (v_created->>'voter_id')::uuid
   where id = v_reg.id;

  v_session := ypm_private.new_voter_session((v_created->>'voter_id')::uuid);
  return json_build_object(
    'status', 'ok',
    'voter_code', v_created->>'code',
    'session', v_session->>'session',
    'expires_at', v_session->>'expires_at',
    'first_name', ypm_private.first_name(v_reg.full_name)
  );
end;
$$;

-- ---------- 8. Voter sign-in and ballot ----------

-- Statuses: ok | invalid | rate_limited. Revoked and unknown codes look
-- the same. Works whatever registration_mode is, so registered voters can
-- always reach their ballot.
create or replace function public.voter_login(p_code text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ip      text := ypm_private.client_ip();
  v_bucket  text := 'voter-login:ip:' || v_ip;
  v_hash    text;
  v_voter   public.voters;
  v_session json;
begin
  if ypm_private.rate_limited(v_bucket, case when v_ip = 'unknown' then 200 else 30 end,
                              interval '15 minutes') then
    return json_build_object('status', 'rate_limited');
  end if;

  v_hash := ypm_private.voter_code_hash(p_code);
  if v_hash is not null then
    v_voter := (select v from voters v where v.code_hash = v_hash and v.status = 'active');
  end if;
  if v_voter.id is null then
    perform ypm_private.rate_hit(v_bucket);
    return json_build_object('status', 'invalid');
  end if;

  update voters set last_login_at = now() where id = v_voter.id;
  v_session := ypm_private.new_voter_session(v_voter.id);
  return json_build_object(
    'status', 'ok',
    'session', v_session->>'session',
    'expires_at', v_session->>'expires_at',
    'first_name', ypm_private.first_name(v_voter.full_name),
    'ballot', ypm_private.ballot_state(v_voter.id)
  );
end;
$$;

create or replace function public.voter_logout(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from voter_sessions where token_hash = ypm_private.sha256_hex(p_session);
  return json_build_object('status', 'ok');
end;
$$;

-- Statuses: started | resumed | already_voted | closed | needs_assistance
-- | unauthorized. The ballot id is never returned: the session is the
-- credential, so the old functions can't be pointed at this ballot.
create or replace function public.voter_begin_ballot(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_voter  public.voters := ypm_private.voter_from_session(p_session);
  v_ballot public.ballots;
begin
  if v_voter.id is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if not coalesce((select voting_open from settings where id = 1), true) then
    return json_build_object('status', 'closed');
  end if;

  perform ypm_private.lock_phone(v_voter.phone);
  perform 1 from voters where id = v_voter.id for update;

  v_ballot := (select b from ballots b where b.voter_id = v_voter.id);
  if v_ballot.id is null then
    -- An anonymous ballot for this number is settled in person, never linked here.
    if exists (select 1 from ballots where voter_phone = v_voter.phone) then
      return json_build_object('status', 'needs_assistance');
    end if;
    begin
      insert into ballots (voter_name, voter_phone, voter_id)
      values (v_voter.full_name, v_voter.phone, v_voter.id);
      return json_build_object('status', 'started', 'picks', '[]'::json);
    exception when unique_violation then
      null;  -- a parallel request got there first; use its ballot below
    end;
    v_ballot := (select b from ballots b where b.voter_id = v_voter.id);
    if v_ballot.id is null then
      return json_build_object('status', 'needs_assistance');
    end if;
  end if;

  if v_ballot.completed_at is not null then
    return json_build_object('status', 'already_voted');
  end if;
  return json_build_object('status', 'resumed', 'picks', ypm_private.ballot_picks(v_ballot.id));
end;
$$;

create or replace function public.voter_save_vote(
  p_session text, p_category_id text, p_nominee_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_voter  public.voters := ypm_private.voter_from_session(p_session);
  v_ballot uuid;
begin
  if v_voter.id is null then
    return json_build_object('status', 'unauthorized');
  end if;
  v_ballot := (select id from ballots where voter_id = v_voter.id);
  if v_ballot is null then
    return json_build_object('status', 'error', 'message', 'no ballot');
  end if;
  return ypm_private.save_vote_002(v_ballot, p_category_id, p_nominee_name);
end;
$$;

create or replace function public.voter_submit_ballot(p_session text)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_voter  public.voters := ypm_private.voter_from_session(p_session);
  v_ballot uuid;
begin
  if v_voter.id is null then
    return json_build_object('status', 'unauthorized');
  end if;
  v_ballot := (select id from ballots where voter_id = v_voter.id);
  if v_ballot is null then
    return json_build_object('status', 'error', 'message', 'no ballot');
  end if;
  return ypm_private.submit_ballot_000(v_ballot);
end;
$$;

-- ---------- 9. Admin functions (session required, all audited) ----------

-- In person, no biometrics. If the number already has an anonymous ballot,
-- the admin must confirm who they are and pass p_link_existing_ballot =>
-- true to attach it. Statuses: ok (with the code, shown once) |
-- unauthorized | error | phone_registered | phone_has_ballot
create or replace function public.admin_register_voter(
  p_session text, p_name text, p_phone text, p_link_existing_ballot boolean default false
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label   text := ypm_private.admin_session_label(p_session);
  v_phone   text := ypm_private.normalize_phone(p_phone);
  v_ballot  public.ballots;
  v_created json;
  v_id      uuid;
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(v_phone) < 10 then
    return json_build_object('status', 'error', 'message', 'name and phone required');
  end if;

  perform ypm_private.lock_phone(v_phone);
  if exists (select 1 from voters where phone = v_phone) then
    return json_build_object('status', 'phone_registered');
  end if;
  v_ballot := (select b from ballots b where b.voter_phone = v_phone);
  if v_ballot.id is not null and not coalesce(p_link_existing_ballot, false) then
    return json_build_object('status', 'phone_has_ballot',
                             'ballot', case when v_ballot.completed_at is null
                                            then 'in_progress' else 'submitted' end);
  end if;

  v_created := ypm_private.create_voter(p_name, v_phone, 'in_person', v_label, null, null, false);
  v_id := (v_created->>'voter_id')::uuid;
  if v_ballot.id is not null then
    update ballots set voter_id = v_id where id = v_ballot.id and voter_id is null;
  end if;

  perform ypm_private.audit(v_label, 'voter_registered_in_person', jsonb_build_object(
    'voter_id', v_id, 'linked_ballot', v_ballot.id is not null));
  return json_build_object('status', 'ok', 'voter_id', v_id, 'voter_code', v_created->>'code',
                           'linked_ballot', v_ballot.id is not null);
end;
$$;

-- Masked phone numbers only. Search: name text, or the last digits of a number.
create or replace function public.admin_list_voters(
  p_session text, p_search text default null, p_limit int default 50, p_offset int default 0
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label  text := ypm_private.admin_session_label(p_session);
  v_q      text := btrim(coalesce(p_search, ''));
  v_digits text := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_lim    int  := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_off    int  := greatest(coalesce(p_offset, 0), 0);
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return (
    with matched as (
      select v.*
        from voters v
       where v_q = ''
          or (v_digits <> '' and v_digits = regexp_replace(v_q, '[\s•]', '', 'g')
              and v.phone like '%' || v_digits)
          or (v_digits = '' and v.full_name ilike '%' || v_q || '%')
    )
    select json_build_object(
      'status', 'ok',
      'total', (select count(*) from matched),
      'voters', coalesce((
        select json_agg(x) from (
          select m.id, m.full_name, ypm_private.mask_phone(m.phone) as phone, m.status,
                 m.method, m.created_by, m.created_at, m.last_login_at, m.revoked_at,
                 (ypm_private.ballot_state(m.id))->>'state' as ballot
            from matched m
           order by m.created_at desc
           limit v_lim offset v_off
        ) x), '[]'::json)
    )
  );
end;
$$;

-- Recovery after an in-person check: the old code and sessions stop
-- working, a new code is shown once. Statuses: ok | unauthorized |
-- not_found | revoked
create or replace function public.admin_reissue_voter_code(p_session text, p_voter_id uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := ypm_private.admin_session_label(p_session);
  v_voter public.voters;
  v_code  text;
  v_tries int := 0;
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  v_voter := (select v from voters v where v.id = p_voter_id for update);
  if v_voter.id is null then
    return json_build_object('status', 'not_found');
  end if;
  if v_voter.status <> 'active' then
    return json_build_object('status', 'revoked');
  end if;

  loop
    v_tries := v_tries + 1;
    v_code := ypm_private.new_voter_code();
    begin
      update voters set code_hash = ypm_private.voter_code_hash(v_code), code_issued_at = now()
       where id = v_voter.id;
      exit;
    exception when unique_violation then
      if v_tries >= 5 then
        raise;
      end if;
    end;
  end loop;
  delete from voter_sessions where voter_id = v_voter.id;

  perform ypm_private.audit(v_label, 'voter_code_reissued', jsonb_build_object('voter_id', v_voter.id));
  return json_build_object('status', 'ok', 'voter_code', v_code);
end;
$$;

-- The account stops working at once. Its ballot and votes are kept.
create or replace function public.admin_revoke_voter(p_session text, p_voter_id uuid, p_reason text default null)
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
  update voters
     set status = 'revoked', revoked_at = now(), revoked_reason = nullif(btrim(coalesce(p_reason, '')), '')
   where id = p_voter_id and status = 'active';
  if not found then
    return json_build_object('status', 'error', 'message', 'no such active voter');
  end if;
  delete from voter_sessions where voter_id = p_voter_id;
  perform ypm_private.audit(v_label, 'voter_revoked', jsonb_build_object('voter_id', p_voter_id));
  return json_build_object('status', 'ok');
end;
$$;

create or replace function public.admin_list_reviews(p_session text)
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
  return json_build_object('status', 'ok', 'reviews', coalesce((
    select json_agg(x) from (
      select r.id, r.full_name, ypm_private.mask_phone(r.phone) as phone, r.provider, r.created_at
        from voter_registrations r
       where r.status = 'review'
       order by r.created_at
       limit 500
    ) x), '[]'::json));
end;
$$;

-- After checking the person in person. approve: creates the voter and
-- returns the code once, for the admin to hand over. reject: closes it.
create or replace function public.admin_resolve_review(
  p_session text, p_registration_id uuid, p_decision text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label   text := ypm_private.admin_session_label(p_session);
  v_reg     public.voter_registrations;
  v_created json;
begin
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if p_decision not in ('approve', 'reject') then
    return json_build_object('status', 'error', 'message', 'decision must be approve or reject');
  end if;
  v_reg := (select r from voter_registrations r where r.id = p_registration_id for update);
  if v_reg.id is null or v_reg.status <> 'review' then
    return json_build_object('status', 'error', 'message', 'no such registration awaiting review');
  end if;

  if p_decision = 'reject' then
    update voter_registrations set status = 'rejected', reviewed_by = v_label, reviewed_at = now()
     where id = v_reg.id;
    perform ypm_private.audit(v_label, 'registration_rejected', jsonb_build_object('registration_id', v_reg.id));
    return json_build_object('status', 'ok');
  end if;

  perform ypm_private.lock_phone(v_reg.phone);
  if exists (select 1 from voters where phone = v_reg.phone) then
    return json_build_object('status', 'phone_registered');
  end if;
  if exists (select 1 from ballots where voter_phone = v_reg.phone) then
    return json_build_object('status', 'phone_has_ballot');
  end if;

  v_created := ypm_private.create_voter(
    v_reg.full_name, v_reg.phone,
    case v_reg.provider when 'simulated' then 'face_simulated' end,
    v_label, v_reg.consent_version, v_reg.consent_at, v_reg.adult_confirmed);
  update voter_registrations
     set status = 'claimed', voter_id = (v_created->>'voter_id')::uuid,
         reviewed_by = v_label, reviewed_at = now()
   where id = v_reg.id;
  perform ypm_private.audit(v_label, 'registration_approved', jsonb_build_object(
    'registration_id', v_reg.id, 'voter_id', v_created->>'voter_id'));
  return json_build_object('status', 'ok', 'voter_code', v_created->>'code');
end;
$$;

create or replace function public.admin_set_registration_mode(p_session text, p_mode text)
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
  if p_mode not in ('off', 'optional', 'required') then
    return json_build_object('status', 'error', 'message', 'mode must be off, optional or required');
  end if;
  update settings set registration_mode = p_mode where id = 1;
  perform ypm_private.audit(v_label, 'set_registration_mode', jsonb_build_object('mode', p_mode));
  return json_build_object('status', 'ok', 'registration_mode', p_mode);
end;
$$;

create or replace function public.admin_voter_stats(p_session text)
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
  return json_build_object(
    'status', 'ok',
    'registration_mode',     (select registration_mode from settings where id = 1),
    'verification_provider', (select verification_provider from settings where id = 1),
    'voters_active',  (select count(*) from voters where status = 'active'),
    'voters_revoked', (select count(*) from voters where status = 'revoked'),
    'in_person',      (select count(*) from voters where method = 'in_person'),
    'self_registered',(select count(*) from voters where created_by = 'self'),
    'reviews_pending',(select count(*) from voter_registrations where status = 'review'),
    'voter_ballots_submitted',
      (select count(*) from ballots where voter_id is not null and completed_at is not null)
  );
end;
$$;

-- ---------- 10. Grants ----------

grant execute on function public.begin_ballot(text, text, text, uuid)              to anon;
grant execute on function public.save_vote(uuid, text, text)                       to anon;
grant execute on function public.submit_ballot(uuid)                               to anon;
grant execute on function public.voter_registration_start(text, text, text, boolean) to anon;
grant execute on function public.voter_registration_status(text)                   to anon;
grant execute on function public.voter_registration_claim(text)                    to anon;
grant execute on function public.voter_login(text)                                 to anon;
grant execute on function public.voter_logout(text)                                to anon;
grant execute on function public.voter_begin_ballot(text)                          to anon;
grant execute on function public.voter_save_vote(text, text, text)                 to anon;
grant execute on function public.voter_submit_ballot(text)                         to anon;
grant execute on function public.admin_register_voter(text, text, text, boolean)   to anon;
grant execute on function public.admin_list_voters(text, text, int, int)           to anon;
grant execute on function public.admin_reissue_voter_code(text, uuid)              to anon;
grant execute on function public.admin_revoke_voter(text, uuid, text)              to anon;
grant execute on function public.admin_list_reviews(text)                          to anon;
grant execute on function public.admin_resolve_review(text, uuid, text)            to anon;
grant execute on function public.admin_set_registration_mode(text, text)           to anon;
grant execute on function public.admin_voter_stats(text)                           to anon;

commit;

-- ---------- Handy queries ----------
-- Registration and provider settings:
--   select registration_mode, verification_provider from public.settings;
-- Is this project marked as development? (needed for the simulator)
--   select environment from ypm_private.deployment;
-- Registered voters (no codes are stored, only hashes):
--   select full_name, status, method, created_by, created_at from public.voters;
