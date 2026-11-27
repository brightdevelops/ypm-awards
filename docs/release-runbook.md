# Release runbook: exact commands

Companion to `docs/production-release-plan.md`. **Nothing here has been
run in Production.** Every Production step waits for your final
authorization. PowerShell commands run in your own window from
`C:\Users\Bright\Downloads\ypm-awards`; SQL runs in the Supabase SQL editor
of the project named in the step (check the address bar).

**The release is in two parts.** Migration 007 publishes the voter notice
as final, so it runs in Production only after leadership approves the
notice:

- **Part 1:** 001–006 and the new site. Voter accounts stay "disabled" in
  Production, anonymous voting carries on, and the dashboard says voter
  management is switched off.
- **Part 2** (after approval): the approved notice, 007, then switching on.

---

## 0. Development: install and check 007

```powershell
git status --short migrations          # prints nothing
git hash-object migrations\007_production_voter_accounts.sql
# a6849f5cecee1e245c6c818729ba46a87ead4bb2
Get-Content -Raw -Encoding UTF8 migrations\007_production_voter_accounts.sql | Set-Clipboard
```
In the Development SQL editor (`vliytvqhjvuhulpvmuat`), open a new blank tab
and paste. It should start with `-- YPM Youth Awards — Migration 007`. Click
**Run**; expect "Success". Then:
```sql
select environment, voter_accounts_live from ypm_private.deployment;
-- development | false
select version, is_draft, is_current, retired_at is null as open
  from ypm_private.consent_versions order by version;
-- draft-2026-11-dev        | true  | true  | true
-- ypm-register-2026-12-v1  | false | false | true
select ypm_private.voter_accounts_enabled() as enabled;   -- true (development)
```
Tell me when it's done: I re-run the 34 public checks on Development.
Then do a short manual pass: the prototype's youth-leader path still works,
and `/voter` under `npm run dev` signs a voter in. It shows "Registration
opens soon" until the notice is approved; that is expected.

---

## 1. Release candidate (before the day, no Production changes)

```powershell
git status --short                     # prints nothing
npm test                               # all pass
npm run build
npm run ballot:sql; git status --short migrations\ballot-sync.sql   # prints nothing
$expected = [ordered]@{
  'migrations\001_secure_voting.sql'             = 'e535e87b3bcbb51b7e9b842e065f428b0f536b62'
  'migrations\002_ballot_validation.sql'         = '66a201046d4dc227a32132adc879d2a56c766897'
  'migrations\ballot-sync.sql'                   = '439b7755c0445901d4ace22036036f576f253167'
  'migrations\003_voter_accounts.sql'            = 'f9380ff3e1f3eef72cd3e3b5953da759b6d608d4'
  'migrations\004_voter_safeguards.sql'          = 'edc49f76473777c235ab7f0ca0a1dea19911f086'
  'migrations\005_simulated_provider.sql'        = '3d3cad22c4850cdf24bab78c86ca934aa642e7c8'
  'migrations\006_verification_choice.sql'       = '3107683616dd8829e90466fea59815e1e59dd41a'
  'migrations\007_production_voter_accounts.sql' = 'a6849f5cecee1e245c6c818729ba46a87ead4bb2'
}
$bad = $expected.GetEnumerator() | Where-Object { (git hash-object $_.Key) -ne $_.Value }
if ($bad) { 'STOP, changed: ' + ($bad.Key -join ', ') } else { 'ALL MIGRATION FILES MATCH' }
```

## 2. Production read-only checks (Production SQL editor)

```sql
select count(*) as ballots, count(completed_at) as submitted from public.ballots;
select count(*) as votes from public.votes;
select label, length(key) >= 16 as long_enough from public.admin_keys;
select exists (select 1 from pg_extension where extname = 'supabase_vault') as vault,
       to_regclass('public.admin_sessions') is not null as has_001,
       (select voting_open from public.settings where id = 1) as voting_open;
```
Write the numbers down. Expect `vault = true` and `has_001 = false`.

## 3. Production backup and rehearsal (read-only)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev-backup.ps1 -Production -ProjectRef <production ref> -Label pre-release
#   (if the direct host doesn't connect, add the Session pooler details:
#    -DbHost aws-0-<region>.pooler.supabase.com -DbUser postgres.<production ref>)
node scripts\verify-dev-backup.mjs "<folder it printed>" --production --rehearse
```
It must end `BACKUP VERIFIED`, with "every ballot and vote is exactly as
before" and "the results … are unchanged". Then encrypt the folder as
usual. To re-check the encrypted copy later:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\verify-encrypted-backup.ps1 -Backup "<encrypted file>" -Production
```

---

## 4. Part 1: maintenance window (about 20 minutes)

| When | Who | What |
|---|---|---|
| T−1 day | You | Tell the leaders the time; steps 1–3 done; backup verified |
| T−10 min | You | Step 2's counts again (they may have grown; note them) |
| T+0 | You | 4a: migrations 001–006 |
| T+10 | You | 4b: checks |
| T+12 | You (merge), Vercel | 4c: deploy the site |
| T+15 | You | 4d: smoke test; tell the leaders it's done |

Voting can stay open: 001 is built to go in mid-election. Between 4a and
4c, a voter resuming on a *different* device sees "Could not start" on the
old page.

**4a. Migrations** (Production SQL editor; each file in a **new blank
tab**; expect "Success" each time):
```powershell
Get-Content -Raw -Encoding UTF8 migrations\001_secure_voting.sql | Set-Clipboard        # tab 1, Run
Get-Content -Raw -Encoding UTF8 migrations\002_ballot_validation.sql | Set-Clipboard    # tab 2, Run
Get-Content -Raw -Encoding UTF8 migrations\ballot-sync.sql | Set-Clipboard             # tab 3, Run
Get-Content -Raw -Encoding UTF8 migrations\003_voter_accounts.sql | Set-Clipboard      # tab 4, Run
Get-Content -Raw -Encoding UTF8 migrations\004_voter_safeguards.sql | Set-Clipboard    # tab 5, Run
Get-Content -Raw -Encoding UTF8 migrations\005_simulated_provider.sql | Set-Clipboard  # tab 6, Run
Get-Content -Raw -Encoding UTF8 migrations\006_verification_choice.sql | Set-Clipboard # tab 7, Run
```
A file that fails changes nothing. Stop there, keep the error, and don't
continue to the next file.

**4b. Checks** (read-only):
```sql
-- 1. Same as T−10 (or higher, if people voted meanwhile; never lower):
select count(*) as ballots, count(completed_at) as submitted from public.ballots;
select count(*) as votes from public.votes;
-- 2. Still Production, everything off, no simulator key:
select d.environment, s.verification_provider, s.registration_mode,
       ypm_private.voter_accounts_enabled() as voter_accounts,
       exists (select 1 from vault.secrets where name = 'ypm_sim_provider_key') as sim_key
  from ypm_private.deployment d, public.settings s where s.id = 1;
--    production | none | off | false | false
-- 3. Webhook entry point closed to the browser:
select has_function_privilege('anon',
  'public.provider_webhook_result(text,text,text,text,text,timestamptz)', 'execute') as anon_webhook;  -- false
-- 4. Health checks:
select count(*) as unguarded from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('voter_registration_start','voter_registration_status','voter_registration_claim',
     'voter_login','voter_logout','voter_begin_ballot','voter_save_vote','voter_submit_ballot',
     'admin_register_voter','admin_list_voters','admin_reissue_voter_code','admin_revoke_voter',
     'admin_list_reviews','admin_resolve_review','admin_set_registration_mode','admin_voter_stats',
     'admin_restore_voter')
   and p.prosrc not like '%voter_accounts_enabled()%';                                               -- 0
select
  coalesce(bool_and(p.prosrc like '%ypm_private.begin_ballot_001(%') filter (where p.proname = 'begin_ballot'), false) as begin_ballot_ok,
  coalesce(bool_and(p.prosrc like '%ypm_private.save_vote_002(%')   filter (where p.proname = 'save_vote'), false)    as save_vote_ok,
  coalesce(bool_and(p.prosrc like '%ypm_private.submit_ballot_000(%') filter (where p.proname = 'submit_ballot'), false) as submit_ballot_ok
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('begin_ballot','save_vote','submit_ballot');
-- true | true | true
```

**4c. Deploy the site** (only with your final authorization; Vercel
deploys `main`):
```powershell
git checkout main
git pull origin main
git merge --no-ff feature/admin-voter-dashboard -m "Release: secure voting, voter accounts (youth-leader path, off until switched on)"
npm test; npm run build
git push origin main
git checkout feature/admin-voter-dashboard
```
In Vercel, wait for the Production deployment to show "Ready", and check
the environment variables point at the Production project.

**4d. Smoke test** (creates no data):
- The voting page loads, and the ballot shows.
- `/admin` and `/inventor`: sign in; the results match 4b.
- Registered voters says "Voter management is switched off".
- `/voter`: signing in with `YPM-AAAA-BBBB-CCCC` says "Voter accounts aren't
  available here".
- Replace any weak admin key now:
  `select ypm_private.set_admin_key('leader', '<new long key>');`

---

## 5. Part 2: after leadership approves the notice

1. Fill the four gaps in `src/voter/consentNotice.js`, then set
   `CONSENT_APPROVED = true`. Commit, `npm test` (the notice test refuses
   approval while gaps remain), then merge and push as in 4c.
2. Production SQL editor, new blank tab:
   `Get-Content -Raw -Encoding UTF8 migrations\007_production_voter_accounts.sql | Set-Clipboard`.
   Click **Run**. Then:
   ```sql
   select d.environment, d.voter_accounts_live,
          (select version from ypm_private.consent_versions where is_current) as notice
     from ypm_private.deployment d;   -- production | false | ypm-register-2026-12-v1
   ```
3. Switch on (a separate go-ahead):
   ```sql
   update ypm_private.deployment set voter_accounts_live = true;
   ```
   Then Dashboard → Registered voters → Registration → **Optional**. Never
   Required while under-18s can't register.
4. The first registration is a real person, done by a leader in person.

---

## 6. Rollback commands

| Problem | Command | Keeps |
|---|---|---|
| Stop new registrations | Dashboard → Registration → **Off** | everything |
| Voter accounts misbehave | `update ypm_private.deployment set voter_accounts_live = false;` | all accounts, requests, consents, ballots, votes |
| New site misbehaves | Vercel → Deployments → previous Production deployment → **Promote to Production** (or `git revert -m 1 <merge commit>` then `git push origin main`) | all data; the old page works with the migrated database |
| Database must go back | the undo files below, in order | ballots and votes, always |

**Database undo**, only if the lighter options aren't enough. Export first:
```sql
-- (only if 003 will be undone) save voter accounts: run, then Download CSV
select id, full_name, phone, status, method, created_by, created_at from public.voters;
```
Then each file in a new tab, in this order (each refuses to run out of
order). Skip 007's undo if 007 was never run.
```powershell
Get-Content -Raw -Encoding UTF8 migrations\007_production_voter_accounts.down.sql | Set-Clipboard
Get-Content -Raw -Encoding UTF8 migrations\006_verification_choice.down.sql | Set-Clipboard
Get-Content -Raw -Encoding UTF8 migrations\005_simulated_provider.down.sql | Set-Clipboard
Get-Content -Raw -Encoding UTF8 migrations\004_voter_safeguards.down.sql | Set-Clipboard
Get-Content -Raw -Encoding UTF8 migrations\003_voter_accounts.down.sql | Set-Clipboard   # deletes voter accounts
Get-Content -Raw -Encoding UTF8 migrations\002_ballot_validation.down.sql | Set-Clipboard
Get-Content -Raw -Encoding UTF8 migrations\001_secure_voting.down.sql | Set-Clipboard     # removes codes, sessions, audit
```
Stop at the level that fixes the problem. If you go below 001, also roll
the site back to the previous deployment: the new page needs 001.

**Restoring the backup** (step 3) is the last resort: it loses every vote
cast since the backup.
