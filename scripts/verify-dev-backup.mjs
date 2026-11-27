// Check a Development backup made by scripts/dev-backup.ps1, offline.
//
//   node scripts/verify-dev-backup.mjs <backup folder> [--expect 004|005] [--rehearse]
//
// 1. backup.dump matches backup.sha256.
// 2. The dump's table of contents has the tables and functions of
//    migrations 001–004 (and says whether 005 is in it; --expect checks it).
// 3. It restores into a throwaway PostgreSQL server on 127.0.0.1 (created in
//    the temp folder and deleted afterwards; it never connects anywhere
//    else), and every table has the row count recorded in counts.tsv.
// 4. --rehearse: then runs migrations/005_simulated_provider.sql on that
//    restored copy (with a stand-in for Vault) and checks it installs and
//    changes no existing row: a dress rehearsal on Development's own data.
//
// Exit code 0 only if all of that holds. Prints table names and counts,
// never row contents.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { findPgBin, startCluster } from '../tests/concurrency/pg-cluster.mjs'
import { VAULT_STUB_SQL, PROVIDER_SQL } from '../tests/db/helpers.mjs'

const dir = process.argv[2]
const expectIdx = process.argv.indexOf('--expect')
const expect = expectIdx > 0 ? process.argv[expectIdx + 1] : null
const rehearse = process.argv.includes('--rehearse')
if (!dir || !existsSync(join(dir, 'backup.dump'))) {
  console.error('Usage: node scripts/verify-dev-backup.mjs <folder with backup.dump, backup.sha256, counts.tsv> [--expect 004|005]')
  process.exit(2)
}

// Tables (and rows) that can change in the moment between the dump and the
// count: a difference there is reported but isn't a failure.
const VOLATILE = new Set(['public.rate_events', 'public.admin_sessions', 'public.voter_sessions'])

const REQUIRED = [
  'TABLE public settings', 'TABLE public ballots', 'TABLE public votes', 'TABLE public admin_keys',
  'TABLE public voting_codes', 'TABLE public admin_users', 'TABLE public admin_audit',
  'TABLE public ballot_categories', 'TABLE public ballot_nominees',
  'TABLE public voters', 'TABLE public voter_registrations', 'TABLE public voter_sessions',
  'TABLE public voter_consents', 'TABLE ypm_private deployment', 'TABLE ypm_private consent_versions',
  'TABLE ypm_private retired_voter_codes',
  'FUNCTION public admin_restore_voter', 'FUNCTION ypm_private voter_accounts_enabled',
  'FUNCTION ypm_private save_vote_002', 'FUNCTION ypm_private begin_ballot_001',
]
const MARK_005 = 'TABLE ypm_private provider_sessions'

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
else ok(`all ${REQUIRED.length} required 001–004 objects are in the dump (${toc.length} entries)`)
const has005 = has(MARK_005)
console.log(`info  005 ${has005 ? 'IS' : 'is not'} in this dump`)
if (expect === '004' && has005) fail('expected a pre-005 backup')
if (expect === '005' && !has005) fail('expected a backup with 005')

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

  if (rehearse && has005) console.log('info  --rehearse skipped: 005 is already in this backup')
  else if (rehearse) {
    try {
      pg.psql('postgres', PROVIDER_SQL)
      ok('005 installs on the restored copy')
      const after = countAll()
      const changed = [...restored].filter(([t, n]) => after.get(t) !== n).map(([t]) => t)
      if (changed.length) fail(`005 changed row counts in: ${changed.join(', ')}`)
      else ok(`005 changed no existing table's row count (${restored.size} tables)`)
      const check = pg.psql('postgres', `
        select (to_regclass('ypm_private.provider_sessions') is not null)::text || ',' ||
               exists (select 1 from vault.decrypted_secrets where name = 'ypm_sim_provider_key')::text || ',' ||
               (select verification_provider from settings where id = 1) || ',' ||
               (select environment from ypm_private.deployment);`).trim()
      console.log(`info  after 005: installed,key_present,provider,environment = ${check}`)
      if (!check.startsWith('true,')) fail('005 objects missing after install')
    } catch (e) {
      fail(`005 did not install on the restored copy: ${String(e.message).split('\n').slice(0, 4).join(' | ')}`)
    }
  }
} finally {
  pg.stop()
}

console.log(failures ? `\nBACKUP NOT VERIFIED (${failures} problem(s))` : '\nBACKUP VERIFIED')
process.exit(failures ? 1 : 0)
