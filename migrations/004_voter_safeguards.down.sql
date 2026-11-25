-- ============================================================
-- YPM Youth Awards — undo Migration 004.
--
-- Puts every 003 voter function back exactly as it was (they were only
-- moved, never changed), with the grants they had, and removes everything
-- 004 added.
--
-- Kept: voter accounts, codes, registrations, sessions, ballots and votes.
-- Restored accounts stay active with their new code.
--
-- LOST: the consent records (public.voter_consents) and consent versions,
-- the list of retired codes, and the restore details on voter rows. The
-- audit log keeps the consent version of every in-person registration and
-- every restore. Export voter_consents first if it holds anything you need
-- (see migrations/README.md, "Undoing 004").
--
-- Run before 003's undo. 003's undo refuses to run while 004 is installed
-- (the consent records point at the voters table).
-- ============================================================

begin;

-- New and changed public functions.
drop function if exists public.admin_restore_voter(text, uuid, text);
drop function if exists public.admin_register_voter(text, text, text, text, boolean, boolean);
drop function if exists public.admin_resolve_review(text, uuid, text, boolean);

-- Wrappers out, 003 originals back in public with their old grants.
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
    if to_regprocedure(format('ypm_private.%s_003(%s)', f.name, f.args)) is not null then
      execute format('drop function if exists public.%I(%s)', f.name, f.args);
      execute format('alter function ypm_private.%I(%s) rename to %I', f.name || '_003', f.args, f.name);
      execute format('alter function ypm_private.%I(%s) set schema public', f.name, f.args);
      execute format('grant execute on function public.%I(%s) to public, anon, authenticated', f.name, f.args);
    end if;
  end loop;
end;
$$;

-- Erasing, consent, retired codes.
drop function if exists ypm_private.erase_voter(uuid, text);

drop trigger if exists voters_record_consent on public.voters;
drop function if exists ypm_private.record_voter_consent();
drop table if exists public.voter_consents;          -- its triggers go with it
drop function if exists ypm_private.voter_consents_append_only();
drop function if exists ypm_private.current_consent_version();
drop function if exists ypm_private.consent_version_ok(text);
drop table if exists ypm_private.consent_versions;

drop trigger if exists voters_retire_old_code on public.voters;
drop trigger if exists voters_code_not_retired on public.voters;
drop function if exists ypm_private.retire_old_voter_code();
drop function if exists ypm_private.voter_code_not_retired();
drop table if exists ypm_private.retired_voter_codes;

alter table public.voters drop column if exists restore_reason;
alter table public.voters drop column if exists restored_by;
alter table public.voters drop column if exists restored_at;

-- The switch and its guards.
drop trigger if exists deployment_guard on ypm_private.deployment;
drop function if exists ypm_private.guard_deployment();
drop trigger if exists settings_guard_004 on public.settings;
drop function if exists ypm_private.guard_settings_004();
drop function if exists ypm_private.disabled_reply();
drop function if exists ypm_private.voter_accounts_enabled();

commit;
