# YPM Youth Awards — voting app

Vite + React + Supabase. Voters get one link, vote through 25 categories on their
phone, and results stay hidden until you open the admin page.

---

## Deploy — about 15 minutes

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com) (free tier is plenty).
2. Open **SQL Editor → New query**, paste all of `supabase-setup.sql`.
3. **Change `change-this-key`** near the top to your own secret, then **Run**.
4. Go to **Project Settings → API** and copy:
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
```

---

## On the night

- `/admin` → **Close voting**. Takes effect immediately, on the server — anyone
  mid-ballot gets a "voting has closed" screen.
- Refresh the dashboard to read out the winners.
- The tally counts **submitted ballots only**. Started-but-unfinished ballots show
  in "In progress" and are not counted.

---

## Editing the ballot

All categories and nominees live in **`src/data/categories.js`**. Edit, commit,
push — Vercel redeploys in under a minute.

To add photos later: drop images into `public/nominees/` and add the filename to
the nominee:

```js
{ name: 'Peace Williams', photo: 'peace-williams.jpg' }
```

Square images, roughly 400×400. Without a photo the card shows the person's
initials, which looks deliberate — you don't need photos for all of them, but
mixing some with and some without will look uneven.

---

## How one-vote-per-person works

- The voter enters their phone number. It's normalised, so `08031234567`,
  `+2348031234567` and `2348031234567` all count as the same person.
- One ballot per number. A second attempt after submitting gets "you have already
  voted."
- An unfinished ballot can be resumed — same phone, same device or a different
  one, and their picks come back.
- Picks save as they go, so a dropped connection or a closed browser doesn't lose
  anything. Anything that fails to send is retried on submit.

This stops casual double voting. It does not stop someone determined to invent
phone numbers — for a church youth poll that's the right trade. If you ever need
it tighter, the next step is printed one-time codes handed out at church.

## Security notes

- The tables have row-level security on with **no public policies**. The anon key
  in the browser cannot read or write them directly — everything goes through
  database functions. Nobody can pull the results out of the browser before the
  announcement.
- The admin key is checked inside the database, not in the frontend.
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
```
