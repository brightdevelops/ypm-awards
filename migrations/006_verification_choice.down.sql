-- ============================================================
-- YPM Youth Awards — undo Migration 006.
--
-- Removes the in-person request functions, the sandbox provider and the
-- service-role result entry point, and narrows 005's provider_sessions
-- back to 'simulated'.
--
-- Deletes nothing a person needs: voter accounts (including those
-- confirmed in person), ballots, votes, consent records and the audit log
-- stay. In-person requests still waiting are closed (status 'expired'),
-- because without 006 no one could confirm them; the person can ask again
-- after a reinstall, or a leader can register them in person. Sandbox
-- provider sessions are deleted (their delivery log stays until 005's
-- 30-day clean-up).
--
-- Run before 005's undo (005's undo refuses while 006 is installed), and
-- after 007's undo (this refuses while 007 is installed).
-- ============================================================

begin;

do $$ begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'ypm_private' and table_name = 'deployment'
                and column_name = 'voter_accounts_live') then
    raise exception 'Migration 007 is installed. Run 007_production_voter_accounts.down.sql first.';
  end if;
end; $$;

drop function if exists public.voter_request_in_person(text, text, text, boolean);
drop function if exists public.admin_in_person_requests(text);
drop function if exists public.admin_confirm_in_person(text, uuid, text, boolean);
drop function if exists public.dev_sandbox_start(text, text);
drop function if exists public.provider_webhook_result(text, text, text, text, text, timestamptz);

update public.voter_registrations
   set status = 'expired'
 where provider = 'in_person' and status = 'review';

delete from ypm_private.provider_sessions where provider = 'sandbox';
alter table ypm_private.provider_sessions drop constraint if exists provider_sessions_provider_check;
alter table ypm_private.provider_sessions
  add constraint provider_sessions_provider_check check (provider = 'simulated');

drop function if exists ypm_private.expire_in_person_requests();
drop function if exists ypm_private.new_in_person_reference();
drop table if exists ypm_private.in_person_requests;

commit;
