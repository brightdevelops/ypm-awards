-- ============================================================
-- YPM Youth Awards — undo Migration 003.
--
-- Puts begin_ballot, save_vote and submit_ballot back exactly as they were
-- (the originals were only moved, never changed) and removes everything 003
-- added, including the development simulator if it was installed.
--
-- Ballots and votes are kept, including ballots started by registered
-- voters: they become ordinary ballots for that phone number, which the
-- voter can only reopen with a voting code issued for that number.
--
-- What is lost: voter accounts, voter codes, registrations and the review
-- queue, voter sessions, which ballot belonged to which voter, the two new
-- settings, and the voter-code key in Vault.
--
-- Run before 002's and 001's undo files.
-- ============================================================

begin;

-- Development simulator, if present.
drop function if exists public.dev_simulate_verification(text, text, text);

-- New public functions.
drop function if exists public.voter_registration_start(text, text, text, boolean);
drop function if exists public.voter_registration_status(text);
drop function if exists public.voter_registration_claim(text);
drop function if exists public.voter_login(text);
drop function if exists public.voter_logout(text);
drop function if exists public.voter_begin_ballot(text);
drop function if exists public.voter_save_vote(text, text, text);
drop function if exists public.voter_submit_ballot(text);
drop function if exists public.admin_register_voter(text, text, text, boolean);
drop function if exists public.admin_list_voters(text, text, int, int);
drop function if exists public.admin_reissue_voter_code(text, uuid);
drop function if exists public.admin_revoke_voter(text, uuid, text);
drop function if exists public.admin_list_reviews(text);
drop function if exists public.admin_resolve_review(text, uuid, text);
drop function if exists public.admin_set_registration_mode(text, text);
drop function if exists public.admin_voter_stats(text);

-- Wrappers out, originals back in place with their old grants.
do $$
begin
  if to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is not null then
    drop function if exists public.begin_ballot(text, text, text, uuid);
    alter function ypm_private.begin_ballot_001(text, text, text, uuid) rename to begin_ballot;
    alter function ypm_private.begin_ballot(text, text, text, uuid) set schema public;
  end if;
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is not null then
    drop function if exists public.save_vote(uuid, text, text);
    alter function ypm_private.save_vote_002(uuid, text, text) rename to save_vote;
    alter function ypm_private.save_vote(uuid, text, text) set schema public;
  end if;
  if to_regprocedure('ypm_private.submit_ballot_000(uuid)') is not null then
    drop function if exists public.submit_ballot(uuid);
    alter function ypm_private.submit_ballot_000(uuid) rename to submit_ballot;
    alter function ypm_private.submit_ballot(uuid) set schema public;
  end if;
end;
$$;

grant execute on function public.begin_ballot(text, text, text, uuid) to anon;
grant execute on function public.save_vote(uuid, text, text)          to anon;
grant execute on function public.submit_ballot(uuid)                  to anon;

-- Private helpers.
drop function if exists ypm_private.voter_pepper();
drop function if exists ypm_private.hmac_sha256(bytea, bytea);
drop function if exists ypm_private.normalize_voter_code(text);
drop function if exists ypm_private.new_voter_code();
drop function if exists ypm_private.voter_code_hash(text);
drop function if exists ypm_private.lock_phone(text);
drop function if exists ypm_private.mask_phone(text);
drop function if exists ypm_private.create_voter(text, text, text, text, text, timestamptz, boolean);
drop function if exists ypm_private.new_voter_session(uuid);
drop function if exists ypm_private.voter_from_session(text);
drop function if exists ypm_private.ballot_state(uuid);
drop function if exists ypm_private.first_name(text);

-- Settings guard and columns.
drop trigger if exists settings_guard on public.settings;
drop function if exists ypm_private.guard_settings();
alter table public.settings drop column if exists verification_provider;
alter table public.settings drop column if exists registration_mode;
drop function if exists ypm_private.is_development();
drop table if exists ypm_private.deployment;

-- Ballot link, then the tables.
drop index if exists public.ballots_voter_unique;
alter table public.ballots drop column if exists voter_id;
drop table if exists public.voter_sessions;
drop table if exists public.voter_registrations;
drop table if exists public.voters;

-- The voter-code key. With the voters gone it protects nothing.
do $$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets where name = 'ypm_voter_code_pepper';
  end if;
end;
$$;

commit;
