-- ============================================================
-- YPM Youth Awards — undo Migration 002.
-- Restores the unchecked save_vote and removes the ballot tables.
-- Votes are kept. NOTE: this reopens the hole that lets a crafted request
-- vote for names that aren't on the ballot.
-- ============================================================

begin;

-- Refuses to run over migration 003: this file would silently replace 003's
-- protected voting functions (save_vote, begin_ballot) with unprotected ones.
do $$
begin
  if to_regprocedure('ypm_private.save_vote_002(uuid,text,text)') is not null
     or to_regprocedure('ypm_private.begin_ballot_001(text,text,text,uuid)') is not null then
    raise exception 'Migration 003 is installed. Running this file would replace its protected voting functions. Undo 004 and 003 first (in that order), or don''t run this file.';
  end if;
end;
$$;

alter table public.votes drop constraint if exists votes_nominee_fk;

create or replace function public.save_vote(
  p_ballot_id uuid, p_category_id text, p_nominee_name text
)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open      boolean;
  v_completed timestamptz;
begin
  select voting_open into v_open from settings where id = 1;
  if not coalesce(v_open, true) then
    return json_build_object('status', 'closed');
  end if;

  select completed_at into v_completed from ballots where id = p_ballot_id;
  if not found then
    return json_build_object('status', 'error', 'message', 'unknown ballot');
  end if;
  if v_completed is not null then
    return json_build_object('status', 'error', 'message', 'already submitted');
  end if;

  insert into votes (ballot_id, category_id, nominee_name)
  values (p_ballot_id, p_category_id, p_nominee_name)
  on conflict (ballot_id, category_id)
  do update set nominee_name = excluded.nominee_name, created_at = now();

  return json_build_object('status', 'ok');
end;
$$;

drop table if exists public.ballot_nominees;
drop table if exists public.ballot_categories;

commit;
