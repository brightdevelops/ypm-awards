-- ============================================================
-- Undo migration 009 (voter IP addresses in the admin dashboard).
--
-- Stops recording IPs, erases the ones recorded, and puts back the
-- dashboard exactly as 001 defines it. Keeps every ballot and vote. Leaves
-- the (now empty) voter_ip column in place, so nothing is dropped.
-- Works with or without 008. Safe to run more than once.
-- ============================================================

begin;

drop trigger if exists ballots_set_ip on public.ballots;
drop function if exists ypm_private.set_ballot_ip();
drop index if exists public.ballots_voter_ip_idx;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'ballots' and column_name = 'voter_ip') then
    execute 'update public.ballots set voter_ip = null where voter_ip is not null';
  end if;
end;
$$;

-- ---- dashboard_json, copied unchanged from 001_secure_voting.sql ----
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
               (voting_code_id is not null) as via_code
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
