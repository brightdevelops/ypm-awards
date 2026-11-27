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
