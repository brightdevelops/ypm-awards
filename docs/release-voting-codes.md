# Launch runbook: voting codes (release/voting-codes)

**What launches:** the voting page and admin dashboard with mandatory,
single-use voting codes tied to each voter's phone number, and the
existing rate limits (8 failed attempts per number, 30 wrong codes per IP
and 10 wrong admin keys per IP, each per 15 minutes). Database: migrations
**001, 002 and `ballot-sync.sql` only**.

**Not included:** voter accounts (003–007, `/voter`, Registered voters),
anything biometric, providers and the sandbox. They are absent from the
production build (checked by a test), and their migrations are not run.

**Kept:** every existing ballot and vote, and every table (nothing is
dropped; `admin_keys` stays, unused after 001).

**Prepared and checked (no Production access):**
- all 381 tests pass, and the production build succeeds;
- rehearsal on a synthetic Production copy, installing 001 + 002 +
  ballot-sync and then undoing both:
  - every ballot, vote and result was identical both times;
  - no table was removed;
  - every function the live site and the new site use is present;
- codes tied to a phone are refused for any other number (tested).

---

## 1. Before the day (you)

1. **Leadership approval:** mandatory voting codes, tied to phone numbers.
   If voting is already open, decide whether to switch codes on now or at a
   set time (earlier voters were never asked for one).
2. **Code checks** (your PowerShell window, on this branch):
   ```powershell
   cd C:\Users\Bright\Downloads\ypm-awards
   git checkout release/voting-codes
   git status --short                     # nothing
   npm test                               # all pass
   git hash-object migrations\001_secure_voting.sql migrations\002_ballot_validation.sql migrations\ballot-sync.sql
   # e535e87b3bcbb51b7e9b842e065f428b0f536b62
   # 66a201046d4dc227a32132adc879d2a56c766897
   # 439b7755c0445901d4ace22036036f576f253167
   ```
3. **Production, read-only** (SQL editor). Note the numbers:
   ```sql
   select count(*) as ballots, count(completed_at) as submitted from public.ballots;
   select count(*) as votes from public.votes;
   select label, length(key) >= 16 as long_enough from public.admin_keys;
   select to_regclass('public.admin_sessions') is not null as has_001;   -- expect false
   ```
4. **Backup, verified, with a rehearsal of this exact release and its
   rollback** (read-only on Production; password typed at the prompt):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\dev-backup.ps1 -Production -ProjectRef <production ref> -Label pre-launch
   node scripts\verify-dev-backup.mjs "<folder it printed>" --production --rehearse --through 002 --rollback
   ```
   It must end `BACKUP VERIFIED`. Then encrypt the folder. To re-check the
   encrypted copy later, run `scripts\verify-encrypted-backup.ps1 -Backup <file> -Production`;
   this rehearses the full chain, which is a superset.

## 2. Launch window (about 15 minutes; voting can stay open)

1. **Database** (Production SQL editor; each in a **new blank tab**, each
   must say "Success"):
   ```powershell
   Get-Content -Raw -Encoding UTF8 migrations\001_secure_voting.sql | Set-Clipboard
   Get-Content -Raw -Encoding UTF8 migrations\002_ballot_validation.sql | Set-Clipboard
   Get-Content -Raw -Encoding UTF8 migrations\ballot-sync.sql | Set-Clipboard
   ```
   If one fails, it changed nothing. Stop there and keep the error.
2. **Checks** (read-only):
   ```sql
   -- Same as step 1.3, or higher if people voted meanwhile; never lower:
   select count(*) as ballots, count(completed_at) as submitted from public.ballots;
   select count(*) as votes from public.votes;
   -- 001 and 002 in, no voter accounts:
   select to_regclass('public.admin_sessions') is not null as has_001,
          to_regclass('public.ballot_nominees') is not null as has_002,
          to_regclass('public.voters') is null as no_voter_accounts;      -- true, true, true
   -- Votes for names no longer on the ballot (kept in the tally; just note them):
   select v.category_id, v.nominee_name, count(*) as votes
     from public.votes v
    where not exists (select 1 from public.ballot_nominees n
                       where n.category_id = v.category_id and n.name = v.nominee_name)
    group by 1, 2;
   ```
3. **Site** (needs your approval; Vercel deploys `main`):
   ```powershell
   git checkout main
   git pull origin main
   git merge --no-ff release/voting-codes -m "Release: secure voting with voting codes"
   npm test; npm run build
   git push origin main
   ```
   Wait for Vercel's Production deployment to show "Ready".
4. **Smoke test** (creates no data):
   - the voting page loads, and the ballot shows;
   - `/admin` and `/inventor` sign in, and the results match step 2;
   - the Voting codes tab opens.
5. **Replace the admin keys** (the old ones then stop working, and
   `admin_keys` keeps only dead values):
   ```sql
   select ypm_private.set_admin_key('<label>', '<new key, 16+ characters>');
   ```
   Run it once per label from step 1.3.
6. **Switch codes on** at the approved time: dashboard → Voting codes →
   **Codes required**.

## 3. Running the vote

- A leader confirms the person in person, then Voting codes → Generate →
  **For one phone** → their number → hands over the code.
- Each code works once, and only with that number.
- Lost phone or cleared browser: issue a new code for the same number. The
  ballot and its picks come back.
- Under-18s vote the same way.

## 4. Rollback (lightest first; ballots and votes are always kept)

1. **Codes cause trouble:** switch Codes required off on the dashboard.
2. **Site problem:** Vercel → Deployments → previous Production deployment
   → **Promote to Production**. The old site works with the migrated
   database (checked in the rehearsal).
3. **Database problem:** in new tabs, run `002_ballot_validation.down.sql`,
   then `001_secure_voting.down.sql`, then do step 2 of this section
   (rehearsed: votes, results and tables unchanged).
4. **Restoring the backup** is the last resort: it loses votes cast since
   the backup.
