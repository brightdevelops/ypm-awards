# Undo migration 004 (Development)

**Not run. Use only if 004 causes a problem that can't be fixed forward, and
only with approval.** Written for the Development project; the same steps
apply to any project 004 is later installed on, with that project's own
backup and approval.

How to run, as for every database step:

- Development SQL editor only. The address bar must show `vliytvqhjvuhulpvmuat`.
- New blank tab for each step, nothing highlighted, never a saved snippet.
- One step at a time. Check each result before the next.
- Never paste admin keys or passwords into chat.

---

## Before you undo: lighter options

Undoing 004 removes protections, so first check whether one of these is enough:

| Problem | Lighter fix |
|---|---|
| Voter accounts misbehaving in testing | Admin dashboard → Voters → registration mode **Off**. Anonymous voting is unaffected. |
| A voter account needs to stop working | Revoke it (it can be restored later with a new code). |
| The dashboard shows an error | The anonymous voting page doesn't use any 004 function; fix the dashboard, keep 004. |

Anonymous voting (`begin_ballot`, `save_vote`, `submit_ballot`,
`voting_status`) is not changed by 004, so it is never a reason to undo it.

## What the undo keeps and loses

**Kept:** voter accounts (restored ones stay active with their new code),
codes, registrations, sessions, ballots, votes, settings, the audit log.

**Lost, and not recoverable except from a backup:**

| Lost | Effect |
|---|---|
| `public.voter_consents` (all consent records) | The consent itself survives: every record is copied from the voter row's `consent_version`, `consent_at`, `adult_confirmed`, `method` and `created_by` (003 columns, kept by the undo), for online and in-person accounts alike. What is lost is the record-keeping around it: each record's `id`, `recorded_at` and `recorded_from`. Reinstalling 004 rebuilds the records from the voter rows (`recorded_from` = `migration_004_backfill`). Export them first anyway (step U2) as the record of what existed. |
| `ypm_private.consent_versions` | The draft version is recreated if 004 is installed again. |
| `ypm_private.retired_voter_codes` | Codes replaced by reissue or restore no longer match any account, so they still don't work. Only the guarantee that a new random code can never equal an old one is lost (the chance is negligible: about 60 random bits). |
| `restored_at`, `restored_by`, `restore_reason` on voters | The audit log keeps every restore (`voter_restored`: who, when, the reason and the earlier revocation). |
| The development-only switch and its guards | Voter functions work in any environment again, as in 003. **Set registration mode Off** afterwards unless 004 is being reinstalled straight away. |

The undo is one transaction: it applies completely or not at all.

---

## U1. Before: counts (read-only)

```sql
select
  (select environment from ypm_private.deployment
    where id = 1) as env,
  (select count(*) from public.ballots) as ballots,
  (select count(*) from public.votes) as votes,
  (select count(*) from public.voters) as voters,
  (select count(*) from public.voter_registrations) as regs,
  (select count(*) from public.voter_sessions) as sessions,
  (select count(*) from public.voter_consents) as consents,
  (select count(*) from ypm_private.retired_voter_codes) as retired,
  (select count(*) from public.voters
    where restored_at is not null) as restored,
  (select count(*) from public.admin_audit) as audit;
```

Expected: `env` = `development`. Note every count.

## U2. Export the consent records (read-only)

No names or phone numbers: `voter_id` links each record to the voter row,
which the undo keeps.

```sql
select * from public.voter_consents
 order by recorded_at;
```

Download the result as CSV (the editor's export button). The row count must
equal `consents` from U1. Keep the file with the database backups,
encrypted the same way (7-Zip AES-256, encrypt file names), and delete the
unencrypted copy.

## U3. Backup

Take a fresh `pg_dump` of `public` and `ypm_private` exactly as before
installing 004 (your own PowerShell window, password typed only at the
prompt), check it offline, encrypt it, and record its SHA-256.

## U4. Run the undo

In your own PowerShell window, copy the committed file and check it:

```powershell
cd C:\Users\Bright\Downloads\ypm-awards
git status --short migrations
(Get-FileHash migrations\004_voter_safeguards.down.sql -Algorithm SHA256).Hash
Get-Content -Raw -Encoding UTF8 migrations\004_voter_safeguards.down.sql | Set-Clipboard
```

- `git status` prints nothing.
- Hash: `FCDEB23288D504AC480F5D5405A43AB242E5FACC9791FEF2ED4874462B08139F`
  (the version committed in `17fd447`). Anything else: stop.

Paste into a new blank tab on Development, check it starts with
`-- YPM Youth Awards — undo Migration 004.` and ends with `commit;`, nothing
highlighted, **Run**. Supabase will warn about destructive operations
(it drops tables and functions); confirm only on Development.

Expected: "Success. No rows returned." On any error: nothing was changed
(one transaction). Don't run it again; report the error.

## U5. Check the 003 functions are back (read-only)

```sql
select
  to_regprocedure('public.admin_resolve_review(text,uuid,text)')
    is not null as back,
  to_regprocedure('public.admin_restore_voter(text,uuid,text)')
    is null as gone,
  to_regprocedure('ypm_private.voter_accounts_enabled()')
    is null as switch_gone,
  to_regclass('public.voter_consents') is null as consents_gone;
```

Expected: `true, true, true, true`.

## U6. Compare with the snapshot taken before 004 (read-only)

Run the snapshot query below (the same one as before installing 004). The
fingerprints must equal the ones saved then:

| | Before 004 (Development, 2026-11-25) |
|---|---|
| `pub_fn_n` | 33 |
| `priv_fn_n` | 37 |
| `trig_n` | 1 |
| `col_n` | 90 |
| `rel_n` | 17 |
| `*_md5` | as saved with the backup |

Equal fingerprints mean every function body, security setting, grant,
trigger, column and table permission is exactly as 003 left it. The row
counts should equal U1 (the undo deletes no ballot, vote, voter,
registration or session). If any fingerprint differs, stop and report which
one; don't try to fix it by hand.

**One difference is possible and harmless: the grants in `pub_fn_md5`.**
The undo gives the 16 functions back `execute` to `public`, `anon` and
`authenticated`. That matches the local tests, but on Supabase the
functions' grants before 004 came partly from Supabase's default
privileges, which can't be read back from the fingerprint. If only
`pub_fn_md5` differs (counts and every other fingerprint equal), compare a
restored function with `begin_ballot`, which 003 created the same way and
004 never touched:

```sql
select p.proname,
       (select string_agg(a.grantee::regrole::text
                || '/' || a.privilege_type, ', '
                order by a.grantee::regrole::text)
          from aclexplode(p.proacl) a) as grants
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('begin_ballot', 'voter_login',
                     'admin_voter_stats');
```

All three rows should show the same grants (`-` means everyone, `public`).
If they do, the restored functions have the same grants as 003's other
browser functions, which is acceptable. If they don't, report the three
rows.

```sql
with f as (
  select n.nspname as sch,
         p.oid::regprocedure::text
         || '|' || md5(p.prosrc)
         || '|' || p.prosecdef::text
         || '|' || coalesce(p.proconfig::text, '')
         || '|' || coalesce((
              select string_agg(g, ',' order by g)
                from (select a.grantee::regrole::text
                             || '/' || a.privilege_type as g
                        from aclexplode(p.proacl) a) x
            ), 'default') as fp
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'ypm_private')
),
t as (
  select c.relname || '.' || tg.tgname
         || '|' || tg.tgenabled::text as fp
    from pg_trigger tg
    join pg_class c on c.oid = tg.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where not tg.tgisinternal
     and n.nspname in ('public', 'ypm_private')
),
col as (
  select table_schema || '.' || table_name
         || '.' || column_name || '|' || data_type
         || '|' || is_nullable
         || '|' || coalesce(column_default, '') as fp
    from information_schema.columns
   where table_schema in ('public', 'ypm_private')
),
r as (
  select n.nspname || '.' || c.relname
         || '|' || c.relrowsecurity::text
         || '|' || coalesce((
              select string_agg(g, ',' order by g)
                from (select a.grantee::regrole::text
                             || '/' || a.privilege_type as g
                        from aclexplode(c.relacl) a) x
            ), 'default') as fp
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname in ('public', 'ypm_private')
     and c.relkind in ('r', 'p', 'v', 'S')
)
select
  (select environment from ypm_private.deployment
    where id = 1) as env,
  (select count(*) from f where sch = 'public') as pub_fn_n,
  (select md5(string_agg(fp, ';' order by fp))
     from f where sch = 'public') as pub_fn_md5,
  (select count(*) from f
    where sch = 'ypm_private') as priv_fn_n,
  (select md5(string_agg(fp, ';' order by fp))
     from f where sch = 'ypm_private') as priv_fn_md5,
  (select count(*) from t) as trig_n,
  (select md5(string_agg(fp, ';' order by fp))
     from t) as trig_md5,
  (select count(*) from col) as col_n,
  (select md5(string_agg(fp, ';' order by fp))
     from col) as col_md5,
  (select count(*) from r) as rel_n,
  (select md5(string_agg(fp, ';' order by fp))
     from r) as rel_md5,
  (select count(*) from public.ballots) as ballots,
  (select count(*) from public.ballots
    where completed_at is not null) as submitted,
  (select count(*) from public.votes) as votes,
  (select count(*) from public.voters) as voters,
  (select count(*) from public.voters
    where status = 'active') as active,
  (select count(*) from public.voter_registrations) as regs,
  (select count(*) from public.voter_sessions) as sessions,
  (select count(*) from public.admin_audit) as audit;
```

## U7. Afterwards

- Set registration mode **Off** in the dashboard unless 004 is reinstalled
  straight away (without 004 nothing in the database stops it being on).
- To reinstall 004 later: the same procedure as the first install (backup,
  snapshot, run the file, verification). Consent records come back only for
  accounts whose consent was captured at registration; others stay without
  one (nothing is invented). The exported CSV is the record of what existed.

## If the undo itself fails

It is one transaction, so a failure leaves 004 installed and working. Report
the error; don't edit the database by hand. Restoring the pre-004 backup
(`pg_restore` into Development) **replaces data** and is a separate decision
needing its own approval and procedure; it is not part of this document.

---

## Re-running 003 while 004 is installed

**What would happen.** 003 recreates its public voter functions with
`create or replace`. For 14 of them that **silently replaces 004's wrappers**
with the unprotected 003 versions (no development-only check). For
`admin_register_voter` and `admin_resolve_review`, whose arguments 004
changed, 003 would **add** the old unprotected versions next to 004's. Data
is not affected, and 003's other guards (simulator only in development)
still hold, but voter functions would work in any environment until 004 is
re-run.

**Rule:** don't re-run 003 on its own. If it must be re-run, run 004 again
straight after it (004 is safe to re-run and replaces whatever is in
`public`). This is in `migrations/README.md`.

**Health check (read-only)**, worth running after any migration work:

```sql
select count(*) as unguarded
  from pg_proc p
 where p.pronamespace = 'public'::regnamespace
   and p.proname in ('voter_registration_start',
     'voter_registration_status', 'voter_registration_claim',
     'voter_login', 'voter_logout', 'voter_begin_ballot',
     'voter_save_vote', 'voter_submit_ballot',
     'admin_register_voter', 'admin_list_voters',
     'admin_reissue_voter_code', 'admin_revoke_voter',
     'admin_list_reviews', 'admin_resolve_review',
     'admin_set_registration_mode', 'admin_voter_stats',
     'admin_restore_voter')
   and p.prosrc not like '%voter_accounts_enabled()%';
```

Expected with 004 installed: `0`. Anything else means 003 was re-run after
004: run 004 again.

**Proposed fix (not made; needs approval).** Add a precondition to the top
of `003_voter_accounts.sql` that refuses to run while 004 is installed:

```sql
do $$
begin
  if to_regprocedure('ypm_private.voter_accounts_enabled()') is not null then
    raise exception 'Migration 004 is installed. Run 004_voter_safeguards.down.sql first, then 003, then 004 again.';
  end if;
end;
$$;
```

It changes nothing on a database without 004 (Production today), and on
Development it turns the silent replacement into an error before anything
runs. Tests would cover both cases.
