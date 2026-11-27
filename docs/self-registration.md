# Voter self-registration (migration 008)

**What it does.** With voting codes *optional* (dashboard: "Codes optional"),
a voter enters their full name and phone number and goes straight to the
ballot. The database:

1. refuses a number that already has a ballot (one ballot per number, as
   before), and never reopens someone else's unfinished ballot;
2. limits **new self-registrations per IP address**: 30 an hour by default.
   Only successful new registrations count, so typos, refusals and resumes
   never use it up. Voters with a leader-issued code are never limited by it;
3. creates a **voter code tied to that number**, shown to the voter once
   (and kept on that device). With the number it reopens the ballot on
   another phone. Only its hash is stored;
4. allows **one submitted ballot per number and per code**.

With **Codes required** switched on, nothing changes from 001: a new ballot
needs a code from a youth leader. Leader-issued codes (Voting codes → Generate)
work in both modes, and also unblock a voter on a busy network.

**Limit to know about.** Phone numbers aren't verified (no SMS: zero cost),
so someone can still invent numbers. The IP limit slows mass registration
from one network; it can't stop someone using many networks. If that
matters on the day, switch **Codes required** on.

**Not included:** biometrics, paid services, device fingerprinting, new
dependencies, voter accounts (003–007).

## Files

- `migrations/008_self_registration.sql`: needs 001 and 002; refuses to run
  over 003. Adds `settings.self_registration_per_ip_hour` and replaces
  `begin_ballot` (same signature and statuses). Changes no ballot or vote.
- `migrations/008_self_registration.down.sql`: puts 001's `begin_ballot`
  back exactly. Keeps every ballot, vote and code; codes already given out
  still reopen their own ballot.
- `src/pages/Vote.jsx`: shows the voter code; explains the network limit.

## Checked

- Tests: `tests/db/self-registration.test.mjs` (17) and
  `tests/ui/dom/self-registration-page.test.mjs` (3); full suite passes.
- Rehearsal on the verified Production backup (local copy only):
  ```powershell
  node scripts\verify-dev-backup.mjs "<backup folder>" --production --rehearse --through 008 --rollback
  ```
  001 + 002 + ballot-sync + 008 install and undo with every ballot, vote and
  result unchanged, and no table removed.

## Development (done 27 Nov 2026)

006, 005, 004 and 003 undone, then 008 installed, after a verified backup
(`dev-pre-008-20261127-114138`) and a rehearsal of the same path on it.
`node scripts\dev-selfreg-check.mjs --ip-limit 3` passed on Development (17
checks). The voter-account work is kept in Git (tag `voter-accounts-003-007`).

## Production release

**Order matters: site first, then 008.** The new site works on a database
without 008 (no code box; tested). The current site works on a database
with 008 but never shows the voter code, so voters registered through it
couldn't resume on another phone (tested); hence site first.

1. **Backup** (read-only; your window; password at the prompt):
   ```powershell
   cd C:\Users\Bright\Downloads\ypm-awards
   git checkout feature/self-registration
   powershell -ExecutionPolicy Bypass -File scripts\dev-backup.ps1 -Production -ProjectRef mqeqziujujnraotgfhbu -Label pre-008 -DbHost aws-1-eu-west-1.pooler.supabase.com -DbUser postgres.mqeqziujujnraotgfhbu
   node scripts\verify-dev-backup.mjs "<folder>" --production --rehearse --through 008 --rollback
   ```
   Must end `BACKUP VERIFIED` and list 001, 002 as already installed.
2. **Counts** (Production SQL editor, read-only): ballots, submitted, votes,
   codes (query below).
3. **Site** (approval): merge `feature/self-registration` into `main`, test,
   build, push; wait for Vercel "Ready".
4. **Database** (approval): `migrations\008_self_registration.sql` in a new
   blank tab; it must say "Success".
5. **Check**: the same counts (equal or higher, never lower), and
   `voting_status` still answers; a test registration on the live page shows
   "Your voter code" (use your own number, or leave it: one real ballot).

```sql
select (select count(*) from public.ballots) as ballots,
       (select count(completed_at) from public.ballots) as submitted,
       (select count(*) from public.votes) as votes,
       (select count(*) from public.voting_codes) as codes,
       to_regprocedure('ypm_private.self_reg_ip_blocked(text)') is not null as has_008;
```

**Rollback, lightest first:** switch **Codes required** on (stops
self-registration at once); run `008_self_registration.down.sql` (codes
already given out keep working); Vercel → promote the previous deployment
(works with or without 008). Ballots and votes are kept in every case.

## Useful SQL

```sql
-- Change the per-IP limit (new self-registrations per address per hour):
update public.settings set self_registration_per_ip_hour = 60 where id = 1;
-- How many voters registered themselves:
select count(*) from public.voting_codes where created_by = 'self-registration';
-- Busiest addresses in the last hour (a signal to look at, not proof):
select bucket, count(*) from public.rate_events
 where bucket like 'voter:self-reg-ip:%' and at > now() - interval '1 hour'
 group by 1 order by 2 desc limit 20;
```
