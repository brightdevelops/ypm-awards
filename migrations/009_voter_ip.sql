-- ============================================================
-- YPM Youth Awards — Migration 009: show each voter's IP address to admins
--
-- Records the IP address a ballot was started from, and shows it in the
-- admin dashboard's voter list with how many ballots share that address,
-- so admins can spot one person registering several numbers.
--
-- How:
--   * ballots gets one new, empty column: voter_ip.
--   * A trigger fills it in whenever a new ballot is created, from the same
--     request headers the rate limits already read (ypm_private.client_ip).
--     begin_ballot itself is not changed, so this works with or without
--     migration 008.
--   * ypm_private.dashboard_json returns voter_ip and ip_count (ballots
--     from the same address) for each voter. Admin session required, as
--     before; voters never see it.
--
-- Limits (say so to anyone reading the list):
--   * Ballots started before 009 have no IP; it can't be recovered.
--   * Many people share one address: church Wi-Fi, and mobile networks
--     that put hundreds of phones behind one IP. A shared IP is a reason
--     to look closer, not proof.
--   * Clients can partly forge the header it comes from.
--
-- DOES NOT modify or delete any existing ballot or vote.
-- Run after 001 and 002 (008 optional). Safe to run more than once.
-- Undo with 009_voter_ip.down.sql. Erase the IPs after results night:
--   update public.ballots set voter_ip = null;
-- ============================================================

begin;

do $$
begin
  if to_regclass('public.voting_codes') is null
     or to_regprocedure('ypm_private.dashboard_json(text)') is null then
    raise exception 'Migration 001 is not installed. Run 001 (and 002) first.';
  end if;
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is not null
     or to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is not null then
    raise exception 'Migration 003 is installed. This file is for databases without voter accounts. Don''t run it on this database.';
  end if;
end;
$$;

alter table public.ballots add column if not exists voter_ip text;
create index if not exists ballots_voter_ip_idx on public.ballots (voter_ip) where voter_ip is not null;

-- Never blocks a ballot: if the address can't be read for any reason, the
-- ballot is created without one.
create or replace function ypm_private.set_ballot_ip()
returns trigger language plpgsql as $$
begin
  if new.voter_ip is null then
    begin
      new.voter_ip := nullif(ypm_private.client_ip(), 'unknown');
    exception when others then
      new.voter_ip := null;
    end;
  end if;
  return new;
end;
$$;
revoke all on function ypm_private.set_ballot_ip() from public;

drop trigger if exists ballots_set_ip on public.ballots;
create trigger ballots_set_ip
  before insert on public.ballots
  for each row execute function ypm_private.set_ballot_ip();

-- Same as 001's, with voter_ip and ip_count on each voter.
create or replace function ypm_private.dashboard_json(p_label text)
returns json language sql stable as $$
  select json_build_object(
    'status', 'ok',
    'key_label', p_label,
    'voting_open',         coalesce((select voting_open         from public.settings where id = 1), true),
    'require_voting_code', coalesce((select require_voting_code from public.settings where id = 1), false),
    'ballots_started',   (select count(*) from public.ballots),
    'ballots_completed', (select count(*) from public.ballots where completed_at is not null),
    -- only submitted ballots are counted
    'tally', (
      select coalesce(json_agg(t), '[]'::json) from (
        select v.category_id, v.nominee_name, count(*)::int as votes
          from public.votes v
          join public.ballots b on b.id = v.ballot_id
         where b.completed_at is not null
         group by v.category_id, v.nominee_name
         order by v.category_id, count(*) desc
      ) t
    ),
    'voters', (
      select coalesce(json_agg(x), '[]'::json) from (
        select voter_name, voter_phone, completed_at,
               (voting_code_id is not null) as via_code,
               voter_ip,
               case when voter_ip is null then null
                    else (count(*) over (partition by voter_ip))::int end as ip_count
          from public.ballots order by started_at desc
      ) x
    ),
    'codes', (
      select json_build_object(
        'issued',    count(*),
        'redeemed',  count(*) filter (where redeemed_at is not null),
        'revoked',   count(*) filter (where revoked_at is not null),
        'available', count(*) filter (where redeemed_at is null and revoked_at is null
                                        and (expires_at is null or expires_at > now()))
      ) from public.voting_codes
    )
  );
$$;
revoke all on function ypm_private.dashboard_json(text) from public;

commit;

-- ---------- Handy queries ----------
-- Addresses with more than one ballot:
--   select voter_ip, count(*), string_agg(voter_name || ' ' || voter_phone, ', ')
--     from public.ballots where voter_ip is not null
--    group by 1 having count(*) > 1 order by 2 desc;
-- Erase all recorded IPs (after results night):
--   update public.ballots set voter_ip = null;
