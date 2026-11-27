-- ============================================================
-- YPM Youth Awards — Migration 006: a non-biometric way to register, and a
-- provider entry point for a sandbox vendor (Phase 5.1–5.3).
-- DEVELOPMENT ONLY.
--
-- NO BIOMETRIC DATA. Nothing here captures, receives or stores a face,
-- image, template or score.
--
--   1. "Verify with a youth leader" (5.1). A voter can ask to be confirmed
--      in person instead of doing a face check, and gets a short reference
--      to show a leader. It works even when no verification provider is
--      configured. The leader confirms the person in the review queue
--      (admin_confirm_in_person); the account is the same kind as any
--      other (method 'in_person') and votes the same way. Requests are
--      valid for 14 days.
--   2. A provider-neutral result entry point (5.2):
--      public.provider_webhook_result, callable ONLY by the service role
--      (the webhook Edge Function), never by the browser. It applies
--      results through 005's ypm_private.apply_verification_result, so all
--      of 005's rules hold: idempotent, never upgrades, conflicts go to a
--      person.
--   3. The "sandbox" provider (5.3): a stand-in vendor for development.
--      A tester starts a sandbox session (dev_sandbox_start); the sandbox
--      vendor's signed webhooks reach the Edge Function
--      (supabase/functions/provider-webhook), which checks the signature
--      and calls the entry point. Sandbox data only: no real vendor.
--
-- Every public function here answers "disabled" unless 004's switch is on
-- (development project). The sandbox also needs
-- settings.verification_provider = 'simulated' (development only, by 003).
--
-- Changes no 003, 004 or 005 function. One 005 constraint is widened:
-- ypm_private.provider_sessions.provider may also be 'sandbox'.
-- Requires 005. Safe to run more than once. Undo with
-- 006_verification_choice.down.sql (005's undo refuses while this is
-- installed).
--
-- Written with ":=" assignments, not "SELECT ... INTO" (Supabase SQL
-- editor quirk; see 001).
-- ============================================================

begin;

do $$
begin
  if to_regclass('ypm_private.provider_sessions') is null then
    raise exception 'Run 005_simulated_provider.sql first.';
  end if;
end;
$$;

-- ---------- 1. In-person requests ----------

create table if not exists ypm_private.in_person_requests (
  registration_id  uuid primary key references public.voter_registrations(id) on delete cascade,
  reference        text not null unique check (reference ~ '^[A-HJ-NP-Z2-9]{6}$'),
  created_at       timestamptz not null default now()
);

-- Six characters a person can read out: no 0/O, 1/I.
create or replace function ypm_private.new_in_person_reference()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea := uuid_send(gen_random_uuid());
  v_out   text  := '';
  i       int;
begin
  for i in 0..5 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i) & 31) + 1, 1);
  end loop;
  return v_out;
end;
$$;

-- Requests nobody confirmed within 14 days close (status 'expired'); 005's
-- 30-day clean-up deletes them later. Nothing else is touched.
create or replace function ypm_private.expire_in_person_requests()
returns int language plpgsql as $$
declare
  v_n int;
begin
  update public.voter_registrations r
     set status = 'expired'
   where r.provider = 'in_person' and r.status = 'review' and r.expires_at <= now();
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Voter: ask to be confirmed by a youth leader instead of a face check.
-- Same checks and limits as voter_registration_start (and they share the
-- per-number limit), but no verification provider is needed.
-- Statuses: ok (registration_token, reference, expires_at) | disabled
--   | registration_off | consent_outdated | adult_required
--   | needs_assistance | rate_limited | error
create or replace function public.voter_request_in_person(
  p_name text, p_phone text, p_consent_version text, p_adult boolean
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_phone   text := ypm_private.normalize_phone(p_phone);
  v_ip      text := ypm_private.client_ip();
  v_token   text;
  v_ref     text;
  v_id      uuid;
  v_expires timestamptz := now() + interval '14 days';
  v_tries   int := 0;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  if (select registration_mode from settings where id = 1) = 'off' then
    return json_build_object('status', 'registration_off');
  end if;
  if length(btrim(coalesce(p_name, ''))) < 2 or length(v_phone) < 10
     or coalesce(btrim(p_consent_version), '') = '' then
    return json_build_object('status', 'error', 'message', 'name, phone and consent required');
  end if;
  if not ypm_private.consent_version_ok(p_consent_version) then
    return json_build_object('status', 'consent_outdated');
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

  -- Same answer for "registered" and "has a ballot", as in 003: a leader
  -- handles both in person (admin_register_voter can link the ballot).
  if exists (select 1 from voters where phone = v_phone)
     or exists (select 1 from ballots where voter_phone = v_phone) then
    return json_build_object('status', 'needs_assistance');
  end if;

  perform ypm_private.expire_in_person_requests();

  v_token := ypm_private.random_token();
  v_id := gen_random_uuid();
  insert into voter_registrations (id, token_hash, full_name, phone, consent_version,
                                   adult_confirmed, provider, status, expires_at)
  values (v_id, ypm_private.sha256_hex(v_token), btrim(p_name), v_phone, btrim(p_consent_version),
          true, 'in_person', 'review', v_expires);

  loop
    v_tries := v_tries + 1;
    v_ref := ypm_private.new_in_person_reference();
    begin
      insert into ypm_private.in_person_requests (registration_id, reference) values (v_id, v_ref);
      exit;
    exception when unique_violation then
      if v_tries >= 5 then
        raise;
      end if;
    end;
  end loop;

  return json_build_object('status', 'ok', 'registration_token', v_token,
                           'reference', v_ref, 'expires_at', v_expires);
end;
$$;

-- Admin: the in-person requests waiting, with their references (to match
-- the reference on the person's phone). Statuses: ok (requests:
-- [{registration_id, reference, created_at, expires_at}]) | disabled
--   | unauthorized
create or replace function public.admin_in_person_requests(p_session text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  if ypm_private.admin_session_label(p_session) is null then
    return json_build_object('status', 'unauthorized');
  end if;
  perform ypm_private.expire_in_person_requests();
  return json_build_object('status', 'ok', 'requests', coalesce((
    select json_agg(json_build_object('registration_id', r.id, 'reference', q.reference,
                                      'created_at', r.created_at, 'expires_at', r.expires_at)
                    order by r.created_at)
      from voter_registrations r
      join ypm_private.in_person_requests q on q.registration_id = r.id
     where r.status = 'review' and r.provider = 'in_person'), '[]'::json));
end;
$$;

-- Admin, with the person in front of them: confirm (creates the account,
-- code shown once for the leader to hand over; with p_link_existing_ballot
-- it also attaches the number's anonymous ballot) or reject.
-- Same replies as admin_resolve_review, plus "expired".
-- Statuses: ok | disabled | unauthorized | error | expired | adult_required
--   | phone_registered | phone_has_ballot (with ballot, answered)
create or replace function public.admin_confirm_in_person(
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
  if v_reg.id is null or v_reg.status <> 'review' or v_reg.provider <> 'in_person' then
    return json_build_object('status', 'error', 'message', 'no such in-person request waiting');
  end if;
  if v_reg.expires_at <= now() then
    update voter_registrations set status = 'expired' where id = v_reg.id;
    return json_build_object('status', 'expired');
  end if;

  if p_decision = 'reject' then
    update voter_registrations set status = 'rejected', reviewed_by = v_label, reviewed_at = now()
     where id = v_reg.id;
    perform ypm_private.audit(v_label, 'in_person_request_rejected', jsonb_build_object('registration_id', v_reg.id));
    return json_build_object('status', 'ok');
  end if;

  if v_reg.adult_confirmed is not true then
    return json_build_object('status', 'adult_required');
  end if;
  if not ypm_private.consent_version_ok(v_reg.consent_version) then
    -- The notice changed since they asked: they need to agree to the new one.
    return json_build_object('status', 'consent_outdated',
                             'consent_version', ypm_private.current_consent_version());
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

  v_created := ypm_private.create_voter(v_reg.full_name, v_reg.phone, 'in_person', v_label,
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

  perform ypm_private.audit(v_label, 'registration_confirmed_in_person', jsonb_build_object(
    'registration_id', v_reg.id, 'voter_id', v_id, 'linked_ballot', v_ballot.id is not null));
  return json_build_object('status', 'ok', 'voter_id', v_id, 'voter_code', v_created->>'code',
                           'linked_ballot', v_ballot.id is not null);
end;
$$;

-- ---------- 2. Sandbox provider sessions ----------

do $$
begin
  if exists (select 1 from pg_constraint
              where conname = 'provider_sessions_provider_check'
                and conrelid = 'ypm_private.provider_sessions'::regclass
                and pg_get_constraintdef(oid) not like '%sandbox%') then
    alter table ypm_private.provider_sessions drop constraint provider_sessions_provider_check;
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'provider_sessions_provider_check'
                    and conrelid = 'ypm_private.provider_sessions'::regclass) then
    alter table ypm_private.provider_sessions
      add constraint provider_sessions_provider_check check (provider in ('simulated', 'sandbox'));
  end if;
end;
$$;

-- Tester: start a sandbox session for a pending registration, as our
-- server would with a real vendor. Returns the vendor-side reference the
-- sandbox vendor's webhooks will carry. Running it again for the same
-- registration returns the same reference.
-- Statuses: ok (provider_ref) | already_running (provider_ref) | disabled
--   | unauthorized | error
create or replace function public.dev_sandbox_start(p_admin_session text, p_registration_token text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label text;
  v_reg   public.voter_registrations;
  v_sess  ypm_private.provider_sessions;
  v_ref   text;
begin
  if not ypm_private.sim_provider_ready() then
    return json_build_object('status', 'disabled');
  end if;
  v_label := ypm_private.admin_session_label(p_admin_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  v_reg := (select r from voter_registrations r
             where r.token_hash = ypm_private.sha256_hex(p_registration_token) for update);
  if v_reg.id is null or v_reg.status <> 'pending' or v_reg.provider <> 'simulated'
     or v_reg.expires_at <= now() then
    return json_build_object('status', 'error', 'message', 'no pending registration');
  end if;
  v_sess := (select s from ypm_private.provider_sessions s where s.registration_id = v_reg.id);
  if v_sess.registration_id is not null then
    if v_sess.provider = 'sandbox' then
      return json_build_object('status', 'already_running', 'provider_ref', v_sess.provider_ref);
    end if;
    return json_build_object('status', 'error', 'message', 'a check is already running for this registration');
  end if;

  perform ypm_private.purge_verification_records('retention');
  v_ref := 'sbx_' || ypm_private.random_token();
  insert into ypm_private.provider_sessions (registration_id, provider, provider_ref)
  values (v_reg.id, 'sandbox', v_ref);
  perform ypm_private.audit(v_label, 'dev_sandbox_started', jsonb_build_object('registration_id', v_reg.id));
  return json_build_object('status', 'ok', 'provider_ref', v_ref);
end;
$$;

-- ---------- 3. Provider result entry point (service role only) ----------
-- Called by the webhook Edge Function AFTER it has checked the vendor's
-- signature with a secret only it holds. Takes the mapped fields only:
-- the vendor's payload never reaches the database.
-- Statuses: ok (result: as apply_verification_result) | disabled | rejected
create or replace function public.provider_webhook_result(
  p_provider text, p_provider_ref text, p_delivery_id text,
  p_outcome text, p_reason_code text, p_issued_at timestamptz
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_sess ypm_private.provider_sessions;
begin
  if not ypm_private.sim_provider_ready() then
    return json_build_object('status', 'disabled');
  end if;
  if p_provider is distinct from 'sandbox'
     or coalesce(p_provider_ref, '') !~ '^[A-Za-z0-9_-]{1,80}$'
     or coalesce(p_delivery_id, '') !~ '^[A-Za-z0-9_-]{1,80}$'
     or p_outcome is null or p_outcome not in ('approved', 'review', 'failed', 'expired')
     or (p_reason_code is not null and p_reason_code not in
         ('liveness_failed', 'poor_capture', 'possible_duplicate', 'provider_timeout'))
     or p_issued_at is null then
    insert into ypm_private.verification_events (result) values ('malformed');
    return json_build_object('status', 'rejected');
  end if;
  if p_issued_at < now() - interval '10 minutes' or p_issued_at > now() + interval '1 minute' then
    insert into ypm_private.verification_events (delivery_id, outcome, result)
    values (p_delivery_id, p_outcome, 'expired_delivery');
    return json_build_object('status', 'rejected');
  end if;
  -- A sandbox delivery can only touch a sandbox session.
  v_sess := (select s from ypm_private.provider_sessions s where s.provider_ref = p_provider_ref);
  if v_sess.registration_id is null or v_sess.provider <> p_provider then
    insert into ypm_private.verification_events (delivery_id, outcome, reason_code, result)
    values (p_delivery_id, p_outcome, p_reason_code, 'unknown_ref');
    return json_build_object('status', 'ok', 'result', 'unknown_ref');
  end if;
  return json_build_object('status', 'ok', 'result', ypm_private.apply_verification_result(
    p_provider_ref, p_delivery_id, p_outcome, p_reason_code, p_issued_at));
end;
$$;

-- ---------- 4. Grants ----------
revoke all on all functions in schema ypm_private from public, anon, authenticated;
revoke all on all tables    in schema ypm_private from public, anon, authenticated;

grant execute on function public.voter_request_in_person(text, text, text, boolean)       to anon;
grant execute on function public.admin_in_person_requests(text)                            to anon;
grant execute on function public.admin_confirm_in_person(text, uuid, text, boolean)        to anon;
grant execute on function public.dev_sandbox_start(text, text)                             to anon;

-- Supabase grants new public functions to anon and authenticated by
-- default; this one must never be callable from a browser.
revoke all on function public.provider_webhook_result(text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.provider_webhook_result(text, text, text, text, text, timestamptz)
      to service_role;
  end if;
end;
$$;

commit;

-- ---------- Handy queries ----------
-- Waiting in-person requests:
--   select q.reference, r.created_at, r.expires_at from ypm_private.in_person_requests q
--     join voter_registrations r on r.id = q.registration_id where r.status = 'review';
-- Sandbox deliveries:
--   select e.* from ypm_private.verification_events e
--     join ypm_private.provider_sessions s using (registration_id)
--    where s.provider = 'sandbox' order by e.id desc limit 20;
