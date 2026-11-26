-- ============================================================
-- YPM Youth Awards — undo Migration 005.
--
-- Removes the simulated provider: its functions, provider sessions, the
-- delivery log and the outbox. Nothing in 003 or 004 is changed, and no
-- registration, voter account, ballot, vote, consent record or audit entry
-- is deleted. Registrations still waiting for a simulated result stay
-- pending and expire as usual.
--
-- The signing key is left in Vault (harmless, and reinstalling 005 reuses
-- it). To remove it too, on Development only:
--   delete from vault.secrets where name = 'ypm_sim_provider_key';
--
-- Run before 004's undo (004's undo refuses while 005 is installed).
-- ============================================================

begin;

drop function if exists public.dev_provider_start(text, text, text, text, int, text);
drop function if exists public.dev_provider_outbox(text);
drop function if exists public.dev_provider_callback(text, text);
drop function if exists public.admin_review_details(text);
drop function if exists public.admin_purge_verification_records(text);

drop function if exists ypm_private.purge_verification_records(text);
drop function if exists ypm_private.sim_provider_ready();
drop function if exists ypm_private.apply_verification_result(text, text, text, text, timestamptz);
drop function if exists ypm_private.sim_sign(bytea, text);
drop function if exists ypm_private.sim_provider_key();

drop table if exists ypm_private.sim_outbox;
drop table if exists ypm_private.verification_events;
drop table if exists ypm_private.provider_sessions;

commit;
