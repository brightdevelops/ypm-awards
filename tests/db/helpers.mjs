// Test harness: a real Postgres (PGlite, in-process) set up the way the
// production database is — supabase-setup.sql first, then the migration.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PGlite } from '@electric-sql/pglite'

const root = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url))
export const SETUP_SQL = readFileSync(root('supabase-setup.sql'), 'utf8')
export const MIGRATION_SQL = readFileSync(root('migrations/001_secure_voting.sql'), 'utf8')
export const DOWN_SQL = readFileSync(root('migrations/001_secure_voting.down.sql'), 'utf8')
export const BALLOT_MIGRATION_SQL = readFileSync(root('migrations/002_ballot_validation.sql'), 'utf8')
export const BALLOT_DOWN_SQL = readFileSync(root('migrations/002_ballot_validation.down.sql'), 'utf8')
export const BALLOT_SYNC_SQL = readFileSync(root('migrations/ballot-sync.sql'), 'utf8')
export const VOTER_MIGRATION_SQL = readFileSync(root('migrations/003_voter_accounts.sql'), 'utf8')
export const VOTER_DOWN_SQL = readFileSync(root('migrations/003_voter_accounts.down.sql'), 'utf8')
export const DEV_SIM_SQL = readFileSync(root('migrations/dev/simulated_verification.sql'), 'utf8')
export const SAFEGUARDS_SQL = readFileSync(root('migrations/004_voter_safeguards.sql'), 'utf8')
export const SAFEGUARDS_DOWN_SQL = readFileSync(root('migrations/004_voter_safeguards.down.sql'), 'utf8')
export const PROVIDER_SQL = readFileSync(root('migrations/005_simulated_provider.sql'), 'utf8')
export const PROVIDER_DOWN_SQL = readFileSync(root('migrations/005_simulated_provider.down.sql'), 'utf8')

// Supabase's API roles, with Supabase's default grants: anon and
// authenticated get every privilege on new objects in \`public\`, so RLS
// and explicit revokes are what actually keep them out.
export const ROLES_SQL = `
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public to anon, authenticated;
  alter default privileges in schema public grant all on tables    to anon, authenticated;
  alter default privileges in schema public grant all on sequences to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`

// A stand-in for Supabase Vault (the supabase_vault extension): same names,
// no encryption. Real Vault encrypts secrets with a key held outside the
// database.
export const VAULT_STUB_SQL = `
  create schema if not exists vault;
  create table if not exists vault.secrets (
    id uuid primary key default gen_random_uuid(),
    name text unique, secret text not null, description text not null default ''
  );
  create or replace view vault.decrypted_secrets as
    select id, name, secret as decrypted_secret, description from vault.secrets;
  create or replace function vault.create_secret(
    new_secret text, new_name text default null, new_description text default '',
    new_key_id uuid default null
  ) returns uuid language sql as $$
    insert into vault.secrets (name, secret, description)
    values (new_name, new_secret, new_description) returning id;
  $$;
  revoke all on schema vault from public;
`

// Keys from supabase-setup.sql's seed.
export const LEADER_KEY = 'change-this-leader-key'
export const INVENTOR_KEY = 'change-this-inventor-key'

// Ballots that exist before the migration, like production's.
export const LEGACY = {
  done: { name: 'Ada Done', phone: '08011111111' },
  open: { name: 'Bayo Open', phone: '08022222222' },
}

// migrate: false = production as it is today; '001' = after 001 only;
// '002' = 001, 002 and ballot-sync.sql (before voter accounts);
// '003' = through 003 (voter accounts, before the 004 safeguards);
// true = every migration through 004 plus the current ballot-sync.sql;
// '005' = all of that plus 005 (simulated provider).
export async function freshDb({ migrate = true } = {}) {
  const db = new PGlite()
  await db.exec(ROLES_SQL)
  await db.exec(SETUP_SQL)

  // Seed one submitted and one unfinished ballot through the OLD functions.
  // 'Someone' is deliberately not on the ballot: production may hold votes
  // for names edited out since, and the migrations must leave them alone.
  for (const v of [LEGACY.done, LEGACY.open]) {
    const r = await call(db, 'start_ballot', { p_name: v.name, p_phone: v.phone })
    v.ballotId = r.ballot_id
    await call(db, 'save_vote', {
      p_ballot_id: r.ballot_id,
      p_category_id: 'most-reliable-youth',
      p_nominee_name: 'Someone',
    })
  }
  await call(db, 'submit_ballot', { p_ballot_id: LEGACY.done.ballotId })

  await db.exec(VAULT_STUB_SQL)
  if (migrate) await db.exec(MIGRATION_SQL)
  if (migrate === true || migrate === '002' || migrate === '003' || migrate === '005') {
    await db.exec(BALLOT_MIGRATION_SQL)
    await db.exec(BALLOT_SYNC_SQL)
  }
  if (migrate === true || migrate === '003' || migrate === '005') await db.exec(VOTER_MIGRATION_SQL)
  if (migrate === true || migrate === '005') await db.exec(SAFEGUARDS_SQL)
  if (migrate === '005') await db.exec(PROVIDER_SQL)
  return db
}

// Call a public function the way the browser does: as `anon`, with request
// headers set, using named arguments.
export async function call(db, fn, args = {}, { ip = '203.0.113.7', role = 'anon' } = {}) {
  const names = Object.keys(args)
  const params = names.map((n, i) => `${n} => $${i + 1}`).join(', ')
  const headers = JSON.stringify(ip ? { 'x-forwarded-for': ip } : {})

  await db.query(`select set_config('request.headers', $1, false)`, [headers])
  if (role) await db.exec(`set role ${role}`)
  try {
    const res = await db.query(`select public.${fn}(${params}) as r`, Object.values(args))
    return res.rows[0].r
  } finally {
    if (role) await db.exec('reset role')
  }
}

// Superuser query, for checking state and simulating the passage of time.
export async function sql(db, text, params = []) {
  return (await db.query(text, params)).rows
}

export async function login(db, key = LEADER_KEY) {
  const r = await call(db, 'admin_login', { p_key: key })
  if (r.status !== 'ok') throw new Error(`login failed: ${JSON.stringify(r)}`)
  return r.session
}

export async function issue(db, session, opts = {}) {
  const r = await call(db, 'admin_issue_codes', {
    p_session: session,
    p_count: opts.count ?? 1,
    p_phone: opts.phone ?? null,
    p_note: opts.note ?? null,
    p_expires_hours: opts.expiresHours ?? null,
  })
  if (r.status !== 'ok') throw new Error(`issue failed: ${JSON.stringify(r)}`)
  return r.codes
}
