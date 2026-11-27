-- ============================================================
-- YPM Youth Awards — undo Migration 007.
--
-- Puts 004's development-only switch back: in Production every
-- voter-account function answers "disabled" again. Deletes nothing:
-- accounts, requests, ballots, votes and consent records stay (consent
-- records keep pointing at the notice version they agreed to, so that
-- version is kept too, marked not current).
--
-- In Production the development draft stays retired (drafts are refused
-- there anyway).
--
-- Run before 006's undo (006's undo refuses while 007 is installed).
-- ============================================================

begin;

drop trigger if exists deployment_live_guard on ypm_private.deployment;
drop function if exists ypm_private.guard_voter_accounts_live();

create or replace function ypm_private.voter_accounts_enabled()
returns boolean language sql stable as $$
  select ypm_private.is_development();
$$;

update ypm_private.consent_versions set is_current = false
 where version = 'ypm-register-2026-12-v1' and not ypm_private.is_development();

alter table ypm_private.deployment drop column if exists voter_accounts_live;

revoke all on all functions in schema ypm_private from public, anon, authenticated;

commit;
