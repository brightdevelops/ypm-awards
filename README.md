# YPM Youth Awards — voting app

Vite + React + Supabase. Voters get one link, vote through 25 categories on their
phone, and results stay hidden until you open the admin page.

---

## Deploy — about 15 minutes

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is plenty).
2. Open **SQL Editor → New query**, paste all of `supabase-setup.sql`.
3. **Change both keys** in section 2 to your own secrets (16+ random
   characters each), then **Run**.
4. Then run each file in `migrations/` in order, one query at a time:
   `001_secure_voting.sql`, `002_ballot_validation.sql`, `ballot-sync.sql`.
5. Go to **Project Settings → API** and copy:
   - Project URL
   - `anon` `public` key

### 2. GitHub

```bash
cd ypm-awards
git init
git add .
git commit -m "YPM Awards voting app"
git remote add origin https://github.com/YOUR-USERNAME/ypm-awards.git
git push -u origin main
```

### 3. Vercel

1. [vercel.com/new](https://vercel.com/new) → import the repo.
2. Framework preset: **Vite** (it should detect this).
3. Add two environment variables:
   - `VITE_SUPABASE_URL` — your project URL
   - `VITE_SUPABASE_ANON_KEY` — your anon public key
4. **Deploy.**

### 4. Test before you share it

- Open the live URL, vote a full ballot with your own number.
- Open `/admin`, enter your key, check your vote appears.
- In Supabase SQL Editor, clear your test:
  `delete from public.ballots where voter_phone = '08012345678';`

Then drop the link in the youth WhatsApp group.

---

## Running it locally

```bash
npm install
cp .env.example .env.local   # fill in the two values
npm run dev
npm test                     # database tests; no Supabase project needed
```

`npm test` runs every database function against a real Postgres (PGlite, in
process), set up exactly as production: `supabase-setup.sql`, some ballots,
then the migrations.

---

## On the night

- `/admin` → **Close voting**. Takes effect immediately, on the server — anyone
  mid-ballot gets a "voting has closed" screen.
- Refresh the dashboard to read out the winners.
- The tally counts **submitted ballots only**. Started-but-unfinished ballots show
  in "In progress" and are not counted.

---

## Editing the ballot

All categories and nominees live in **`src/data/categories.js`**. The database
keeps its own copy and refuses votes for anyone not on it, so every edit takes
two steps:

1. Edit `categories.js`, then run `npm run ballot:sql`. This rewrites
   `migrations/ballot-sync.sql`, and `npm test` fails until you do.
2. Run `migrations/ballot-sync.sql` in the Supabase SQL editor **first**, then
   commit and push. If the page goes live before the database knows a new
   nominee, votes for them are refused and the voter is told their vote wasn't
   saved.

Removed nominees are switched off, not deleted, so votes already cast for them
stay in the tally. Renaming someone counts as removing the old name and adding
the new one.

### Nominee photos

Each category shows its nominees as photo cards. Put one photo per person in
**`src/assets/nominees/`**, named after them: Peace Williams is
`peace-williams.jpg`. It appears in every category they're in, with no code
or SQL change. Head-and-shoulders, about 600×750 pixels, under 300 KB each.
Anyone without a photo shows their initials, which works, but a mix of photos
and initials looks uneven, so aim to have them all.

`npm test` catches misnamed and oversized photos and lists who's still
missing one. Details: [src/assets/nominees/README.md](src/assets/nominees/README.md).

---

## How one-vote-per-person works

- The voter enters their phone number. It's normalised, so `08031234567`,
  `+2348031234567` and `2348031234567` all count as the same person.
- One ballot per number. A second attempt after submitting gets "you have already
  voted."
- An unfinished ballot can be resumed on the device that started it. On a
  different phone or browser, the voter needs a voting code: either the one
  they started with, or one a leader issues for their number. Typing a phone
  number alone never reopens someone's ballot or shows their picks.
- Picks save as they go, so a dropped connection or a closed browser doesn't lose
  anything. Anything that fails to send is retried on submit, and the ballot
  isn't submitted until every pick has been saved.
- Only real nominees count: the database checks each vote against the ballot
  (the right nominee, in the right category) and refuses anything else.

Phone numbers alone stop casual double voting, not someone determined to use
several numbers. For that, switch on **voting codes**.

### Voting codes

Single-use codes like `K7MQP-3XZRA`, issued by an admin and handed out in
person. The code itself is never stored, only a hash, so codes can be shown
once, when they're issued.

- **Optional by default.** Voters can enter one, but don't have to, until you
  switch the requirement on. Ballots started before that keep working.
- **Required:** `update public.settings set require_voting_code = true where id = 1;`
  (the dashboard shows which mode is on).
- **Issue from the SQL editor** (the dashboard screen comes in a later phase):
  `select ypm_private.issue_codes('leader', 20, null, 'Sunday service', null);`
  A code can be tied to one phone number: `issue_codes('leader', 1, '0803…', 'lost phone', null)`.
- One code opens one ballot. Someone who has already voted doesn't use up a code.
- Lost phone or cleared browser: issue a code **for that number**. It reopens
  their unfinished ballot.
- Revoke with `admin_revoke_code`, or `update public.voting_codes set revoked_at = now() where id = '…'`.

### Rate limits

Counted in the database, per 15 minutes. Only failures count:

| What | Limit |
|---|---|
| Wrong code / blocked resume, per phone number (pauses that number) | 8 |
| Wrong code only, per IP address (pauses further code attempts from it) | 30 |
| Wrong admin key, per IP address | 10 |
| Wrong admin key, everyone combined | 60 |

IP addresses come from request headers, which a client can partly forge, so the
per-phone and combined limits are the ones to rely on. Many voters can share one
address (church Wi-Fi, mobile networks), so the voter IP limit counts only wrong
codes and never stops anyone starting or resuming a ballot without a code.

## Security notes

- The tables have row-level security on with **no public policies**. The anon key
  in the browser cannot read or write them directly — everything goes through
  database functions. Nobody can pull the results out of the browser before the
  announcement.
- Admin keys are stored hashed and checked inside the database. Signing in
  returns a 12-hour session; the browser keeps only that, never the key.
  Change a key with `select ypm_private.set_admin_key('leader', '…');` and
  revoke with `select ypm_private.revoke_admin('leader');` (both sign that
  person out at once). Admin actions are logged in `public.admin_audit`.
- The admin page is at `/admin` — not linked from anywhere. Don't share that URL.
- Voters' phone numbers are visible only on the admin page.

---

## Files

```
src/data/categories.js   the ballot — edit here
src/pages/Vote.jsx       voter flow
src/pages/Admin.jsx      results dashboard
src/styles.css           all styling
supabase-setup.sql       run once on a new Supabase project
supabase-upgrade.sql     run once to upgrade a database set up before /inventor
migrations/              changes after setup; run in order (see migrations/README.md)
scripts/ballot-sql.mjs   writes migrations/ballot-sync.sql from categories.js
tests/db/                database tests (npm test)
```
