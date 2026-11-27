# Production release plan: voter accounts with youth-leader verification

**Status (27 Nov 2026): prepared and tested; nothing done in Production.**
Waiting for your approval of this plan. No push, merge, deploy or
Production database change has happened.

## What is released

- **Voter accounts, youth-leader path only.** People ask on the new voter
  page (`/voter`) to be confirmed by a youth leader, or a leader registers
  them in person from the dashboard. They sign in with a voter code and
  vote. **No face scan, no camera, no biometric data**, anywhere.
- **Anonymous voting stays exactly as it is** (name and phone number, plus
  optional voting codes). Every existing ballot and vote is kept unchanged.
- **Off by default.** After installing, voter accounts answer "disabled"
  until the database owner switches them on (migration 007's switch), and
  registration stays off until an admin chooses Optional on the dashboard.
- **Not released:** face checks, the simulated provider, the sandbox and
  its Edge Function, the development prototype and tester panel. They are
  not in the production build (checked by a test), and the database refuses
  them outside Development: `verification_provider` can't be set to
  `'simulated'`, the simulator can't be installed or run, and every
  provider function answers "disabled".

## What Production has today, and what changes

Production runs `main` (no migrations), so the release installs the whole
chain:

| Step | File | Git blob ID | Effect in Production |
|---|---|---|---|
| 1 | `001_secure_voting.sql` | `e535e87b3bcbb51b7e9b842e065f428b0f536b62` | Admin sessions, hashed keys, voting codes (optional), closes the resume hole |
| 2 | `002_ballot_validation.sql` | `66a201046d4dc227a32132adc879d2a56c766897` | Ballot in the database; only real nominees accepted |
| 3 | `ballot-sync.sql` | `439b7755c0445901d4ace22036036f576f253167` | Ballot matches `categories.js` |
| 4 | `003_voter_accounts.sql` | `f9380ff3e1f3eef72cd3e3b5953da759b6d608d4` | Voter tables (registration off) |
| 5 | `004_voter_safeguards.sql` | `edc49f76473777c235ab7f0ca0a1dea19911f086` | Voter accounts locked to development; consent records |
| 6 | `005_simulated_provider.sql` | `3d3cad22c4850cdf24bab78c86ca934aa642e7c8` | Installed but inert (disabled; no key in Production) |
| 7 | `006_verification_choice.sql` | `3107683616dd8829e90466fea59815e1e59dd41a` | Youth-leader requests (still disabled) |
| 8 | `007_production_voter_accounts.sql` | `a6849f5cecee1e245c6c818729ba46a87ead4bb2` | Owner-only switch (off); publishes notice `ypm-register-2026-12-v1` |

005 and 006 are installed so that Production and Development run the same
schema; their development parts can't run there.

**Tested:** the full chain on a production-marked database with existing
ballots and votes (`tests/db/production-release.test.mjs`), the voter page
and dashboard against it (`tests/ui/dom/voter-app.test.mjs`), and a
rehearsal on a restored synthetic Production copy
(`scripts/verify-dev-backup.mjs --production --rehearse`): every ballot and
vote identical by fingerprint, results unchanged, voter accounts off,
anonymous voting working.

## Release procedure

Each step: Production only after your go-ahead; stop on anything unexpected
and keep the exact output.

### A. Before the day (no Production changes)

0. **Apply 007 on Development first** (safe there: the draft notice stays
   current and both notices are accepted). Run
   `007_production_voter_accounts.sql` in a new tab; then
   `select version, is_current from ypm_private.consent_versions;` shows
   the draft current and `ypm-register-2026-12-v1` not current. Your manual
   test groups still pass, and `/voter` (under `npm run dev`) signs voters in.
1. **Approve the voter notice** in `src/voter/consentNotice.js`: fill in the
   retention period and contact details, then set `CONSENT_APPROVED = true`
   (one commit). Until then the voter page takes no requests. Version
   `ypm-register-2026-12-v1` isn't published anywhere yet, so the wording
   can still change under that version until step C3.
2. **Code ready:** on the release branch, `npm test` (all pass),
   `npm run build`, `npm run ballot:sql` leaves `migrations/ballot-sync.sql`
   unchanged, `git status` clean.
3. **Production read-only checks** (SQL editor, Production project):
   ```sql
   select count(*) as ballots, count(completed_at) as submitted,
          count(*) - count(completed_at) as unfinished from public.ballots;
   select count(*) as votes from public.votes;
   select label, length(key) >= 16 as long_enough from public.admin_keys;
   select exists (select 1 from pg_extension where extname = 'supabase_vault') as vault;
   select to_regclass('public.admin_sessions') is not null as has_001;
   ```
   Expect `vault = true`, `has_001 = false`. Note the counts. Replace any
   short key after the release (`ypm_private.set_admin_key`).
4. **Backup and rehearsal** (your PowerShell window; read-only):
   ```powershell
   cd C:\Users\Bright\Downloads\ypm-awards
   powershell -ExecutionPolicy Bypass -File scripts\dev-backup.ps1 -Production -ProjectRef <production ref> -Label pre-release
   node scripts\verify-dev-backup.mjs "<folder it printed>" --production --rehearse
   ```
   Must end `BACKUP VERIFIED`: the whole chain runs on a copy of
   Production's real data and changes no ballot or vote. Then encrypt the
   folder (verify an encrypted copy later with
   `scripts\verify-encrypted-backup.ps1 -Backup <file> -Production`).
5. **Files unchanged:** `git status --short migrations` prints nothing and
   `git hash-object` of each file in the table above matches.

### B. Release window (quiet moment; about 20 minutes)

1. Tell the leaders. Voting can stay open: 001 is built to go in
   mid-election. The only visible effect before the new page is live: a
   voter resuming on a *different* device sees "Could not start" for a few
   minutes.
2. In the Production SQL editor, run steps 1–8 from the table, **each in a
   new blank tab**, copied exactly
   (`Get-Content -Raw -Encoding UTF8 migrations\<file> | Set-Clipboard`).
   Each must say "Success". If one fails, nothing from that file is applied:
   stop and keep the error.
3. **Checks (read-only):**
   ```sql
   -- Same counts as A3:
   select count(*) as ballots, count(completed_at) as submitted from public.ballots;
   select count(*) as votes from public.votes;
   -- Still Production, everything off, published notice current:
   select d.environment, d.voter_accounts_live, s.verification_provider, s.registration_mode,
          (select version from ypm_private.consent_versions where is_current) as notice,
          exists (select 1 from vault.secrets where name = 'ypm_sim_provider_key') as sim_key
     from ypm_private.deployment d, public.settings s where s.id = 1;
   -- The webhook entry point is closed to the browser:
   select has_function_privilege('anon', 'public.provider_webhook_result(text,text,text,text,text,timestamptz)', 'execute') as anon_webhook;
   ```
   Expect the A3 counts, then `production, false, none, off,
   ypm-register-2026-12-v1, false`, then `false`. Then the two health
   checks in `migrations/dev/undo-004-development.md` ("Re-running 003…"):
   `0`, then three `true`s.
4. **Deploy the frontend** (needs your approval to merge): merge the release
   branch into `main`; Vercel deploys it. Check the Vercel environment
   variables point at Production.
5. **Smoke test, without creating any data:**
   - The voting page loads, and the ballot shows.
   - `/admin` and `/inventor` sign in, and the results match A3.
   - Registered voters says "Voter management is switched off".
   - `/voter` loads, and signing in with a made-up code says "Voter accounts
     aren't available here".

### C. Switching voter accounts on (a separate decision, any time later)

1. `update ypm_private.deployment set voter_accounts_live = true;` (SQL
   editor). It refuses unless face checks are off and the published notice
   is current.
2. Dashboard → Registered voters → Registration: **Optional**. (Required
   stops new anonymous ballots: a fairness decision for the leaders.)
3. The first registration is a real person, registered in person by a
   leader ("Register in person") or through `/voter`. Don't create synthetic
   accounts in Production. If a test account is needed, agree it first and
   remove it afterwards with `select ypm_private.erase_voter('<id>', 'release test');`.

## Rollback

From the lightest to the heaviest. Each one keeps every ballot and vote.

1. **Stop registration:** Registration → Off on the dashboard. Existing
   accounts keep working.
2. **Switch voter accounts off:**
   `update ypm_private.deployment set voter_accounts_live = false;`. Every
   voter-account function answers "disabled"; accounts, requests and consent
   records are kept, and switching it on again restores them.
3. **Frontend:** in Vercel, promote the previous Production deployment. The
   old page keeps working with the migrated database (001 keeps
   `start_ballot`, `get_tally` and `set_voting_open`), but shows "Could not
   start" where the new page explains a refusal.
4. **Database undo**, only if 1–3 aren't enough, in this order:
   `007` → `006` → `005` → `004` → `003` → `002` → `001` (`.down.sql`
   files). Each one refuses to run out of order. Undoing 003 deletes voter
   accounts, so export them first; undoing 001 removes voting codes,
   sessions and the audit log. Ballots and votes are never touched by any
   undo.
5. **Restoring the A4 backup is a last resort:** it loses every vote cast
   since the backup.

Re-running a migration in Production: 004 refuses while registration is
open (set Off first). After re-running 004, run 007 again, because 004
puts back its development-only switch, which turns voter accounts off
(safe).

## Release checklist

**Approvals (you)**
- [ ] This plan.
- [ ] Voter notice wording: retention period and contact details filled
      in, `CONSENT_APPROVED = true` committed (project owner and youth
      leadership).
- [ ] Merge to `main` and the Vercel deploy.
- [ ] The release window (who, when, leaders told).
- [ ] Later and separately: switching voter accounts on (C1) and
      registration Optional (C2).

**Done and verified (me, no Production access)**
- [x] Migration 007 with undo: owner-only switch, published notice, face
      checks still refused.
- [x] Production-compatible voter page (`/voter`) and Registered voters tab.
      No development wording, no synthetic numbers, no tester or simulator
      code in the build.
- [x] Full suite: 371 of 371 pass; concurrency on real PostgreSQL: 9 of 9.
      Production build succeeds.
- [x] Rehearsal of the whole chain on a synthetic Production copy:
      `BACKUP VERIFIED`.
- [x] Development: 005 and 006 installed; 34 public checks and your seven
      manual test groups passed.

**Release day (you, with this procedure)**
- [ ] A2 code checks · A3 read-only checks · A4 backup with `BACKUP VERIFIED` · A5 blob IDs.
- [ ] B2 migrations 1–8 · B3 checks · B4 deploy · B5 smoke test.

**Known limits (accepted for this release)**
- Under-18 registration isn't available.
- Voter codes are recovered in person only.
- The Edge Function and sandbox stay development-only and undeployed.
- Accounts are erased by the database owner (`erase_voter`); there's no
  dashboard button.
- Requests waiting more than 14 days close by themselves.
