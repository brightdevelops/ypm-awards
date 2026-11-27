-- ============================================================
-- YPM Youth Awards — Migration 007: voter accounts in Production, for the
-- youth-leader (in-person) path only.
--
-- NO BIOMETRIC DATA, and none can be collected: face checks stay
-- development-only (unchanged, see below).
--
-- Until now every voter-account function answered "disabled" outside a
-- development project (004's switch). This adds ONE owner-only switch,
-- ypm_private.deployment.voter_accounts_live (default false), so Production
-- can use voter accounts once you turn it on in the SQL editor:
--
--   update ypm_private.deployment set voter_accounts_live = true;
--
-- With it on, in Production:
--   * A voter can ask to be confirmed by a youth leader (006) and a leader
--     confirms them, or registers them in person (004). Voters sign in with
--     their code and vote; anonymous voting carries on unchanged.
--   * Registration still needs settings.registration_mode <> 'off', which
--     an admin chooses on the dashboard (default 'off').
--   * Online face-check registration answers "verification_unavailable":
--     verification_provider can only be 'none' outside development (003).
--   * The simulated provider, the sandbox and the webhook entry point (005,
--     006) still answer "disabled": they check is_development() directly.
--
-- Also publishes the consent notice for registering with a youth leader,
-- version 'ypm-register-2026-12-v1' (not a draft). The wording is in
-- src/voter/consentNotice.js and must be approved before this is run in
-- Production. In Production it becomes the current version and the
-- development draft is retired; in Development the draft stays current and
-- both are accepted.
--
-- Turning the switch off again (= false) makes every voter-account function
-- answer "disabled" again; accounts, ballots and votes are kept.
--
-- Note: re-running 004 puts 004's development-only switch back (voter
-- accounts go "disabled" in Production, which is safe). Run 007 again
-- afterwards. Requires 006. Safe to run more than once. Undo with
-- 007_production_voter_accounts.down.sql.
--
-- Written with ":=" assignments, not "SELECT ... INTO" (Supabase SQL
-- editor quirk; see 001).
-- ============================================================

begin;

do $$
begin
  if to_regclass('ypm_private.in_person_requests') is null then
    raise exception 'Run 006_verification_choice.sql first.';
  end if;
end;
$$;

-- ---------- 1. The switch (database owner only) ----------

alter table ypm_private.deployment
  add column if not exists voter_accounts_live boolean not null default false;

create or replace function ypm_private.voter_accounts_enabled()
returns boolean language sql stable as $$
  select ypm_private.is_development()
      or coalesce((select voter_accounts_live from ypm_private.deployment where id = 1), false);
$$;

-- Turning it on needs: no face-check provider, and a published (non-draft)
-- consent notice that is current. Turning it off is always allowed.
create or replace function ypm_private.guard_voter_accounts_live()
returns trigger language plpgsql as $$
begin
  if new.voter_accounts_live and not coalesce(old.voter_accounts_live, false) then
    if exists (select 1 from public.settings where id = 1 and verification_provider <> 'none') then
      raise exception 'Set verification_provider = ''none'' before turning voter accounts on.';
    end if;
    if not exists (select 1 from ypm_private.consent_versions
                    where is_current and not is_draft and retired_at is null) then
      raise exception 'No published consent notice is current. Run 007 on this project first (it publishes one).';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists deployment_live_guard on ypm_private.deployment;
create trigger deployment_live_guard
  before update on ypm_private.deployment
  for each row execute function ypm_private.guard_voter_accounts_live();

-- ---------- 2. The published consent notice ----------

insert into ypm_private.consent_versions (version, description, is_draft, is_current)
values ('ypm-register-2026-12-v1',
        'Registering to vote with a youth leader (no face scan): name and phone number only. Wording in src/voter/consentNotice.js.',
        false, false)
on conflict (version) do nothing;

do $$
begin
  if not ypm_private.is_development() then
    update ypm_private.consent_versions set is_current = false
     where is_current and version <> 'ypm-register-2026-12-v1';
    update ypm_private.consent_versions set retired_at = now()
     where is_draft and retired_at is null;
    update ypm_private.consent_versions set is_current = true
     where version = 'ypm-register-2026-12-v1';
  end if;
end;
$$;

-- ---------- 3. Grants ----------
revoke all on all functions in schema ypm_private from public, anon, authenticated;
revoke all on all tables    in schema ypm_private from public, anon, authenticated;

commit;

-- ---------- Handy queries ----------
-- State:     select environment, voter_accounts_live from ypm_private.deployment;
-- Notice:    select version, is_draft, is_current, retired_at from ypm_private.consent_versions;
-- Switch on: update ypm_private.deployment set voter_accounts_live = true;
-- Off again: update ypm_private.deployment set voter_accounts_live = false;
