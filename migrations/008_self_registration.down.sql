-- ============================================================
-- Undo migration 008 (voter self-registration).
--
-- Puts back begin_ballot exactly as migration 001 defines it, so new
-- ballots no longer get a voter code and the per-IP registration limit
-- stops. Keeps every ballot, vote and voting code: voter codes already
-- given out keep working to reopen their own ballot (001 accepts the code
-- a ballot was started with).
-- Leaves settings.self_registration_per_ip_hour in place (unused, harmless),
-- so nothing is dropped. Safe to run more than once.
-- ============================================================

begin;

-- ---- begin_ballot, copied unchanged from 001_secure_voting.sql ----
create or replace function public.begin_ballot(
  p_name      text,
  p_phone     text,
  p_code      text default null,
  p_ballot_id uuid default null
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings   public.settings;
  v_phone      text;
  v_ip         text;
  v_code_norm  text;
  v_code       public.voting_codes;
  v_code_ok    boolean := false;
  v_code_fresh boolean := false;   -- valid, unused and unexpired
  v_ballot     public.ballots;
  v_id         uuid;
  v_constraint text;
begin
  v_settings := (select s from settings s where s.id = 1);
  if not coalesce(v_settings.voting_open, true) then
    return json_build_object('status', 'closed');
  end if;

  v_phone := ypm_private.normalize_phone(p_phone);
  if coalesce(btrim(p_name), '') = '' or length(v_phone) < 10 then
    return json_build_object('status', 'error', 'message', 'name and phone required');
  end if;

  v_ip := ypm_private.client_ip();
  if ypm_private.phone_blocked(v_phone) then
    return json_build_object('status', 'rate_limited');
  end if;

  -- A code, if given, must exist, not be revoked, and match this number if
  -- it was issued for one. The IP limit applies to code attempts only.
  v_code_norm := ypm_private.normalize_code(p_code);
  if v_code_norm is not null then
    if ypm_private.code_ip_blocked(v_ip) then
      return json_build_object('status', 'rate_limited');
    end if;
    v_code := (select c from voting_codes c where c.code_hash = ypm_private.sha256_hex(v_code_norm));
    v_code_ok := v_code.id is not null
                 and v_code.revoked_at is null
                 and (v_code.phone is null or v_code.phone = v_phone);
    if not v_code_ok then
      perform ypm_private.code_failure(v_phone, v_ip);
      return json_build_object('status', 'invalid_code');
    end if;
    v_code_fresh := v_code.redeemed_at is null
                    and (v_code.expires_at is null or v_code.expires_at > now());
  end if;

  v_ballot := (select b from ballots b where b.voter_phone = v_phone);

  -- ---- This number already has a ballot ----
  if v_ballot.id is not null then
    if v_ballot.completed_at is not null then
      -- The code, if any, is not used up.
      return json_build_object('status', 'already_voted');
    end if;

    if p_ballot_id is not null and p_ballot_id = v_ballot.id then
      null;  -- the device that started it

    elsif v_code_ok and v_ballot.voting_code_id = v_code.id then
      null;  -- the code it was started with

    elsif v_code_ok and v_code_fresh and v_code.phone = v_phone then
      -- A leader issued a code for this number (lost phone, cleared browser,
      -- or a ballot started before codes existed). Attach it, so the voter
      -- can reopen the ballot with it from now on.
      update voting_codes set redeemed_at = now()
       where id = v_code.id and redeemed_at is null;
      if not found then
        return json_build_object('status', 'invalid_code');
      end if;
      update ballots set voting_code_id = v_code.id where id = v_ballot.id;

    else
      -- Counts against this number only, never the IP address.
      perform ypm_private.phone_failure(v_phone);
      return json_build_object('status', 'resume_required');
    end if;

    return json_build_object('status', 'resumed',
                             'ballot_id', v_ballot.id,
                             'picks', ypm_private.ballot_picks(v_ballot.id));
  end if;

  -- ---- New ballot ----
  if coalesce(v_settings.require_voting_code, false) and not v_code_ok then
    return json_build_object('status', 'code_required');
  end if;

  if v_code_ok and not v_code_fresh then
    -- A used or expired code.
    perform ypm_private.code_failure(v_phone, v_ip);
    return json_build_object('status', 'invalid_code');
  end if;

  v_id := gen_random_uuid();
  begin
    insert into ballots (id, voter_name, voter_phone, voting_code_id)
    values (v_id, btrim(p_name), v_phone, case when v_code_ok then v_code.id end);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'ballots_voting_code_unique' then
      -- Someone redeemed this code a moment ago.
      return json_build_object('status', 'invalid_code');
    end if;
    -- Two devices started the same number at the same instant. Retrying
    -- goes through the "already has a ballot" path above.
    return json_build_object('status', 'error', 'message', 'please try again');
  end;

  if v_code_ok then
    update voting_codes set redeemed_at = now() where id = v_code.id;
  end if;

  return json_build_object('status', 'started', 'ballot_id', v_id, 'picks', '[]'::json);
end;
$$;

grant execute on function public.begin_ballot(text, text, text, uuid) to anon;

drop function if exists ypm_private.self_reg_ip_blocked(text);

commit;
