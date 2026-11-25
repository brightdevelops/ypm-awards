-- ============================================================
-- YPM Youth Awards — Migration 004: voter account safeguards
--
--   1. Development only, enforced by the database. Every voter-account
--      function answers {"status":"disabled"} unless the project is marked
--      as development (ypm_private.deployment). Production stays disabled
--      until a later migration, with explicit approval, changes that.
--      Online registration can't be switched on, and a project can't be
--      switched back to production while registration or simulated
--      verification is on.
--   2. Restoring a revoked voter (admin_restore_voter). It always issues a
--      NEW code. Every replaced code is remembered as a keyed hash
--      (ypm_private.retired_voter_codes) and can never be issued or used
--      again.
--   3. Approving a review can link the number's existing anonymous ballot
--      (admin_resolve_review(..., p_link_existing_ballot)), after the admin
--      has checked who the person is. Votes are kept; one ballot per voter
--      and per number, under the same locks as before.
--   4. Consent records (public.voter_consents): which notice version, how
--      (online / in person), adult confirmed, biometric = false, when and
--      by whom. Append-only. Versions are tracked in
--      ypm_private.consent_versions. In-person registration now needs a
--      current consent version and an adult confirmation (under-18
--      registration is deferred). No consent is invented for accounts made
--      before this migration without one.
--   5. ypm_private.erase_voter: the only way to delete an account and its
--      consent records (database owner only; see the retention policy in
--      migrations/README.md). Ballots and votes are kept.
--
-- The 003 functions are MOVED, unchanged, into ypm_private (named *_003)
-- and wrapped by public functions with the same names. Two change their
-- arguments: admin_register_voter (consent) and admin_resolve_review
-- (ballot linking). If 003 is re-run after this, re-run this file too.
--
-- Anonymous voting (begin_ballot, save_vote, submit_ballot, voting_status)
-- is not changed. No ballot or vote is modified or deleted.
--
-- Requires 001, 002 and 003. Safe to run more than once.
-- Undo with 004_voter_safeguards.down.sql (before 003's undo).
-- Written with ":=" assignments, not "SELECT ... INTO" (SQL editor quirk).
-- ============================================================

begin;

-- ---------- 0. Preconditions ----------

do $$
begin
  if to_regclass('public.voters') is null
     or to_regprocedure('ypm_private.is_development()') is null then
    raise exception 'Run 003_voter_accounts.sql first.';
  end if;
  -- A project that isn't development must not have voter features on.
  if not ypm_private.is_development()
     and exists (select 1 from public.settings
                  where id = 1
                    and (registration_mode <> 'off' or verification_provider <> 'none')) then
    raise exception 'This project is not marked as development, but registration or simulated verification is on. Set registration_mode = ''off'' and verification_provider = ''none'' first.';
  end if;
end;
$$;

-- ---------- 1. The switch ----------

-- One place that decides whether voter accounts may be used. For now:
-- development projects only.
create or replace function ypm_private.voter_accounts_enabled()
returns boolean language sql stable as $$
  select ypm_private.is_development();
$$;

create or replace function ypm_private.disabled_reply()
returns json language sql immutable as $$
  select json_build_object('status', 'disabled');
$$;

-- Online registration can only be switched on where voter accounts are
-- enabled. Only checked when the mode itself changes, so other settings
-- (voting open, codes required) are never blocked.
create or replace function ypm_private.guard_settings_004()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' or new.registration_mode is distinct from old.registration_mode)
     and new.registration_mode <> 'off'
     and not ypm_private.voter_accounts_enabled() then
    raise exception 'Online registration can only be switched on in a development project.';
  end if;
  return new;
end;
$$;

drop trigger if exists settings_guard_004 on public.settings;
create trigger settings_guard_004
  before insert or update on public.settings
  for each row execute function ypm_private.guard_settings_004();

-- Leaving development needs registration off and no simulated provider.
create or replace function ypm_private.guard_deployment()
returns trigger language plpgsql as $$
begin
  if old.environment = 'development' and new.environment <> 'development'
     and exists (select 1 from public.settings
                  where id = 1
                    and (registration_mode <> 'off' or verification_provider <> 'none')) then
    raise exception 'Before marking this project as production, set registration_mode = ''off'' and verification_provider = ''none''.';
  end if;
  return new;
end;
$$;

drop trigger if exists deployment_guard on ypm_private.deployment;
create trigger deployment_guard
  before update on ypm_private.deployment
  for each row execute function ypm_private.guard_deployment();

-- ---------- 2. Codes that can never come back ----------

-- Keyed hashes only, no link to any person.
create table if not exists ypm_private.retired_voter_codes (
  code_hash   text primary key,
  retired_at  timestamptz not null default now()
);

-- A new code may not match a retired one. Raised as unique_violation, so
-- the existing retry loops in create_voter, reissue and restore simply
-- draw another code.
create or replace function ypm_private.voter_code_not_retired()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from ypm_private.retired_voter_codes where code_hash = new.code_hash) then
    raise exception 'voter code was used before' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists voters_code_not_retired on public.voters;
create trigger voters_code_not_retired
  before insert or update of code_hash on public.voters
  for each row execute function ypm_private.voter_code_not_retired();

-- Whenever a code is replaced (reissue, restore), the old one is retired.
create or replace function ypm_private.retire_old_voter_code()
returns trigger language plpgsql as $$
begin
  if old.code_hash is distinct from new.code_hash then
    insert into ypm_private.retired_voter_codes (code_hash) values (old.code_hash)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists voters_retire_old_code on public.voters;
create trigger voters_retire_old_code
  after update of code_hash on public.voters
  for each row execute function ypm_private.retire_old_voter_code();

-- Restoration details.
alter table public.voters add column if not exists restored_at    timestamptz;
alter table public.voters add column if not exists restored_by    text;
alter table public.voters add column if not exists restore_reason text;

-- ---------- 3. Consent versions and records ----------

create table if not exists ypm_private.consent_versions (
  version      text primary key check (btrim(version) <> ''),
  description  text not null,
  is_draft     boolean not null default true,   -- drafts: development only
  is_current   boolean not null default false,
  published_at timestamptz not null default now(),
  retired_at   timestamptz
);
create unique index if not exists consent_versions_one_current
  on ypm_private.consent_versions (is_current) where is_current;

-- The draft notice the development flow shows (src/prototype/simulator.js).
insert into ypm_private.consent_versions (version, description, is_draft, is_current)
values ('draft-2026-11-dev',
        'Draft privacy and consent notice used for development testing only. Not approved for real voters. No biometric data.',
        true, true)
on conflict (version) do nothing;

-- A version people may consent to now.
create or replace function ypm_private.consent_version_ok(p_version text)
returns boolean language sql stable as $$
  select exists (
    select 1 from ypm_private.consent_versions c
     where c.version = btrim(coalesce(p_version, ''))
       and c.retired_at is null
       and (not c.is_draft or ypm_private.is_development()));
$$;

create or replace function ypm_private.current_consent_version()
returns text language sql stable as $$
  select version from ypm_private.consent_versions where is_current and retired_at is null;
$$;

-- What was agreed, not who the person is: name and number stay on the
-- voter row. No free text.
create table if not exists public.voter_consents (
  id               uuid primary key default gen_random_uuid(),
  voter_id         uuid not null references public.voters(id),
  consent_version  text not null,
  method           text not null check (method in ('online', 'in_person')),
  adult_confirmed  boolean not null,
  biometric        boolean not null default false check (biometric = false),
  consented_at     timestamptz not null,
  recorded_by      text not null,                 -- 'self' or an admin label
  recorded_from    text not null check (recorded_from in ('account_created', 'migration_004_backfill')),
  recorded_at      timestamptz not null default now()
);
create index if not exists voter_consents_voter on public.voter_consents (voter_id);

alter table public.voter_consents enable row level security;
revoke all on public.voter_consents from public, anon, authenticated;

-- Append-only. Deleting is possible only inside ypm_private.erase_voter.
create or replace function ypm_private.voter_consents_append_only()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Consent records cannot be changed.';
  end if;
  if coalesce(current_setting('ypm.erasing_voter', true), '') <> 'on' then
    raise exception 'Consent records can only be deleted with ypm_private.erase_voter.';
  end if;
  return case when tg_op = 'DELETE' then old else null end;
end;
$$;

drop trigger if exists voter_consents_append_only on public.voter_consents;
create trigger voter_consents_append_only
  before update or delete on public.voter_consents
  for each row execute function ypm_private.voter_consents_append_only();
drop trigger if exists voter_consents_no_truncate on public.voter_consents;
create trigger voter_consents_no_truncate
  before truncate on public.voter_consents
  for each statement execute function ypm_private.voter_consents_append_only();

-- Every new account with a recorded consent gets a consent record, however
-- it was created (online claim, approved review, in person).
create or replace function ypm_private.record_voter_consent()
returns trigger language plpgsql as $$
begin
  if new.consent_version is not null then
    insert into public.voter_consents (voter_id, consent_version, method, adult_confirmed,
                                       consented_at, recorded_by, recorded_from)
    values (new.id, new.consent_version,
            case new.method when 'in_person' then 'in_person' else 'online' end,
            new.adult_confirmed, coalesce(new.consent_at, new.created_at), new.created_by,
            'account_created');
  end if;
  return new;
end;
$$;

drop trigger if exists voters_record_consent on public.voters;
create trigger voters_record_consent
  after insert on public.voters
  for each row execute function ypm_private.record_voter_consent();

-- Existing accounts: only consent that was actually recorded at the time
-- (online registrations). Accounts without one stay without one.
insert into public.voter_consents (voter_id, consent_version, method, adult_confirmed,
                                   consented_at, recorded_by, recorded_from)
select v.id, v.consent_version,
       case v.method when 'in_person' then 'in_person' else 'online' end,
       v.adult_confirmed, coalesce(v.consent_at, v.created_at), v.created_by,
       'migration_004_backfill'
  from public.voters v
 where v.consent_version is not null
   and not exists (select 1 from public.voter_consents c where c.voter_id = v.id);

-- ---------- 4. Move the 003 functions behind wrappers ----------
-- Moved unchanged. Kept for the undo file. Nobody but the database owner
-- can run them (see section 8).

do $$
declare
  f record;
begin
  for f in
    select * from (values
      ('voter_registration_start',    'text, text, text, boolean'),
      ('voter_registration_status',   'text'),
      ('voter_registration_claim',    'text'),
      ('voter_login',                 'text'),
      ('voter_logout',                'text'),
      ('voter_begin_ballot',          'text'),
      ('voter_save_vote',             'text, text, text'),
      ('voter_submit_ballot',         'text'),
      ('admin_register_voter',        'text, text, text, boolean'),
      ('admin_list_voters',           'text, text, integer, integer'),
      ('admin_reissue_voter_code',    'text, uuid'),
      ('admin_revoke_voter',          'text, uuid, text'),
      ('admin_list_reviews',          'text'),
      ('admin_resolve_review',        'text, uuid, text'),
      ('admin_set_registration_mode', 'text, text'),
      ('admin_voter_stats',           'text')
    ) as t(name, args)
  loop
    if to_regprocedure(format('ypm_private.%s_003(%s)', f.name, f.args)) is null then
      execute format('alter function public.%I(%s) set schema ypm_private', f.name, f.args);
      execute format('alter function ypm_private.%I(%s) rename to %I', f.name, f.args, f.name || '_003');
    else
      -- Re-run (or 003 was re-run): whatever is in public now gets replaced.
      execute format('drop function if exists public.%I(%s)', f.name, f.args);
    end if;
    execute format('revoke all on function ypm_private.%I(%s) from public, anon, authenticated',
                   f.name || '_003', f.args);
  end loop;
end;
$$;

-- ---------- 5. Wrappers: same names, arguments and replies, plus "disabled" ----------

create or replace function public.voter_registration_start(
  p_name text, p_phone text, p_consent_version text, p_adult boolean
)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  -- Only a current notice version can be agreed to (adds: consent_outdated).
  if coalesce(btrim(p_consent_version), '') <> ''
     and not ypm_private.consent_version_ok(p_consent_version) then
    return json_build_object('status', 'consent_outdated');
  end if;
  return ypm_private.voter_registration_start_003(p_name, p_phone, p_consent_version, p_adult);
end;
$$;

create or replace function public.voter_registration_status(p_token text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_registration_status_003(p_token);
end;
$$;

create or replace function public.voter_registration_claim(p_token text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_registration_claim_003(p_token);
end;
$$;

create or replace function public.voter_login(p_code text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_login_003(p_code);
end;
$$;

create or replace function public.voter_logout(p_session text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_logout_003(p_session);
end;
$$;

create or replace function public.voter_begin_ballot(p_session text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_begin_ballot_003(p_session);
end;
$$;

create or replace function public.voter_save_vote(
  p_session text, p_category_id text, p_nominee_name text
)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_save_vote_003(p_session, p_category_id, p_nominee_name);
end;
$$;

create or replace function public.voter_submit_ballot(p_session text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.voter_submit_ballot_003(p_session);
end;
$$;

create or replace function public.admin_list_voters(
  p_session text, p_search text default null, p_limit int default 50, p_offset int default 0
)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.admin_list_voters_003(p_session, p_search, p_limit, p_offset);
end;
$$;

create or replace function public.admin_reissue_voter_code(p_session text, p_voter_id uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.admin_reissue_voter_code_003(p_session, p_voter_id);
end;
$$;

create or replace function public.admin_revoke_voter(p_session text, p_voter_id uuid, p_reason text default null)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.admin_revoke_voter_003(p_session, p_voter_id, p_reason);
end;
$$;

create or replace function public.admin_list_reviews(p_session text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.admin_list_reviews_003(p_session);
end;
$$;

create or replace function public.admin_set_registration_mode(p_session text, p_mode text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  return ypm_private.admin_set_registration_mode_003(p_session, p_mode);
end;
$$;

-- Adds the current consent version, how many accounts have no consent
-- record, and that registration is adults only.
create or replace function public.admin_voter_stats(p_session text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v jsonb;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  v := ypm_private.admin_voter_stats_003(p_session)::jsonb;
  if v->>'status' = 'ok' then
    v := v || jsonb_build_object(
      'consent_version', ypm_private.current_consent_version(),
      'voters_without_consent',
        (select count(*) from voters x
          where not exists (select 1 from voter_consents c where c.voter_id = x.id)),
      'adults_only', true);
  end if;
  return v::json;
end;
$$;

-- ---------- 6. Changed and new admin functions ----------

-- In person, no biometrics, adults only (for now). Needs a current consent
-- version: the admin confirms the person has read that notice and agrees.
-- Statuses: ok (code shown once) | disabled | unauthorized | error
--   | consent_outdated | adult_required | phone_registered
--   | phone_has_ballot (with ballot: in_progress | submitted, answered)
create or replace function public.admin_register_voter(
  p_session text, p_name text, p_phone text, p_consent_version text,
  p_adult_confirmed boolean, p_link_existing_ballot boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label   text;
  v_phone   text := ypm_private.normalize_phone(p_phone);
  v_ballot  public.ballots;
  v_created json;
  v_id      uuid;
  v_linked  int := 0;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  v_label := ypm_private.admin_session_label(p_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(v_phone) < 10 then
    return json_build_object('status', 'error', 'message', 'name and phone required');
  end if;
  if not ypm_private.consent_version_ok(p_consent_version) then
    return json_build_object('status', 'consent_outdated',
                             'consent_version', ypm_private.current_consent_version());
  end if;
  if coalesce(p_adult_confirmed, false) is not true then
    return json_build_object('status', 'adult_required');
  end if;

  perform ypm_private.lock_phone(v_phone);
  if exists (select 1 from voters where phone = v_phone) then
    return json_build_object('status', 'phone_registered');
  end if;
  v_ballot := (select b from ballots b where b.voter_phone = v_phone for update);
  if v_ballot.id is not null and not coalesce(p_link_existing_ballot, false) then
    return json_build_object('status', 'phone_has_ballot',
      'ballot', case when v_ballot.completed_at is null then 'in_progress' else 'submitted' end,
      'answered', (select count(*) from votes where ballot_id = v_ballot.id));
  end if;

  v_created := ypm_private.create_voter(p_name, v_phone, 'in_person', v_label,
                                        btrim(p_consent_version), now(), true);
  v_id := (v_created->>'voter_id')::uuid;
  if v_ballot.id is not null then
    update ballots set voter_id = v_id where id = v_ballot.id and voter_id is null;
    get diagnostics v_linked = row_count;
    if v_linked <> 1 then
      raise exception 'ballot % is already linked', v_ballot.id;   -- rolls everything back
    end if;
  end if;

  perform ypm_private.audit(v_label, 'voter_registered_in_person', jsonb_build_object(
    'voter_id', v_id, 'linked_ballot', v_ballot.id is not null,
    'consent_version', btrim(p_consent_version), 'adult_confirmed', true));
  return json_build_object('status', 'ok', 'voter_id', v_id, 'voter_code', v_created->>'code',
                           'linked_ballot', v_ballot.id is not null);
end;
$$;

-- After checking the person in person. approve creates the account (code
-- shown once); with p_link_existing_ballot it also attaches the number's
-- anonymous ballot, keeping its votes. reject closes it.
-- Statuses: ok | disabled | unauthorized | error | adult_required
--   | phone_registered | phone_has_ballot (with ballot, answered)
create or replace function public.admin_resolve_review(
  p_session text, p_registration_id uuid, p_decision text,
  p_link_existing_ballot boolean default false
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label   text;
  v_reg     public.voter_registrations;
  v_ballot  public.ballots;
  v_created json;
  v_id      uuid;
  v_linked  int := 0;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  v_label := ypm_private.admin_session_label(p_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if p_decision is null or p_decision not in ('approve', 'reject') then
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

  if v_reg.adult_confirmed is not true then
    return json_build_object('status', 'adult_required');
  end if;
  if v_reg.provider <> 'simulated' then
    return json_build_object('status', 'error', 'message', 'unsupported verification provider');
  end if;

  perform ypm_private.lock_phone(v_reg.phone);
  if exists (select 1 from voters where phone = v_reg.phone) then
    return json_build_object('status', 'phone_registered');
  end if;
  v_ballot := (select b from ballots b where b.voter_phone = v_reg.phone for update);
  if v_ballot.id is not null and not coalesce(p_link_existing_ballot, false) then
    return json_build_object('status', 'phone_has_ballot',
      'ballot', case when v_ballot.completed_at is null then 'in_progress' else 'submitted' end,
      'answered', (select count(*) from votes where ballot_id = v_ballot.id));
  end if;

  v_created := ypm_private.create_voter(v_reg.full_name, v_reg.phone, 'face_simulated', v_label,
                                        v_reg.consent_version, v_reg.consent_at, v_reg.adult_confirmed);
  v_id := (v_created->>'voter_id')::uuid;
  if v_ballot.id is not null then
    update ballots set voter_id = v_id where id = v_ballot.id and voter_id is null;
    get diagnostics v_linked = row_count;
    if v_linked <> 1 then
      raise exception 'ballot % is already linked', v_ballot.id;   -- rolls everything back
    end if;
  end if;
  update voter_registrations
     set status = 'claimed', voter_id = v_id, reviewed_by = v_label, reviewed_at = now()
   where id = v_reg.id;

  perform ypm_private.audit(v_label, 'registration_approved', jsonb_build_object(
    'registration_id', v_reg.id, 'voter_id', v_id, 'linked_ballot', v_ballot.id is not null));
  return json_build_object('status', 'ok', 'voter_code', v_created->>'code',
                           'linked_ballot', v_ballot.id is not null);
end;
$$;

-- Reactivates a revoked account with a NEW code (shown once). The old code
-- stays dead. Ballot and votes are untouched.
-- Statuses: ok | disabled | unauthorized | error | not_found | not_revoked
create or replace function public.admin_restore_voter(p_session text, p_voter_id uuid, p_reason text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label  text;
  v_voter  public.voters;
  v_code   text;
  v_tries  int := 0;
  v_reason text := btrim(coalesce(p_reason, ''));
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  v_label := ypm_private.admin_session_label(p_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if length(v_reason) < 3 then
    return json_build_object('status', 'error', 'message', 'a reason is required');
  end if;
  v_voter := (select v from voters v where v.id = p_voter_id for update);
  if v_voter.id is null then
    return json_build_object('status', 'not_found');
  end if;
  if v_voter.status <> 'revoked' then
    return json_build_object('status', 'not_revoked');
  end if;

  loop
    v_tries := v_tries + 1;
    v_code := ypm_private.new_voter_code();
    begin
      update voters
         set status = 'active', code_hash = ypm_private.voter_code_hash(v_code),
             code_issued_at = now(), revoked_at = null, revoked_reason = null,
             restored_at = now(), restored_by = v_label, restore_reason = left(v_reason, 200)
       where id = v_voter.id;
      exit;
    exception when unique_violation then
      if v_tries >= 5 then
        raise;
      end if;
    end;
  end loop;
  delete from voter_sessions where voter_id = v_voter.id;

  perform ypm_private.audit(v_label, 'voter_restored', jsonb_build_object(
    'voter_id', v_voter.id, 'reason', left(v_reason, 200),
    'was_revoked_at', v_voter.revoked_at, 'was_revoked_reason', v_voter.revoked_reason));
  return json_build_object('status', 'ok', 'voter_code', v_code);
end;
$$;

-- ---------- 7. Erasing an account (database owner only) ----------
-- For the retention policy and for requests to delete. Removes the
-- account, its sessions, registrations for its number, and its consent
-- records. Its ballot and votes are kept as an ordinary anonymous ballot
-- for that number. Leaves an audit entry with no name or number.
create or replace function ypm_private.erase_voter(p_voter_id uuid, p_reason text)
returns json language plpgsql as $$
declare
  v_voter public.voters;
begin
  if length(btrim(coalesce(p_reason, ''))) < 3 then
    raise exception 'A reason is required.';
  end if;
  v_voter := (select v from public.voters v where v.id = p_voter_id for update);
  if v_voter.id is null then
    return json_build_object('status', 'not_found');
  end if;
  perform ypm_private.lock_phone(v_voter.phone);
  perform set_config('ypm.erasing_voter', 'on', true);
  delete from public.voter_sessions where voter_id = v_voter.id;
  update public.ballots set voter_id = null where voter_id = v_voter.id;
  delete from public.voter_registrations where voter_id = v_voter.id or phone = v_voter.phone;
  delete from public.voter_consents where voter_id = v_voter.id;
  delete from public.voters where id = v_voter.id;
  perform set_config('ypm.erasing_voter', 'off', true);
  perform ypm_private.audit('database-owner', 'voter_erased', jsonb_build_object(
    'voter_id', v_voter.id, 'reason', left(btrim(p_reason), 200)));
  return json_build_object('status', 'ok');
end;
$$;

-- ---------- 8. Grants ----------
-- Nothing in ypm_private is callable from the API roles: not the moved 003
-- functions, the helpers, nor erase_voter. (ypm_private isn't exposed by
-- the API either; this holds even if it were.)
revoke all on all functions in schema ypm_private from public, anon, authenticated;
revoke all on all tables    in schema ypm_private from public, anon, authenticated;
revoke all on schema ypm_private from public, anon, authenticated;

grant execute on function public.voter_registration_start(text, text, text, boolean)     to anon;
grant execute on function public.voter_registration_status(text)                         to anon;
grant execute on function public.voter_registration_claim(text)                          to anon;
grant execute on function public.voter_login(text)                                       to anon;
grant execute on function public.voter_logout(text)                                      to anon;
grant execute on function public.voter_begin_ballot(text)                                to anon;
grant execute on function public.voter_save_vote(text, text, text)                       to anon;
grant execute on function public.voter_submit_ballot(text)                               to anon;
grant execute on function public.admin_register_voter(text, text, text, text, boolean, boolean) to anon;
grant execute on function public.admin_list_voters(text, text, int, int)                 to anon;
grant execute on function public.admin_reissue_voter_code(text, uuid)                    to anon;
grant execute on function public.admin_revoke_voter(text, uuid, text)                    to anon;
grant execute on function public.admin_list_reviews(text)                                to anon;
grant execute on function public.admin_resolve_review(text, uuid, text, boolean)         to anon;
grant execute on function public.admin_set_registration_mode(text, text)                 to anon;
grant execute on function public.admin_voter_stats(text)                                 to anon;
grant execute on function public.admin_restore_voter(text, uuid, text)                   to anon;

commit;

-- ---------- Handy queries ----------
-- Is it on here?            select ypm_private.voter_accounts_enabled();
-- Consent versions:         select * from ypm_private.consent_versions;
-- Accounts without consent: select count(*) from public.voters v
--                            where not exists (select 1 from public.voter_consents c
--                                               where c.voter_id = v.id);
