# Revoke synthetic test credentials (Development only)

**Not run yet. Run only when approved, and only in the Development project.**

Phase 3.3 and 3.4 manual testing showed voter codes on screen for synthetic
test identities (numbers `08155500000`–`08155500999`). This procedure makes
every one of those credentials stop working **without deleting any record**:
voter accounts become `revoked`, their sign-ins end, and registrations still in
progress are closed. Ballots, votes, registrations and the audit log are kept.

Every write below also checks that the database is marked as development, so
on any other database it changes nothing.

How to run, as before:

- Development SQL editor only. The address bar must show `vliytvqhjvuhulpvmuat`.
- New blank tab for each step, nothing highlighted, never a saved snippet.
- One step at a time. Check each result before the next step.
- Never paste admin keys into chat.

---

## Step 1: preview (read-only)

```sql
select
  (select environment from ypm_private.deployment where id = 1) as env,
  (select count(*) from public.voters
    where phone ~ '^08155500[0-9]{3}$' and status = 'active') as active_voters,
  (select count(*) from public.voter_sessions s
     join public.voters v on v.id = s.voter_id
    where v.phone ~ '^08155500[0-9]{3}$') as sessions,
  (select count(*) from public.voter_registrations
    where phone ~ '^08155500[0-9]{3}$'
      and status in ('pending', 'approved', 'review')) as open_regs,
  (select count(*) from public.voters
    where phone !~ '^08155500[0-9]{3}$') as non_test_voters;
```

Expected: `env` = `development`. Note the counts. `non_test_voters` should be
`0` on Development; if it isn't, stop and report it (those accounts aren't
touched by this procedure).

## Step 2: revoke the synthetic voter accounts

Their voter codes stop working immediately.

```sql
update public.voters
   set status = 'revoked',
       revoked_at = now(),
       revoked_reason = 'synthetic test credential cleanup'
 where phone ~ '^08155500[0-9]{3}$'
   and status = 'active'
   and (select environment from ypm_private.deployment
         where id = 1) = 'development'
returning full_name, right(phone, 4) as last4;
```

Expected: one row per active synthetic voter (the Step 1 `active_voters` count).

## Step 3: end their sign-ins

Session rows hold only hashes; this removes them so no device stays signed in.

```sql
delete from public.voter_sessions s
 using public.voters v
 where v.id = s.voter_id
   and v.phone ~ '^08155500[0-9]{3}$'
   and (select environment from ypm_private.deployment
         where id = 1) = 'development'
returning s.voter_id;
```

## Step 4: close registrations still in progress

`pending` and `approved` registrations could still be claimed for a code;
`review` ones could still be approved. They are closed, not deleted.

```sql
update public.voter_registrations
   set status = case status when 'review' then 'rejected'
                            else 'expired' end,
       expires_at = least(expires_at, now()),
       reviewed_by = case status when 'review' then 'sql-cleanup'
                              else reviewed_by end,
       reviewed_at = case status when 'review' then now()
                              else reviewed_at end
 where phone ~ '^08155500[0-9]{3}$'
   and status in ('pending', 'approved', 'review')
   and (select environment from ypm_private.deployment
         where id = 1) = 'development'
returning right(phone, 4) as last4, status;
```

## Step 5: record it in the audit log

```sql
insert into public.admin_audit (actor, action, detail)
select 'sql-cleanup', 'synthetic_credentials_revoked',
       jsonb_build_object('phones', '08155500000-08155500999')
 where (select environment from ypm_private.deployment
         where id = 1) = 'development'
returning action;
```

## Step 6: check (read-only)

```sql
select
  (select count(*) from public.voters
    where phone ~ '^08155500[0-9]{3}$' and status = 'active') as active_voters,
  (select count(*) from public.voters
    where phone ~ '^08155500[0-9]{3}$' and status = 'revoked') as revoked_voters,
  (select count(*) from public.voter_sessions s
     join public.voters v on v.id = s.voter_id
    where v.phone ~ '^08155500[0-9]{3}$') as sessions,
  (select count(*) from public.voter_registrations
    where phone ~ '^08155500[0-9]{3}$'
      and status in ('pending', 'approved', 'review')) as open_regs,
  (select count(*) from public.ballots
    where voter_phone ~ '^08155500[0-9]{3}$') as ballots_kept;
```

Expected: `active_voters` 0, `sessions` 0, `open_regs` 0. `ballots_kept` is
unchanged from before (nothing was deleted).

## Step 7: admin sessions and keys (Development)

1. Sign out of the tester panel and the admin dashboard in every browser used
   for testing.
2. If a Development admin key was ever visible (screen share, recording,
   screenshot, shared screen at a meeting), set a new one in the Development
   SQL editor yourself. Type the new key directly into the editor; don't paste
   it into chat:

   ```sql
   select ypm_private.set_admin_key('leader', '<new key, 16+ characters>');
   ```

   Repeat for `inventor` if that key was used. This also invalidates the old
   key immediately. Clear the editor tab afterwards and don't save it as a
   snippet.

## Optional: Production read-only check

In the **Production** SQL editor (address bar `mqeqziujujnraotgfhbu`), to
confirm no synthetic test number ever reached Production. Read-only.

```sql
select count(*) as synthetic_ballots
  from public.ballots
 where voter_phone ~ '^08155500[0-9]{3}$';
```

Expected: `0`. Don't run any other statement from this file in Production.

---

After this, testing again simply means registering new synthetic numbers.
Revoked numbers stay registered, so use numbers that haven't been used
before. (With migration 004 an admin can restore a revoked account, which
always issues a new code; the revoked codes never work again.)
