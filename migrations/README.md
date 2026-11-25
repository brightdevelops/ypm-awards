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
| `dev/simulated_verification.sql` | **Development only.** Simulated verification for testing self-registration. Refuses to install or run outside a project marked as development. | Dropped by 003's undo |

Undo in reverse order: 003's undo, then 002's, then 001's.

**After 003, re-run 003 whenever 001 or 002 is re-run.** 003 moves the
original `begin_ballot`, `save_vote` and `submit_ballot` into `ypm_private`
and puts protective wrappers in their place. Re-running 001 or 002 replaces
the wrappers with the unprotected versions until 003 is run again.

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
4. Try the undo files (002's, then 001's), then apply both again, to check
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
