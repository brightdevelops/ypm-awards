-- ============================================================
-- YPM Youth Awards — Migration 005: simulated verification provider with
-- asynchronous, signed results (Phase 4). DEVELOPMENT ONLY.
--
-- NO BIOMETRIC DATA. No camera, no images, no templates, no scores. A
-- "provider" here is a simulator inside this database: a signed-in tester
-- chooses the outcome, the simulator signs it, and the result arrives later
-- through a public callback, the way a real provider's webhook would:
-- possibly late, twice, out of order, or with a bad signature.
--
--   1. Provider sessions: one provider reference per registration.
--   2. A result contract, ypm_private.apply_verification_result: idempotent,
--      never upgrades a decision, sends conflicting results to review.
--   3. The simulated provider: an outbox of signed deliveries (HMAC-SHA-256,
--      key in Supabase Vault) and a public callback that checks the
--      signature, freshness and duplicates before anything changes.
--   4. Admin visibility: why a registration is waiting, and its delivery
--      history. Outcomes and reason codes only.
--   5. Retention: verification records are deleted 30 days after they are
--      finished. Ballots, votes, voter accounts, consent records and the
--      audit log are never touched.
--
-- Every public function here answers "disabled" unless migration 004's
-- switch is on (development project, registration allowed), and the
-- provider functions also need settings.verification_provider =
-- 'simulated' (only allowed on a development project, by 003).
--
-- Adds new objects only: no 003 or 004 function, table or column is
-- changed, so re-running 004 leaves this intact. 004's undo refuses to run
-- while this is installed. Undo with 005_simulated_provider.down.sql.
-- Requires 004. Safe to run more than once.
--
-- Written with ":=" assignments, not "SELECT ... INTO" (Supabase SQL
-- editor quirk; see 001).
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('ypm_private.voter_accounts_enabled()') is null then
    raise exception 'Run 004_voter_safeguards.sql first.';
  end if;
end;
$$;

-- ---------- 1. Signing key (development projects only) ----------
-- Production never needs it: every function that would use it answers
-- "disabled" there first.
do $$
begin
  if ypm_private.is_development()
     and not exists (select 1 from vault.decrypted_secrets where name = 'ypm_sim_provider_key') then
    perform vault.create_secret(
      ypm_private.random_token() || ypm_private.random_token(),
      'ypm_sim_provider_key',
      'YPM Awards (development): signing key for the simulated verification provider.'
    );
  end if;
end;
$$;

create or replace function ypm_private.sim_provider_key()
returns bytea language plpgsql stable as $$
declare
  v text;
begin
  v := (select decrypted_secret from vault.decrypted_secrets
         where name = 'ypm_sim_provider_key' limit 1);
  if v is null or length(v) < 32 then
    return null;
  end if;
  return convert_to(v, 'UTF8');
end;
$$;

create or replace function ypm_private.sim_sign(p_key bytea, p_body text)
returns text language sql immutable as $$
  select encode(ypm_private.hmac_sha256(p_key, convert_to(p_body, 'UTF8')), 'hex');
$$;

-- ---------- 2. Provider sessions and delivery log ----------
-- What the database keeps: an outcome, a short reason code, references and
-- times. Never a name, number, image, template or score.

create table if not exists ypm_private.provider_sessions (
  registration_id  uuid primary key references public.voter_registrations(id) on delete cascade,
  provider         text not null check (provider = 'simulated'),
  provider_ref     text not null unique,
  reason_code      text check (reason_code in ('liveness_failed', 'poor_capture',
                                               'possible_duplicate', 'provider_timeout',
                                               'conflicting_results')),
  last_issued_at   timestamptz,            -- newest result applied (out-of-order guard)
  created_at       timestamptz not null default now(),
  decided_at       timestamptz
);

create table if not exists ypm_private.verification_events (
  id               bigserial primary key,
  registration_id  uuid references public.voter_registrations(id) on delete cascade,
  delivery_id      text,                   -- only for deliveries with a valid signature
  outcome          text,
  reason_code      text,
  result           text not null check (result in (
                     'applied', 'duplicate', 'stale', 'conflict_review', 'conflict_ignored',
                     'too_late', 'unknown_ref', 'bad_signature', 'expired_delivery', 'malformed')),
  received_at      timestamptz not null default now()
);
create index if not exists verification_events_registration on ypm_private.verification_events (registration_id);
create index if not exists verification_events_delivery on ypm_private.verification_events (delivery_id)
  where delivery_id is not null;

-- The simulated provider's outbox: deliveries waiting to be relayed to the
-- callback. In a real integration this lives at the provider, not here.
create table if not exists ypm_private.sim_outbox (
  id             bigserial primary key,
  registration_id uuid not null references public.voter_registrations(id) on delete cascade,
  body           text not null,
  signature      text not null,
  deliver_after  timestamptz not null,
  delivered_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index if not exists sim_outbox_due on ypm_private.sim_outbox (deliver_after) where delivered_at is null;

-- ---------- 3. The result contract ----------
-- Applies one provider result. Returns what happened (the event's result).
--   applied           pending -> approved | review | failed | expired
--   duplicate         this delivery, or this same result, was seen before
--   stale             older than a result already applied (out of order)
--   conflict_review   a different result for an approved, unclaimed
--                     registration: sent to review for a person to decide
--   conflict_ignored  a different result after a final decision, or one
--                     that would upgrade (never turns failed/review into
--                     approved)
--   too_late          the registration had expired
--   unknown_ref       no such provider reference
create or replace function ypm_private.apply_verification_result(
  p_provider_ref text, p_delivery_id text, p_outcome text, p_reason_code text, p_issued_at timestamptz
)
returns text language plpgsql as $$
declare
  v_sess   ypm_private.provider_sessions;
  v_reg    public.voter_registrations;
  v_result text;
  v_reason text := p_reason_code;
begin
  v_sess := (select s from ypm_private.provider_sessions s where s.provider_ref = p_provider_ref for update);
  if v_sess.registration_id is null then
    insert into ypm_private.verification_events (delivery_id, outcome, reason_code, result)
    values (p_delivery_id, p_outcome, p_reason_code, 'unknown_ref');
    return 'unknown_ref';
  end if;
  v_reg := (select r from public.voter_registrations r where r.id = v_sess.registration_id for update);

  if exists (select 1 from ypm_private.verification_events e
              where e.delivery_id = p_delivery_id and e.registration_id = v_reg.id) then
    v_result := 'duplicate';
  elsif v_sess.last_issued_at is not null and p_issued_at < v_sess.last_issued_at then
    v_result := 'stale';
  elsif v_reg.status = 'pending' then
    if v_reg.expires_at <= now() then
      update public.voter_registrations set status = 'expired' where id = v_reg.id;
      v_result := 'too_late';
    else
      update public.voter_registrations set status = p_outcome where id = v_reg.id;
      if p_outcome = 'expired' and v_reason is null then
        v_reason := 'provider_timeout';
      end if;
      update ypm_private.provider_sessions
         set reason_code = v_reason, decided_at = now(), last_issued_at = p_issued_at
       where registration_id = v_reg.id;
      v_result := 'applied';
    end if;
  elsif v_reg.status = p_outcome then
    v_result := 'duplicate';
  elsif v_reg.status = 'approved' and p_outcome in ('review', 'failed', 'expired') then
    -- Two different answers for one person: a person decides.
    update public.voter_registrations set status = 'review' where id = v_reg.id;
    update ypm_private.provider_sessions
       set reason_code = 'conflicting_results', last_issued_at = p_issued_at
     where registration_id = v_reg.id;
    v_result := 'conflict_review';
  else
    v_result := 'conflict_ignored';
    -- A "duplicate" or "failed" that arrives after the account was created
    -- can't undo it, but a person must look: logged, and listed for admins
    -- by admin_review_details (late_conflicts).
    if v_reg.status = 'claimed' and p_outcome in ('review', 'failed') then
      perform ypm_private.audit('simulated_provider', 'verification_conflict_after_claim', jsonb_build_object(
        'registration_id', v_reg.id, 'voter_id', v_reg.voter_id,
        'outcome', p_outcome, 'reason_code', p_reason_code));
    end if;
  end if;

  insert into ypm_private.verification_events (registration_id, delivery_id, outcome, reason_code, result)
  values (v_reg.id, p_delivery_id, p_outcome, p_reason_code, v_result);
  return v_result;
end;
$$;

-- Usable by the provider functions below.
create or replace function ypm_private.sim_provider_ready()
returns boolean language sql stable as $$
  select ypm_private.voter_accounts_enabled()
     and ypm_private.is_development()
     and coalesce((select verification_provider from public.settings where id = 1), 'none') = 'simulated';
$$;

-- ---------- 4. Retention (30 days) ----------
-- Deletes verification records finished more than 30 days ago:
--   * registrations that are claimed, rejected, failed or expired (or
--     pending/approved past their expiry), with their provider sessions,
--     delivery log and outbox entries
--   * delivery log entries with no registration (bad signatures, unknown
--     references) and delivered outbox entries
-- Never deletes ballots, votes, voter accounts, consent records, the audit
-- log, or registrations still waiting for review.
create or replace function ypm_private.purge_verification_records(p_actor text)
returns json language plpgsql as $$
declare
  v_cutoff timestamptz := now() - interval '30 days';
  v_regs   int;
  v_events int;
  v_outbox int;
begin
  delete from public.voter_registrations r
   where (r.status in ('claimed', 'rejected', 'failed', 'expired')
          or (r.status in ('pending', 'approved') and r.expires_at <= now()))
     and greatest(r.created_at, r.expires_at, coalesce(r.reviewed_at, r.created_at)) < v_cutoff;
  get diagnostics v_regs = row_count;   -- provider sessions, events and outbox go with them

  delete from ypm_private.verification_events where received_at < v_cutoff;
  get diagnostics v_events = row_count;
  delete from ypm_private.sim_outbox where created_at < v_cutoff;
  get diagnostics v_outbox = row_count;

  if v_regs + v_events + v_outbox > 0 then
    perform ypm_private.audit(p_actor, 'verification_records_purged', jsonb_build_object(
      'registrations', v_regs, 'events', v_events, 'outbox', v_outbox, 'older_than_days', 30));
  end if;
  return json_build_object('status', 'ok', 'registrations', v_regs, 'events', v_events,
                           'outbox', v_outbox, 'older_than_days', 30);
end;
$$;

-- ---------- 5. Public functions ----------

-- Tester: start a simulated provider check for a pending registration and
-- schedule its result. Scenarios:
--   normal         one signed delivery after p_delay_seconds
--   duplicate      the same delivery twice
--   bad_signature  one delivery signed with the wrong key (must be refused)
--   never          nothing is delivered (the registration later expires)
--   conflict       the result, then a contradicting one a second later
--   out_of_order   a newer "failed" arrives first, then the older result
-- Statuses: ok | disabled | unauthorized | error
create or replace function public.dev_provider_start(
  p_admin_session text, p_registration_token text, p_outcome text,
  p_reason_code text default null, p_delay_seconds int default 2, p_scenario text default 'normal'
)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label  text;
  v_reg    public.voter_registrations;
  v_key    bytea;
  v_ref    text;
  v_delay  interval := make_interval(secs => greatest(0, least(coalesce(p_delay_seconds, 2), 120)));
  v_reason text := p_reason_code;
  v_n      int := 0;
begin
  if not ypm_private.sim_provider_ready() then
    return json_build_object('status', 'disabled');
  end if;
  v_label := ypm_private.admin_session_label(p_admin_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  if p_outcome is null or p_outcome not in ('approved', 'review', 'failed') then
    return json_build_object('status', 'error', 'message', 'outcome must be approved, review or failed');
  end if;
  if p_scenario is null or p_scenario not in ('normal', 'duplicate', 'bad_signature', 'never', 'conflict', 'out_of_order') then
    return json_build_object('status', 'error', 'message', 'unknown scenario');
  end if;
  if v_reason is null then
    v_reason := case p_outcome when 'review' then 'possible_duplicate'
                               when 'failed' then 'poor_capture' end;
  end if;
  if v_reason is not null and v_reason not in ('liveness_failed', 'poor_capture', 'possible_duplicate') then
    return json_build_object('status', 'error', 'message', 'unknown reason code');
  end if;
  v_key := ypm_private.sim_provider_key();
  if v_key is null then
    return json_build_object('status', 'error', 'message', 'simulator key missing: re-run 005');
  end if;

  v_reg := (select r from voter_registrations r
             where r.token_hash = ypm_private.sha256_hex(p_registration_token) for update);
  if v_reg.id is null or v_reg.status <> 'pending' or v_reg.provider <> 'simulated'
     or v_reg.expires_at <= now() then
    return json_build_object('status', 'error', 'message', 'no pending simulated registration');
  end if;
  if exists (select 1 from ypm_private.provider_sessions where registration_id = v_reg.id) then
    return json_build_object('status', 'error', 'message', 'a check is already running for this registration');
  end if;

  perform ypm_private.purge_verification_records('retention');

  v_ref := 'simref_' || ypm_private.random_token();
  insert into ypm_private.provider_sessions (registration_id, provider, provider_ref)
  values (v_reg.id, 'simulated', v_ref);

  if p_scenario <> 'never' then
    declare
      d_id  text := 'del_' || ypm_private.random_token();
      body  text;
      body2 text;
      t0    timestamptz := now();
    begin
      body := json_build_object('provider', 'simulated', 'provider_ref', v_ref, 'delivery_id', d_id,
                                'outcome', p_outcome, 'reason_code', v_reason, 'issued_at', t0)::text;
      if p_scenario = 'out_of_order' then
        -- A newer contradicting result is delivered first; the original,
        -- older one arrives after it and must be ignored as stale.
        body2 := json_build_object('provider', 'simulated', 'provider_ref', v_ref,
                                   'delivery_id', 'del_' || ypm_private.random_token(),
                                   'outcome', 'failed', 'reason_code', 'poor_capture',
                                   'issued_at', t0 + interval '1 second')::text;
        insert into ypm_private.sim_outbox (registration_id, body, signature, deliver_after)
        values (v_reg.id, body2, ypm_private.sim_sign(v_key, body2), now() + v_delay),
               (v_reg.id, body, ypm_private.sim_sign(v_key, body), now() + v_delay + interval '1 second');
        v_n := 2;
      else
        insert into ypm_private.sim_outbox (registration_id, body, signature, deliver_after)
        values (v_reg.id, body,
                case when p_scenario = 'bad_signature'
                     then ypm_private.sim_sign(convert_to('not-the-key', 'UTF8'), body)
                     else ypm_private.sim_sign(v_key, body) end,
                now() + v_delay);
        v_n := 1;
        if p_scenario = 'duplicate' then
          insert into ypm_private.sim_outbox (registration_id, body, signature, deliver_after)
          values (v_reg.id, body, ypm_private.sim_sign(v_key, body), now() + v_delay);
          v_n := 2;
        elsif p_scenario = 'conflict' then
          body2 := json_build_object('provider', 'simulated', 'provider_ref', v_ref,
                                     'delivery_id', 'del_' || ypm_private.random_token(),
                                     'outcome', case when p_outcome = 'approved' then 'review' else 'approved' end,
                                     'reason_code', case when p_outcome = 'approved' then 'possible_duplicate' end,
                                     'issued_at', t0 + interval '1 second')::text;
          insert into ypm_private.sim_outbox (registration_id, body, signature, deliver_after)
          values (v_reg.id, body2, ypm_private.sim_sign(v_key, body2), now() + v_delay + interval '1 second');
          v_n := 2;
        end if;
      end if;
    end;
  end if;

  perform ypm_private.audit(v_label, 'dev_provider_started', jsonb_build_object(
    'registration_id', v_reg.id, 'outcome', p_outcome, 'scenario', p_scenario, 'deliveries', v_n));
  return json_build_object('status', 'ok', 'deliveries', v_n);
end;
$$;

-- Tester: deliveries that are due, each handed out once, for the tester's
-- page to relay to dev_provider_callback (playing the provider's network).
-- Statuses: ok (deliveries: [{body, signature}]) | disabled | unauthorized
create or replace function public.dev_provider_outbox(p_admin_session text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_out jsonb := '[]'::jsonb;
  d     record;
begin
  if not ypm_private.sim_provider_ready() then
    return json_build_object('status', 'disabled');
  end if;
  if ypm_private.admin_session_label(p_admin_session) is null then
    return json_build_object('status', 'unauthorized');
  end if;
  for d in
    select o.id, o.body, o.signature from ypm_private.sim_outbox o
     where o.delivered_at is null and o.deliver_after <= now()
     order by o.deliver_after, o.id
     limit 20
     for update skip locked
  loop
    update ypm_private.sim_outbox set delivered_at = now() where id = d.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object('body', d.body, 'signature', d.signature));
  end loop;
  return json_build_object('status', 'ok', 'deliveries', v_out);
end;
$$;

-- The provider's webhook. Untrusted: anyone can call it. Nothing changes
-- unless the signature is valid, the delivery is fresh (issued within the
-- last 10 minutes, not in the future) and well formed. The reply says only
-- whether it was accepted, never anything about the registration.
-- Statuses: ok (accepted, result) | rejected | disabled | rate_limited
create or replace function public.dev_provider_callback(p_body text, p_signature text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_ip     text := ypm_private.client_ip();
  v_key    bytea;
  v_msg    jsonb;
  v_issued timestamptz;
  v_result text;
begin
  if not ypm_private.sim_provider_ready() then
    return json_build_object('status', 'disabled');
  end if;
  if ypm_private.rate_limited('provider_callback:' || v_ip, 300, interval '5 minutes') then
    return json_build_object('status', 'rate_limited');
  end if;
  perform ypm_private.rate_hit('provider_callback:' || v_ip);

  v_key := ypm_private.sim_provider_key();
  if v_key is null or p_body is null or p_signature is null
     or length(p_body) > 2000
     or lower(p_signature) <> ypm_private.sim_sign(v_key, p_body) then
    insert into ypm_private.verification_events (result) values ('bad_signature');
    return json_build_object('status', 'rejected');
  end if;

  begin
    v_msg := p_body::jsonb;
    v_issued := (v_msg->>'issued_at')::timestamptz;
  exception when others then
    insert into ypm_private.verification_events (result) values ('malformed');
    return json_build_object('status', 'rejected');
  end;
  if v_msg->>'provider' is distinct from 'simulated'
     or coalesce(v_msg->>'provider_ref', '') = '' or coalesce(v_msg->>'delivery_id', '') = ''
     or v_msg->>'outcome' is null or v_msg->>'outcome' not in ('approved', 'review', 'failed', 'expired')
     or (v_msg->>'reason_code' is not null and v_msg->>'reason_code' not in
         ('liveness_failed', 'poor_capture', 'possible_duplicate', 'provider_timeout'))
     or v_issued is null then
    insert into ypm_private.verification_events (result) values ('malformed');
    return json_build_object('status', 'rejected');
  end if;
  if v_issued < now() - interval '10 minutes' or v_issued > now() + interval '1 minute' then
    insert into ypm_private.verification_events (delivery_id, outcome, result)
    values (v_msg->>'delivery_id', v_msg->>'outcome', 'expired_delivery');
    return json_build_object('status', 'rejected');
  end if;

  v_result := ypm_private.apply_verification_result(
    v_msg->>'provider_ref', v_msg->>'delivery_id', v_msg->>'outcome', v_msg->>'reason_code', v_issued);
  return json_build_object('status', 'ok', 'result', v_result);
end;
$$;

-- Admin: why each waiting review is waiting, and its delivery history
-- (outcomes, reason codes and times only); and late conflicts: accounts
-- that received a "duplicate" or "failed" result after they were created,
-- which a person should check.
-- Statuses: ok (reviews: [{registration_id, reason_code, deliveries,
--   conflicts, history: [{result, outcome, reason_code, received_at}]}],
--   late_conflicts: [{registration_id, voter_id, full_name, phone (masked),
--   account_status, outcome, reason_code, received_at}])
--   | disabled | unauthorized
create or replace function public.admin_review_details(p_session text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_out  json;
  v_late json;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  if ypm_private.admin_session_label(p_session) is null then
    return json_build_object('status', 'unauthorized');
  end if;
  v_out := (select coalesce(json_agg(x order by x.created_at), '[]'::json) from (
    select r.id as registration_id, r.created_at, s.reason_code,
           (select count(*) from ypm_private.verification_events e where e.registration_id = r.id) as deliveries,
           (select count(*) from ypm_private.verification_events e
             where e.registration_id = r.id and e.result in ('conflict_review', 'conflict_ignored')) as conflicts,
           coalesce((select json_agg(json_build_object('result', e.result, 'outcome', e.outcome,
                                                       'reason_code', e.reason_code, 'received_at', e.received_at)
                                     order by e.received_at, e.id)
                       from ypm_private.verification_events e where e.registration_id = r.id), '[]'::json) as history
      from voter_registrations r
      left join ypm_private.provider_sessions s on s.registration_id = r.id
     where r.status = 'review'
  ) x);
  v_late := (select coalesce(json_agg(y order by y.received_at), '[]'::json) from (
    select distinct on (r.id) r.id as registration_id, v.id as voter_id, v.full_name,
           ypm_private.mask_phone(v.phone) as phone, v.status as account_status,
           e.outcome, e.reason_code, e.received_at
      from ypm_private.verification_events e
      join voter_registrations r on r.id = e.registration_id
      join voters v on v.id = r.voter_id
     where e.result = 'conflict_ignored' and e.outcome in ('review', 'failed') and r.status = 'claimed'
     order by r.id, e.received_at desc
  ) y);
  return json_build_object('status', 'ok', 'reviews', v_out, 'late_conflicts', v_late);
end;
$$;

-- Admin: run the 30-day clean-up now (it also runs whenever a simulated
-- check starts). Statuses: ok (counts) | disabled | unauthorized
create or replace function public.admin_purge_verification_records(p_session text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_label text;
begin
  if not ypm_private.voter_accounts_enabled() then
    return ypm_private.disabled_reply();
  end if;
  v_label := ypm_private.admin_session_label(p_session);
  if v_label is null then
    return json_build_object('status', 'unauthorized');
  end if;
  return ypm_private.purge_verification_records(v_label);
end;
$$;

-- ---------- 6. Grants ----------
revoke all on all functions in schema ypm_private from public, anon, authenticated;
revoke all on all tables    in schema ypm_private from public, anon, authenticated;
revoke all on all sequences in schema ypm_private from public, anon, authenticated;

grant execute on function public.dev_provider_start(text, text, text, text, int, text) to anon;
grant execute on function public.dev_provider_outbox(text)                          to anon;
grant execute on function public.dev_provider_callback(text, text)                  to anon;
grant execute on function public.admin_review_details(text)                         to anon;
grant execute on function public.admin_purge_verification_records(text)             to anon;

commit;

-- ---------- Handy queries ----------
-- Delivery log:      select * from ypm_private.verification_events order by id desc limit 20;
-- Waiting outbox:    select id, deliver_after from ypm_private.sim_outbox where delivered_at is null;
-- Clean up now:      select ypm_private.purge_verification_records('owner');
