-- ============================================================
-- YPM Youth Awards — Migration 008: voter self-registration
--
-- While voting codes are NOT required (dashboard: "Codes optional"), a
-- voter who enters their name and phone number is registered on the spot:
--
--   1. The phone number must not already have a ballot (one ballot per
--      number, as before: ballots.voter_phone is unique).
--   2. New self-registrations are limited per IP address (default 30 an
--      hour; settings.self_registration_per_ip_hour). Only successful new
--      registrations count, so typos and shared Wi-Fi cost nothing until
--      that many new voters start from one address in an hour. Voters with
--      a leader-issued code are never limited by this.
--   3. A unique voter code is created for that phone number and returned
--      once. With their phone number it reopens the ballot on another
--      device (lost phone, cleared browser). Only its hash is stored.
--   4. The voter goes straight to the ballot.
--
-- With "Codes required" switched on, nothing changes from 001: a new ballot
-- needs a code from a youth leader. Leader-issued codes work in both modes.
--
-- Note: phone numbers are not verified (no SMS: zero cost). Someone could
-- still invent numbers; the IP limit slows that down, it can't stop it.
--
-- DOES NOT modify or delete any existing ballot, vote or table. Adds one
-- settings column and replaces begin_ballot (same signature and statuses;
-- "started" now also carries voter_code).
-- Run after 001 and 002. Safe to run more than once.
-- Undo with 008_self_registration.down.sql.
-- ============================================================

begin;

do $$
begin
  if to_regprocedure('public.begin_ballot(text,text,text,uuid)') is null
     or to_regclass('public.voting_codes') is null then
    raise exception 'Migration 001 is not installed. Run 001 (and 002) first.';
  end if;
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is not null
     or to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is not null then
    raise exception 'Migration 003 is installed. This file would replace its protected voting functions. Don''t run it on this database.';
  end if;
end;
$$;

alter table public.settings
  add column if not exists self_registration_per_ip_hour int not null default 30
    check (self_registration_per_ip_hour >= 1);

create or replace function ypm_private.self_reg_ip_blocked(p_ip text)
returns boolean language sql stable as $$
  select p_ip <> 'unknown'
     and ypm_private.rate_limited(
           'voter:self-reg-ip:' || p_ip,
           coalesce((select self_registration_per_ip_hour from public.settings where id = 1), 30),
           interval '1 hour');
$$;

revoke all on function ypm_private.self_reg_ip_blocked(text) from public;

-- Same as 001, except the "New ballot" part at the end.
-- Statuses: started | resumed | already_voted | closed | code_required
--           | invalid_code | resume_required | rate_limited | error
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
  v_new_code   text;
  v_new_code_id uuid;
  v_tries      int := 0;
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

  -- ---- This number already has a ballot (unchanged from 001) ----
  if v_ballot.id is not null then
    if v_ballot.completed_at is not null then
      return json_build_object('status', 'already_voted');
    end if;

    if p_ballot_id is not null and p_ballot_id = v_ballot.id then
      null;  -- the device that started it

    elsif v_code_ok and v_ballot.voting_code_id = v_code.id then
      null;  -- the code it was started with (leader-issued or self-registered)

    elsif v_code_ok and v_code_fresh and v_code.phone = v_phone then
      update voting_codes set redeemed_at = now()
       where id = v_code.id and redeemed_at is null;
      if not found then
        return json_build_object('status', 'invalid_code');
      end if;
      update ballots set voting_code_id = v_code.id where id = v_ballot.id;

    else
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
    perform ypm_private.code_failure(v_phone, v_ip);
    return json_build_object('status', 'invalid_code');
  end if;

  -- Self-registration: no code given, codes not required.
  if not v_code_ok and ypm_private.self_reg_ip_blocked(v_ip) then
    return json_build_object('status', 'rate_limited', 'reason', 'network');
  end if;

  v_id := gen_random_uuid();
  begin
    if not v_code_ok then
      -- A voter code for this number, used by this ballot from the start.
      loop
        v_tries := v_tries + 1;
        if v_tries > 5 then
          raise exception 'could not generate a unique code';
        end if;
        v_new_code    := ypm_private.new_code();
        v_new_code_id := gen_random_uuid();
        insert into voting_codes (id, code_hash, phone, note, created_by, redeemed_at)
        values (v_new_code_id, ypm_private.sha256_hex(ypm_private.normalize_code(v_new_code)),
                v_phone, 'Self-registration', 'self-registration', now())
        on conflict (code_hash) do nothing;
        exit when found;
      end loop;
    end if;

    insert into ballots (id, voter_name, voter_phone, voting_code_id)
    values (v_id, btrim(p_name), v_phone,
            case when v_code_ok then v_code.id else v_new_code_id end);
  exception when unique_violation then
    -- Rolls back the voter code above too.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'ballots_voting_code_unique' then
      return json_build_object('status', 'invalid_code');
    end if;
    return json_build_object('status', 'error', 'message', 'please try again');
  end;

  if v_code_ok then
    update voting_codes set redeemed_at = now() where id = v_code.id;
    return json_build_object('status', 'started', 'ballot_id', v_id, 'picks', '[]'::json);
  end if;

  if v_ip <> 'unknown' then
    perform ypm_private.rate_hit('voter:self-reg-ip:' || v_ip);
  end if;
  return json_build_object('status', 'started', 'ballot_id', v_id, 'picks', '[]'::json,
                           'voter_code', v_new_code);
end;
$$;

grant execute on function public.begin_ballot(text, text, text, uuid) to anon;

commit;

-- ---------- Handy queries ----------
-- Change the per-IP limit (new self-registrations per address per hour):
--   update public.settings set self_registration_per_ip_hour = 60 where id = 1;
-- Self-registrations so far:
--   select count(*) from public.voting_codes where created_by = 'self-registration';
-- Busiest addresses in the last hour (a signal to look at, not proof):
--   select bucket, count(*) from public.rate_events
--    where bucket like 'voter:self-reg-ip:%' and at > now() - interval '1 hour'
--    group by 1 order by 2 desc limit 20;
