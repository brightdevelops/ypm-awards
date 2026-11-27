// Check a backup made by scripts/dev-backup.ps1, offline.
//
//   Development:  node scripts/verify-dev-backup.mjs <folder> [--expect 004|005] [--rehearse]
//   Production:   node scripts/verify-dev-backup.mjs <folder> --production [--rehearse]
//
// 1. backup.dump matches backup.sha256.
// 2. The dump's table of contents has the expected tables and functions
//    (Development: migrations 001–004; Production: the original tables) and
//    says which migrations are already in it; --expect checks 005.
// 3. It restores into a throwaway PostgreSQL server on 127.0.0.1 (created in
//    the temp folder and deleted afterwards; it never connects anywhere
//    else), and every table has the row count recorded in counts.tsv.
// 4. --rehearse (Development): runs migrations 005 and 006 on that restored
//    copy (with a stand-in for Vault) and checks they install and change no
//    existing row: a dress rehearsal on Development's own data.
//    --rehearse --production: runs every migration not yet installed, in
//    order (001, 002 + ballot-sync.sql, 003, 004, 005, 006, 007), and checks
//    that every ballot and vote is exactly as before (a fingerprint of all
//    of them) and the results are unchanged; that the copy is still
//    production-marked with voter accounts OFF, no face checks, no simulator
//    key and the published notice current; and that, as the browser, voter
//    accounts answer "disabled" while anonymous voting still works.
//
// Exit code 0 only if all of that holds. Prints table names, counts and
// fingerprints, never row contents.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { findPgBin, startCluster } from '../tests/concurrency/pg-cluster.mjs'
import {
  VAULT_STUB_SQL, MIGRATION_SQL, BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL, VOTER_MIGRATION_SQL,
  SAFEGUARDS_SQL, PROVIDER_SQL, CHOICE_SQL, LIVE_SQL, DOWN_SQL, BALLOT_DOWN_SQL,
  SELF_REG_SQL, SELF_REG_DOWN_SQL, CHOICE_DOWN_SQL, PROVIDER_DOWN_SQL, SAFEGUARDS_DOWN_SQL, VOTER_DOWN_SQL,
} from '../tests/db/helpers.mjs'

const dir = process.argv[2]
const expectIdx = process.argv.indexOf('--expect')
const expect = expectIdx > 0 ? process.argv[expectIdx + 1] : null
const rehearse = process.argv.includes('--rehearse')
const production = process.argv.includes('--production')
// --through 002: rehearse only 001, 002 and ballot-sync.sql (the
// voting-codes release). --through 008: plus 008 (self-registration).
// --rollback: then undo them (008, then 002, then 001).
const throughIdx = process.argv.indexOf('--through')
const through = throughIdx > 0 ? process.argv[throughIdx + 1] : '007'
const rollback = process.argv.includes('--rollback')
if (!dir || !existsSync(join(dir, 'backup.dump'))) {
  console.error('Usage: node scripts/verify-dev-backup.mjs <folder with backup.dump, backup.sha256, counts.tsv> [--expect 004|005] [--production] [--rehearse]')
  process.exit(2)
}

// Tables (and rows) that can change in the moment between the dump and the
// count: a difference there is reported but isn't a failure.
const VOLATILE = new Set(['public.rate_events', 'public.admin_sessions', 'public.voter_sessions'])

const REQUIRED_PRODUCTION = ['TABLE public settings', 'TABLE public ballots', 'TABLE public votes']
const REQUIRED_DEV = [
  'TABLE public settings', 'TABLE public ballots', 'TABLE public votes', 'TABLE public admin_keys',
  'TABLE public voting_codes', 'TABLE public admin_users', 'TABLE public admin_audit',
  'TABLE public ballot_categories', 'TABLE public ballot_nominees',
  'TABLE public voters', 'TABLE public voter_registrations', 'TABLE public voter_sessions',
  'TABLE public voter_consents', 'TABLE ypm_private deployment', 'TABLE ypm_private consent_versions',
  'TABLE ypm_private retired_voter_codes',
  'FUNCTION public admin_restore_voter', 'FUNCTION ypm_private voter_accounts_enabled',
  'FUNCTION ypm_private save_vote_002', 'FUNCTION ypm_private begin_ballot_001',
]
const REQUIRED = production ? REQUIRED_PRODUCTION : REQUIRED_DEV
const MARK_005 = 'TABLE ypm_private provider_sessions'
// What each migration leaves behind, to know how far a copy already is.
const CHAIN = [
  ['001', 'TABLE public admin_sessions', [MIGRATION_SQL]],
  ['002', 'TABLE public ballot_nominees', [BALLOT_MIGRATION_SQL, BALLOT_SYNC_SQL]],
  ['003', 'TABLE public voters', [VOTER_MIGRATION_SQL]],
  ['004', 'TABLE ypm_private consent_versions', [SAFEGUARDS_SQL]],
  ['005', MARK_005, [PROVIDER_SQL]],
  ['006', 'TABLE ypm_private in_person_requests', [CHOICE_SQL]],
]

let failures = 0
const fail = (msg) => { failures += 1; console.log(`FAIL  ${msg}`) }
const ok = (msg) => console.log(`ok    ${msg}`)

// 1. Checksum.
const want = readFileSync(join(dir, 'backup.sha256'), 'utf8').trim().toUpperCase()
const got = createHash('sha256').update(readFileSync(join(dir, 'backup.dump'))).digest('hex').toUpperCase()
if (got === want) ok(`SHA-256 matches (${got.slice(0, 12)}…)`)
else fail(`SHA-256 is ${got}, recorded ${want}`)

const bin = findPgBin()
if (!bin) {
  fail('PostgreSQL programs not found (set YPM_PG_BIN)')
  process.exit(1)
}
const EXE = process.platform === 'win32' ? '.exe' : ''
const env = { PATH: process.env.PATH ?? process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, PGCLIENTENCODING: 'UTF8' }
const tool = (n, args) => spawnSync(join(bin, n + EXE), args, { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 300000 })

// 2. Table of contents.
const list = tool('pg_restore', ['--list', join(dir, 'backup.dump')])
if (list.status !== 0) {
  fail(`pg_restore --list: ${list.stderr}`)
  process.exit(1)
}
const toc = list.stdout.split(/\r?\n/).filter((l) => l && !l.startsWith(';'))
const has = (entry) => {
  const [type, schema, name] = entry.split(' ')
  return toc.some((l) => {
    const m = l.match(/^\d+;\s+\d+\s+\d+\s+(.+)$/)
    if (!m) return false
    const parts = m[1].split(' ')
    // Functions are listed with their arguments: "name(text, uuid)".
    return parts[0] === type && parts[1] === schema && (parts[2] === name || parts[2].startsWith(name + '('))
  })
}
const missing = REQUIRED.filter((e) => !has(e))
if (missing.length) fail(`missing from the dump: ${missing.join(', ')}`)
else ok(`all ${REQUIRED.length} required ${production ? 'original' : '001–004'} objects are in the dump (${toc.length} entries)`)
const has005 = has(MARK_005)
const installed = CHAIN.filter(([, mark]) => has(mark)).map(([id]) => id)
if (production) console.log(`info  migrations already in this dump: ${installed.length ? installed.join(', ') : 'none'}`)
else console.log(`info  005 ${has005 ? 'IS' : 'is not'} in this dump`)
if (expect === '004' && has005) fail('expected a pre-005 backup')
if (expect === '005' && !has005) fail('expected a backup with 005')

// Every ballot and its votes, and the results, as fingerprints.
const FINGERPRINT = `
  select count(*)::text || '/' || count(b.completed_at)::text || '/' ||
         (select count(*) from public.votes)::text || '/' ||
         coalesce(md5(string_agg(x.line, ',' order by x.line)), '-')
    from public.ballots b
    cross join lateral (
      select b.id || ':' || coalesce(b.completed_at::text, '-') || ':' ||
             coalesce(string_agg(v.category_id || '=' || v.nominee_name, ';' order by v.category_id), '') as line
        from public.votes v where v.ballot_id = b.id) x;`
const RESULTS = `
  select coalesce(md5(string_agg(category_id || '=' || nominee_name || ':' || n, ',' order by category_id, nominee_name)), '-')
    from (select v.category_id, v.nominee_name, count(*) n
            from public.votes v join public.ballots b on b.id = v.ballot_id
           where b.completed_at is not null group by 1, 2) t;`

// 3. Restore into a throwaway server and compare counts.
const recorded = new Map(
  readFileSync(join(dir, 'counts.tsv'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    const [t, n] = l.split('\t')
    return [t, Number(n)]
  }),
)
const pg = await startCluster(bin)
try {
  // The roles and schemas Supabase provides, so policies, grants and
  // function settings that name them restore.
  pg.psql('postgres', `
    create role anon nologin; create role authenticated nologin; create role service_role nologin;
    create schema if not exists extensions;` + VAULT_STUB_SQL)
  const r = tool('pg_restore', ['-h', '127.0.0.1', '-p', String(pg.port), '-U', 'postgres', '-d', 'postgres', '--no-owner', join(dir, 'backup.dump')])
  // "schema public already exists" is expected: every server has one.
  const errors = (r.stderr.match(/^pg_restore: error:.*$/gm) ?? [])
    .filter((e) => !/schema "public" already exists/.test(e))
  if (errors.length) {
    console.log(`warn  ${errors.length} restore error(s) (Supabase-only objects); first ones:`)
    for (const e of errors.slice(0, 5)) console.log(`        ${e.slice(0, 200)}`)
  }
  const countAll = () => new Map(
    pg.psql('postgres', `
      select table_schema || '.' || table_name || '|' ||
             (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
      from information_schema.tables
      where table_schema in ('public', 'ypm_private') and table_type = 'BASE TABLE' order by 1;`)
      .split(/\r?\n/).filter(Boolean).map((l) => { const [t, n] = l.split('|'); return [t, Number(n)] }),
  )
  const restored = countAll()
  let rows = 0
  for (const [t, n] of recorded) {
    const m = restored.get(t)
    if (m === undefined) fail(`${t}: in counts.tsv but not restored`)
    else if (m !== n) (VOLATILE.has(t) ? console.log(`note  ${t}: ${m} restored, ${n} counted a moment later`) : fail(`${t}: ${m} restored, ${n} recorded`))
    else rows += n
  }
  for (const t of restored.keys()) if (!recorded.has(t)) fail(`${t}: restored but not in counts.tsv`)
  if (!failures) ok(`restored ${restored.size} tables; row counts match (${rows} rows)`)

  if (rehearse && production && (through === '002' || through === '008')) {
    // The voting-codes release: 001, 002 + ballot-sync.sql only.
    const TABLES = `select string_agg(table_name, ',' order by table_name) from information_schema.tables
                     where table_schema = 'public' and table_type = 'BASE TABLE';`
    // Functions the live site (main) calls, and those the new site calls.
    const OLD_SITE = ['start_ballot(text,text)', 'save_vote(uuid,text,text)', 'submit_ballot(uuid)',
      'get_tally(text)', 'set_voting_open(text,boolean)', 'voting_status()']
    const NEW_SITE = ['begin_ballot(text,text,text,uuid)', 'admin_login(text)', 'admin_dashboard(text)',
      'admin_set_voting_open(text,boolean)', 'admin_set_code_required(text,boolean)',
      'admin_issue_codes(text,integer,text,text,integer)', 'admin_list_codes(text)', 'admin_revoke_code(text,uuid)']
    const exists = (sigs) => sigs.filter((f) => pg.psql('postgres', `select to_regprocedure('public.${f}') is not null;`).trim() !== 't')
    const tablesBefore = pg.psql('postgres', TABLES).trim().split(',')
    const before = pg.psql('postgres', FINGERPRINT).trim()
    const resultsBefore = pg.psql('postgres', RESULTS).trim()
    const [nb, ns, nv] = before.split('/')
    const sameVotes = (when) => {
      if (pg.psql('postgres', FINGERPRINT).trim() !== before) fail(`ballots or votes changed ${when}`)
      else ok(`every ballot and vote is exactly as before ${when} (${nb} ballots, ${ns} submitted, ${nv} votes)`)
      if (pg.psql('postgres', RESULTS).trim() !== resultsBefore) fail(`the results changed ${when}`)
      else ok(`the results (submitted votes per nominee) are unchanged ${when}`)
      const now = pg.psql('postgres', TABLES).trim().split(',')
      const gone = tablesBefore.filter((t) => !now.includes(t))
      if (gone.length) fail(`tables missing ${when}: ${gone.join(', ')}`)
      else ok(`no existing table was removed ${when} (${tablesBefore.length} tables)`)
    }
    try {
      for (const [id, mark, files] of CHAIN.filter(([id]) => id <= '002')) {
        if (installed.includes(id)) continue
        for (const sqlText of files) pg.psql('postgres', sqlText)
        ok(`${id === '002' ? '002 + ballot-sync.sql' : id} installs on the restored copy`)
      }
      if (through === '008') {
        pg.psql('postgres', SELF_REG_SQL)
        ok('008 (self-registration) installs on the restored copy')
      }
      sameVotes('after installing')
      if (has('TABLE public voters') || pg.psql('postgres', `select to_regclass('public.voters') is not null;`).trim() === 't') {
        fail('voter accounts (003) are present; this release must not include them')
      } else ok('no voter accounts (003–007) and nothing biometric installed')
      const missingNew = exists(NEW_SITE)
      if (missingNew.length) fail(`the new site needs: ${missingNew.join(', ')}`)
      else ok(`every function the new site calls exists (${NEW_SITE.length})`)
      const missingOld = exists(OLD_SITE)
      if (missingOld.length) fail(`the live site (main) would break: ${missingOld.join(', ')}`)
      else ok(`every function the live site calls still exists (${OLD_SITE.length}): rolling the site back is safe`)
      const smoke = pg.psql('postgres', `
        select set_config('request.headers', '{"x-forwarded-for":"203.0.113.250"}', false);
        set role anon;
        create temp table smoke_result as select public.begin_ballot('Test Rehearsal', '08155500998', null) r;
        reset role;
        select (r->>'status') || '+code=' ||
               (exists (select 1 from public.voting_codes c join public.ballots b on b.voting_code_id = c.id
                         where b.voter_phone = '08155500998' and c.created_by = 'self-registration'
                           and c.phone = '08155500998' and c.code_hash = ypm_private.sha256_hex(ypm_private.normalize_code(r->>'voter_code'))))::text
          from smoke_result;`).trim().split(/\r?\n/).filter(Boolean).pop()
      const [smokeStatus, smokeCode] = smoke.split('+code=')
      if (!['started', 'code_required'].includes(smokeStatus)) fail(`anonymous ballot as the browser: ${smoke}`)
      else ok(`as the browser, starting a ballot answers "${smokeStatus}" (codes ${smokeStatus === 'started' ? 'optional' : 'required'} on this copy)`)
      if (through === '008' && smokeStatus === 'started') {
        if (smokeCode !== 'true') fail('self-registration gave the smoke-test voter no voter code')
        else ok('self-registration gave that voter a phone-bound voter code')
      }
      // Remove the synthetic smoke-test ballot (and its voter code, if any).
      pg.psql('postgres', `
        create temp table smoke_codes as
          select voting_code_id id from public.ballots where voter_phone = '08155500998' and voting_code_id is not null;
        delete from public.votes where ballot_id in (select id from public.ballots where voter_phone = '08155500998');
        delete from public.ballots where voter_phone = '08155500998';
        delete from public.voting_codes where id in (select id from smoke_codes) and created_by = 'self-registration';
        delete from public.rate_events where bucket like '%203.0.113.250%';`)
      if (rollback) {
        if (through === '008') {
          pg.psql('postgres', SELF_REG_DOWN_SQL)
          ok('008 undo runs on the restored copy')
        }
        pg.psql('postgres', BALLOT_DOWN_SQL)
        ok('002 undo runs on the restored copy')
        pg.psql('postgres', DOWN_SQL)
        ok('001 undo runs on the restored copy')
        sameVotes('after rolling back')
        const back = exists(OLD_SITE)
        if (back.length) fail(`after rolling back, the live site would miss: ${back.join(', ')}`)
        else ok('after rolling back, every function the live site calls exists')
      }
    } catch (e) {
      fail(`the release did not install on the restored copy: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`)
    }
  } else if (rehearse && production) {
    const before = pg.psql('postgres', FINGERPRINT).trim()
    const resultsBefore = pg.psql('postgres', RESULTS).trim()
    try {
      for (const [id, mark, files] of [...CHAIN, ['007', null, [LIVE_SQL]]]) {
        if (mark && installed.includes(id)) continue
        for (const sqlText of files) pg.psql('postgres', sqlText)
        ok(`${id} installs on the restored copy`)
      }
      const after = pg.psql('postgres', FINGERPRINT).trim()
      const [nb, ns, nv] = before.split('/')
      if (after !== before) fail(`ballots or votes changed: ${before.split('/').slice(0, 3).join('/')} → ${after.split('/').slice(0, 3).join('/')}`)
      else ok(`every ballot and vote is exactly as before (${nb} ballots, ${ns} submitted, ${nv} votes)`)
      if (pg.psql('postgres', RESULTS).trim() !== resultsBefore) fail('the results (submitted votes per nominee) changed')
      else ok('the results (submitted votes per nominee) are unchanged')
      const state = pg.psql('postgres', `
        select (select environment from ypm_private.deployment) || ',' ||
               (select voter_accounts_live from ypm_private.deployment)::text || ',' ||
               (select verification_provider from public.settings where id = 1) || ',' ||
               (select registration_mode from public.settings where id = 1) || ',' ||
               exists (select 1 from vault.secrets where name = 'ypm_sim_provider_key')::text || ',' ||
               coalesce((select version from ypm_private.consent_versions where is_current), '-');`).trim()
      console.log(`info  environment,live,provider,registration,sim_key,notice = ${state}`)
      if (state !== 'production,false,none,off,false,ypm-register-2026-12-v1') fail(`unexpected state after the chain: ${state}`)
      else ok('still Production: voter accounts off, no face checks, no simulator key, published notice current')
      const smoke = pg.psql('postgres', `
        select set_config('request.headers', '{"x-forwarded-for":"203.0.113.250"}', false);
        set role anon;
        select (public.voter_request_in_person('Test Rehearsal', '08155500999', 'ypm-register-2026-12-v1', true)->>'status') || ',' ||
               (public.begin_ballot('Test Rehearsal', '08155500998', null)->>'status');
        reset role;`).trim().split(/\r?\n/).filter(Boolean).pop()
      console.log(`info  as the browser: voter request, anonymous ballot = ${smoke}`)
      if (smoke !== 'disabled,started') fail(`expected disabled,started, got ${smoke}`)
      else ok('voter accounts answer "disabled" until switched on; anonymous voting still works')
    } catch (e) {
      fail(`the chain did not install on the restored copy: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`)
    }
  } else if (rehearse && through === '008') {
    // Development → self-registration: undo 006, 005, 004, 003 (whichever
    // are installed), then install 008, on the restored copy.
    const TABLES = `select string_agg(table_schema || '.' || table_name, ',' order by 1) from information_schema.tables
                     where table_schema in ('public', 'ypm_private') and table_type = 'BASE TABLE';`
    const before = pg.psql('postgres', FINGERPRINT).trim()
    const resultsBefore = pg.psql('postgres', RESULTS).trim()
    const codesBefore = pg.psql('postgres', `select count(*) || '/' || coalesce(md5(string_agg(id::text || code_hash, ',' order by id)), '-') from public.voting_codes;`).trim()
    const tablesBefore = pg.psql('postgres', TABLES).trim().split(',')
    const [nb, ns, nv] = before.split('/')
    const same = (when) => {
      if (pg.psql('postgres', FINGERPRINT).trim() !== before) fail(`ballots or votes changed ${when}`)
      else ok(`every ballot and vote is exactly as before ${when} (${nb} ballots, ${ns} submitted, ${nv} votes)`)
      if (pg.psql('postgres', RESULTS).trim() !== resultsBefore) fail(`the results changed ${when}`)
      else ok(`the results are unchanged ${when}`)
      if (pg.psql('postgres', `select count(*) || '/' || coalesce(md5(string_agg(id::text || code_hash, ',' order by id)), '-') from public.voting_codes;`).trim() !== codesBefore) fail(`voting codes changed ${when}`)
      else ok(`every voting code is unchanged ${when} (${codesBefore.split('/')[0]})`)
    }
    try {
      for (const [id, mark, file] of [
        ['006', 'ypm_private.in_person_requests', CHOICE_DOWN_SQL], ['005', 'ypm_private.provider_sessions', PROVIDER_DOWN_SQL],
        ['004', 'ypm_private.consent_versions', SAFEGUARDS_DOWN_SQL], ['003', 'public.voters', VOTER_DOWN_SQL],
      ]) {
        if (pg.psql('postgres', `select to_regclass('${mark}') is not null;`).trim() !== 't') { console.log(`info  ${id} is not installed here; nothing to undo`); continue }
        pg.psql('postgres', file)
        ok(`${id} undo runs on the restored copy`)
      }
      same('after undoing 006–003')
      const now = pg.psql('postgres', TABLES).trim().split(',')
      const gone = tablesBefore.filter((t) => !now.includes(t))
      console.log(`info  tables the undo removes (voter accounts and verification): ${gone.join(', ') || 'none'}`)
      const unexpected = gone.filter((t) => ['public.ballots', 'public.votes', 'public.settings', 'public.voting_codes',
        'public.admin_users', 'public.admin_audit', 'public.ballot_categories', 'public.ballot_nominees', 'public.admin_keys'].includes(t))
      if (unexpected.length) fail(`the undo would remove core tables: ${unexpected.join(', ')}`)
      else ok('no voting, code, admin or ballot table is removed')
      pg.psql('postgres', SELF_REG_SQL)
      ok('008 (self-registration) installs on the restored copy')
      same('after installing 008')
      const smoke = pg.psql('postgres', `
        select set_config('request.headers', '{"x-forwarded-for":"203.0.113.250"}', false);
        set role anon;
        create temp table smoke_result as select public.begin_ballot('Test Rehearsal', '08155500998', null) r;
        reset role;
        select (r->>'status') || ',' || (r->>'voter_code' is not null)::text from smoke_result;`).trim().split(/\r?\n/).filter(Boolean).pop()
      if (!/^(started,true|code_required,false)$/.test(smoke)) fail(`self-registration as the browser: ${smoke}`)
      else ok(`as the browser, self-registration answers ${smoke.startsWith('started') ? '"started" with a voter code' : '"code_required" (Codes required is on in this copy)'}`)
    } catch (e) {
      fail(`the Development path did not complete on the restored copy: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`)
    }
  } else if (rehearse && has005) {
    console.log('info  --rehearse skipped: 005 is already in this backup')
  } else if (rehearse) {
    try {
      pg.psql('postgres', PROVIDER_SQL)
      ok('005 installs on the restored copy')
      pg.psql('postgres', CHOICE_SQL)
      ok('006 installs on the restored copy')
      const after = countAll()
      const changed = [...restored].filter(([t, n]) => after.get(t) !== n).map(([t]) => t)
      if (changed.length) fail(`005/006 changed row counts in: ${changed.join(', ')}`)
      else ok(`005 and 006 changed no existing table's row count (${restored.size} tables)`)
      const check = pg.psql('postgres', `
        select (to_regclass('ypm_private.provider_sessions') is not null)::text || ',' ||
               exists (select 1 from vault.decrypted_secrets where name = 'ypm_sim_provider_key')::text || ',' ||
               (select verification_provider from settings where id = 1) || ',' ||
               (select environment from ypm_private.deployment) || ',' ||
               (to_regclass('ypm_private.in_person_requests') is not null)::text;`).trim()
      console.log(`info  after 005+006: installed,key_present,provider,environment,006 = ${check}`)
      if (!check.startsWith('true,')) fail('005 objects missing after install')
    } catch (e) {
      fail(`005/006 did not install on the restored copy: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`)
    }
  }
} finally {
  pg.stop()
}

console.log(failures ? `\nBACKUP NOT VERIFIED (${failures} problem(s))` : '\nBACKUP VERIFIED')
process.exit(failures ? 1 : 0)
