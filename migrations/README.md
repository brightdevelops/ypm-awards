# Migrations

Run these in the Supabase SQL editor, in order, after `supabase-setup.sql`
(and `supabase-upgrade.sql` if your project predates `/inventor`). Each file
is one transaction: it applies fully or not at all.

| File | What it does | Undo |
|---|---|---|
| `001_secure_voting.sql` | Closes the ballot-resume hole; voting codes; admin sessions; rate limits; audit log | `001_secure_voting.down.sql` |
| `002_ballot_validation.sql` | Loads the ballot into the database; `save_vote` only accepts real nominees in their own category | `002_ballot_validation.down.sql` |
| `ballot-sync.sql` | **Generated** (`npm run ballot:sql`). Brings the database ballot in line with `categories.js`. Re-run after every ballot edit. | — |
| `003_voter_accounts.sql` | Registered voter accounts, voter login codes (keyed hashes, key in Supabase Vault), in-person registration, one ballot per voter. **Registration is off by default.** | `003_voter_accounts.down.sql` |
| `004_voter_safeguards.sql` | Voter accounts **development only, enforced by the database**; restoring revoked voters with a new code (old codes retired for good); linking a ballot when approving a review; consent records with version tracking; `erase_voter` for deletion. **Installed on Development** (seen through the public API on 26 Nov 2026: 004-only functions and its consent check answer); not on Production. | `004_voter_safeguards.down.sql` (refuses while 005 is installed) |
| `005_simulated_provider.sql` | **Development only, not applied anywhere yet.** Simulated verification provider with asynchronous, signed results (HMAC, key in Vault): replay, duplicate, out-of-order and conflict handling; review reasons for admins; 30-day retention of verification records (never ballots, votes, accounts or consent). No biometric data. Needs 004. | `005_simulated_provider.down.sql` |
| `dev/simulated_verification.sql` | **Development only.** Simulated verification for testing self-registration. Refuses to install or run outside a project marked as development. | Dropped by 003's undo |
| `dev/revoke-synthetic-test-credentials.md` | **Development only, not run yet.** Step-by-step SQL that revokes the synthetic test voters (`08155500xxx`), ends their sign-ins and closes their open registrations. Deletes nothing; every write checks the project is marked as development. | Not needed (with 004, a revoked account can be restored with a new code) |

Undo in reverse order: 005's undo, then 004's, then 003's, then 002's, then
001's. 004's undo refuses to run while 005 is installed, and 003's while 004
is installed.

**Older files refuse to run over newer ones.** 003 moves the original
`begin_ballot`, `save_vote` and `submit_ballot` into `ypm_private` and puts
protective wrappers in their place, so 001, 002 and their undo files stop
with "Migration 003 is installed" instead of replacing the wrappers. 004
wraps 003's voter functions, so 003 stops with "Migration 004 is installed".
Nothing is changed when a file refuses. To re-run an older file, undo the
newer ones first (004, then 003), then apply them again in order. Each file
can still be re-run while it is the newest one installed.

**Always run on the development project first**, and run `npm test` before
either. Nothing in this repo runs migrations for you.

---

## 001 — compatibility notes

Voting is already live, so 001 is built to go in mid-election.

**What it does not change**

- No existing ballot or vote is modified or deleted. `ballots` gains one empty,
  nullable column (`voting_code_id`).
- `save_vote` and `submit_ballot` are untouched. Anyone in the middle of voting
  keeps going without noticing.
- Voting codes stay **optional** (`require_voting_code = false`) until you turn
  them on. New voters can start without one, as today.
- The old functions the live site calls (`start_ballot`, `get_tally`,
  `set_voting_open`) keep their names, arguments and response shapes.

**What it deliberately changes**

1. **Resuming on a different device needs a code.** Today, typing a phone number
   that has an unfinished ballot returns that ballot's ID and picks to whoever
   typed it. After 001, it returns `resume_required` with nothing else.
   - Same device: unaffected. The page resumes from the ballot ID it saved.
   - New device or cleared browser: a leader issues a code tied to that number,
     and the voter enters it. The ballot and picks come back.
   - On the **old** page (before the frontend update is deployed), this case
     shows "Could not start. Check your connection and try again." The new page
     explains it properly. That's why the frontend goes out right after the
     migration (below).
2. **Admin keys are checked hashed and rate limited.** The same keys keep working.
   After 10 wrong keys from one IP address, or 60 overall, sign-in pauses for
   15 minutes. Admins already signed in on the new page are unaffected.
3. **`admin_keys` is no longer read.** Keys are copied into `admin_users`
   (hashed). To change a key after 001, use `ypm_private.set_admin_key`.
   Editing `admin_keys` directly does nothing. The table is left in place
   so you can roll back, and should be dropped afterwards.

**Edge cases worth knowing**

- An unfinished ballot started before 001 can't be reopened with an ordinary
  (unbound) code. That would let anyone holding a code take over someone else's
  ballot. It needs a code issued **for that phone number**.
- If two devices start the same new number at the same instant, the second gets
  "please try again", and the retry treats it as the existing ballot.
  Previously both were silently given the same ballot.

---

## 002 — compatibility notes

- **No vote is changed or re-checked.** The new foreign key is added
  `NOT VALID`, so it only applies to votes cast or changed from now on.
  Votes already stored for names no longer on the ballot stay in the tally.
  After running 002, this lists them (read-only):

  ```sql
  select v.category_id, v.nominee_name, count(*) as votes,
         count(*) filter (where b.completed_at is not null) as submitted
    from public.votes v join public.ballots b on b.id = v.ballot_id
   where not exists (select 1 from public.ballot_nominees n
                      where n.category_id = v.category_id and n.name = v.nominee_name)
   group by 1, 2;
  ```

  Whether those count is for the leaders to decide.
- **Refusals look like the old errors.** `save_vote` adds one refusal,
  `{status:'error', reason:'invalid_choice'}`. Older pages already treat
  `error` as "not saved yet", so they never mistake a refused vote for a saved
  one.
- **The live site can't send an invalid vote**, because it only offers names
  from `categories.js`, and 002 seeds exactly that list (18 categories,
  52 nominees as of 22 Nov). The risk is a mismatch later: always run
  `ballot-sync.sql` before deploying a ballot edit.
- The updated voting page won't submit while any pick is unsaved. Before, it
  submitted anyway and the unsaved pick was lost.

---

## Applying 001 and 002

### 1. Check production first (read-only)

Run in the production SQL editor and note the numbers. These queries change
nothing:

```sql
select count(*) as ballots, count(completed_at) as submitted,
       count(*) - count(completed_at) as unfinished
  from public.ballots;
select label, length(key) >= 16 as long_enough from public.admin_keys;
```

Unfinished ballots are the people affected by change 1 if they switch devices.
If any key isn't long enough, plan to replace it with `set_admin_key` after
the migration.

### 2. Development project

1. Create a separate Supabase project (free tier).
2. Run `supabase-setup.sql` (set both keys first), then `001_secure_voting.sql`,
   `002_ballot_validation.sql` and `ballot-sync.sql`.
3. Point a local `.env.local` at it and run `npm run dev`. Then try:
   - start a ballot, vote a few categories, reload: it resumes
   - open the same number in a private window: "unfinished ballot from another phone"
   - `select ypm_private.issue_codes('leader', 1, '<that number>', 'test', null);`,
     enter the code in the private window: it resumes with the picks
   - `/admin` and `/inventor`: sign in, refresh, sign out, close/reopen voting
   - turn codes on, then check a new number is asked for a code
4. **Only on a project without 003** (the files refuse to run over 003).
   Try the undo files (002's, then 001's), then apply both again, to check
   rolling back works.

### 3. Production — only with your explicit go-ahead

1. Choose a quiet moment.
2. Run `001_secure_voting.sql`, then `002_ballot_validation.sql`, then
   `ballot-sync.sql`. Check each ends in `COMMIT`. Then run the orphaned-votes
   query above and note the result.
3. Merge and deploy the frontend straight away (Vercel deploys from `main`).
4. Sign in at `/admin` and `/inventor`, and check the counts match step 1.
5. Replace weak keys: `select ypm_private.set_admin_key('leader', '…');`
6. Later, once happy: `drop table public.admin_keys;`

Voting codes stay optional until you run
`update public.settings set require_voting_code = true where id = 1;`.
Switching them on mid-election means earlier voters were never asked for one.
That's a fairness decision for the leaders, not a technical one.

---

## 003 — compatibility notes

- **Nothing changes until someone acts.** With `registration_mode = 'off'`
  and no voters registered, every existing function behaves exactly as
  before (the full test suite runs with 003 applied).
- **Needs Supabase Vault** (`supabase_vault` extension). 003 stops with a
  clear message if Vault isn't there. It creates a random key named
  `ypm_voter_code_pepper` once; nobody needs to see it. Replacing it makes
  every voter code stop working.
- **Registered numbers can't vote anonymously.** Once a number belongs to a
  voter, `begin_ballot` / `start_ballot` answer `registered_voter` (old
  pages show "Could not start"), and `save_vote` / `submit_ballot` refuse
  that voter's ballot.
- **`registration_mode = 'required'`** stops new anonymous ballots
  (`registration_required`), including with a voting code. Unfinished
  anonymous ballots can still be finished on the device that started them.
- **Existing anonymous ballots are never linked by phone number.** An admin
  attaches one in person with `admin_register_voter(..., p_link_existing_ballot => true)`.
- **The simulator is development only.** Mark the dev project first:
  `update ypm_private.deployment set environment = 'development';`
  Production stays `production` (the default), where the simulator can't be
  switched on, installed or run.

---

## 004 — voter account safeguards

### What it does

- **Development only, enforced by the database.** Every voter-account
  function (17 of them: registration, claim, sign-in, ballot, and the admin
  voter functions) answers `{"status": "disabled"}` unless
  `ypm_private.deployment.environment = 'development'`. A frontend setting
  can't change that. Online registration can't be switched on outside
  development, and a project can't be marked production again while
  registration or simulated verification is on. 004 refuses to install on a
  production-marked project that has either switched on.
- **The originals can't be called directly.** The 003 functions move into
  `ypm_private` (as `*_003`, unchanged, kept for the undo). Nothing in
  `ypm_private` is executable by `anon` or `authenticated`, and those roles
  have no access to the schema (tested function by function).
- **Restore** (`admin_restore_voter`): only for revoked accounts, needs a
  reason, always issues a **new** code (shown once). Every replaced code's
  keyed hash goes into `ypm_private.retired_voter_codes`, and a retired code
  can never be issued or used again.
- **Ballot linking on approval** (`admin_resolve_review(..., p_link_existing_ballot)`):
  without it the reply is `phone_has_ballot` with the ballot's state and how
  many categories are answered; with it the ballot is attached under the
  phone lock, votes untouched. One account per number and one ballot per
  voter are enforced by locks and unique indexes.
- **Consent records** (`public.voter_consents`, below). In-person
  registration (`admin_register_voter`) now needs a current consent version
  and `p_adult_confirmed => true`. **Under-18 registration is deferred**
  until the youth leaders approve a non-biometric policy.
- **Anonymous voting is untouched**: `begin_ballot`, `save_vote`,
  `submit_ballot`, `voting_status`, voting codes and results behave exactly
  as before (tested on a production-marked database, and installing 004
  changes no ballot, vote or setting).

### Consent records: what, who can see them, how long they're kept

**Stored per account** (`public.voter_consents`): the notice version
agreed to, how (`online` / `in_person`), whether adulthood was confirmed,
`biometric = false` (enforced), when they agreed, who recorded it (`self` or
the admin's key label), and whether it was recorded when the account was made
or carried over by 004. **No names, numbers or free text**: those stay on the
voter row and are not copied.

**Notice versions** live in `ypm_private.consent_versions`. Draft versions
(the development notice `draft-2026-11-dev`) are accepted only on a
development project. A real notice must be added as a non-draft version, with
the leaders' approval, before any real registration.

**Nothing is invented.** Accounts made before 004 get a record only if a
consent was actually captured at the time (online registrations). In-person
accounts from 003 stay without one; `admin_voter_stats` reports how many
accounts have no consent record.

**Access.** Row level security is on and the API roles have no privileges:
the browser can't read, add, change or delete consent records. Only the
database owner (SQL editor) can read them. Admins see counts only.

**Append-only.** Records can't be updated. They can't be deleted or
truncated either, except inside `ypm_private.erase_voter`.

**Retention and deletion (proposed; needs the youth leaders' approval).**

| What | Kept until | Then |
|---|---|---|
| Voter account, its consent records, sessions, registrations | The election's results are final and any challenge period is over. **Proposed: 90 days after results are announced.** | Deleted with `ypm_private.erase_voter` for every account |
| A person's account, on their request | Their request (after checking who they are, in person) | Deleted with `ypm_private.erase_voter` |
| Ballots and votes | Not affected: an erased voter's ballot stays as an ordinary anonymous ballot | Per the election's own rules |
| Retired code hashes | Until all voter accounts are erased | Delete the rows; they contain no personal data |
| Audit log entries | As for the rest of the audit log | `voter_erased` entries hold no name or number |

```sql
-- Database owner only, SQL editor. One account:
select ypm_private.erase_voter('<voter id>', 'reason, e.g. deletion request');
```

### Undoing 004

The full step-by-step procedure, with backup and verification, is in
`dev/undo-004-development.md`. In short:

1. **Export the consent records first** as the record of what existed. The
   undo deletes them, but the consent itself stays on each voter row
   (`consent_version`, `consent_at`, `adult_confirmed`, from 003), which the
   records were copied from; only `recorded_at` and `recorded_from` are
   lost. No names or numbers are needed: `voter_id` links each record to
   the voter row, which the undo keeps.
   ```sql
   select * from public.voter_consents order by recorded_at;
   ```
2. Run `004_voter_safeguards.down.sql` (one transaction).
3. Check the 003 functions are back:
   ```sql
   select to_regprocedure('public.admin_resolve_review(text,uuid,text)') is not null as back,
          to_regprocedure('public.admin_restore_voter(text,uuid,text)') is null as gone;
   ```
   Expect `true, true`.

**Kept:** accounts (restored ones stay active with their new code), codes,
registrations, sessions, ballots and votes. **Lost:** consent records and
versions, the retired-code list, restore details on voter rows, and the
development-only switch (voter functions work in any environment again, as
in 003). The tests check that 004 followed by its undo leaves every function
body, grant, trigger, column and row exactly as 003 had them.

### Tests

- `npm test` (sequential, PGlite): `tests/db/voter-safeguards.test.mjs`,
  plus the simulated-browser tests in `tests/ui/dom/`.
- `npm run test:concurrency` (**genuine** concurrency): starts a throwaway
  PostgreSQL server from the installed programs (own temp folder, random
  port, 127.0.0.1 only, deleted afterwards; never another server), holds N
  requests at a barrier, checks they are all queued at once, releases them
  together, and checks there is still exactly one account / ballot / valid
  code. Skips if PostgreSQL's programs aren't installed (`YPM_PG_BIN`).
