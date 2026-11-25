-- ============================================================
-- YPM Youth Awards — DEVELOPMENT ONLY: simulated verification provider.
--
-- NEVER RUN THIS IN PRODUCTION. It refuses to install unless the project
-- has been marked as development, and the function it adds refuses to run
-- unless ALL of these hold:
--   * ypm_private.deployment.environment = 'development'
--   * settings.verification_provider = 'simulated' (itself only allowed in
--     a development project, by a trigger from 003)
--   * the caller has a valid ADMIN session, i.e. an authorised tester
--   * the registration is pending and was started with the simulator
--
-- No face data is involved. A tester simply chooses the outcome.
--
-- To use it on the development project, after 003:
--   update ypm_private.deployment set environment = 'development';
--   update public.settings set verification_provider = 'simulated' where id = 1;
--   -- then run this file
-- Remove it with:  drop function public.dev_simulate_verification(text, text, text);
-- (003's undo file also removes it.)
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('ypm_private.is_development()') is null then
    raise exception 'Run 003_voter_accounts.sql first.';
  end if;
  if not ypm_private.is_development() then
    raise exception 'Refusing to install: this project is not marked as development.';
  end if;
end;
$$;

-- Outcomes: approved | review (possible duplicate) | failed
create or replace function public.dev_simulate_verification(
  p_admin_session text, p_registration_token text, p_outcome text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text;
  v_reg   public.voter_registrations;
begin
  if not ypm_private.is_development()
     or coalesce((select verification_provider from settings where id = 1), 'none') <> 'simulated' then
    return json_build_object('status', 'disabled');
  end if;
  v_label := ypm_private.admin_session_label(p_admin_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if p_outcome not in ('approved', 'review', 'failed') then
    return json_build_object('status', 'error', 'message', 'outcome must be approved, review or failed');
  end if;

  v_reg := (select r from voter_registrations r
             where r.token_hash = ypm_private.sha256_hex(p_registration_token) for update);
  if v_reg.id is null or v_reg.status <> 'pending' or v_reg.provider <> 'simulated'
     or v_reg.expires_at <= now() then
    return json_build_object('status', 'error', 'message', 'no pending simulated registration');
  end if;

  update voter_registrations
     set status = p_outcome, provider_ref = 'sim:' || v_label
   where id = v_reg.id;
  perform ypm_private.audit(v_label, 'dev_simulated_verification', jsonb_build_object(
    'registration_id', v_reg.id, 'outcome', p_outcome));
  return json_build_object('status', 'ok', 'registration', p_outcome);
end;
$$;

grant execute on function public.dev_simulate_verification(text, text, text) to anon;

commit;
