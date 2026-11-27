// Production build for release/voting-codes (migrations 001, 002 and
// ballot-sync.sql only): the voting page, voting codes and the admin
// dashboard are in it; voter accounts (/voter, Registered voters), the
// development prototype, simulator, tester panel, face checks, provider
// and sandbox code are not, even when someone sets environment variables
// that look like they would switch them on. Builds into a temporary folder
// (dist/ is untouched).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('production build', () => {
  it('contains voting and voting codes only: no voter accounts, biometrics or providers', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ypm-build-'))
    const tries = ['VITE_VOTER_ACCOUNTS', 'VITE_DEV', 'VITE_ENABLE_VOTERS']
    for (const k of tries) process.env[k] = 'true'
    try {
      await build({ root, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
      const text = readdirSync(join(out, 'assets'))
        .map((f) => readFileSync(join(out, 'assets', f), 'utf8'))
        .join('\n')
      for (const marker of [
        // voter accounts (003–007)
        'voter_request_in_person', 'voter_registration_start', 'voter_registration_claim', 'voter_login',
        'voter_begin_ballot', 'admin_voter_stats', 'admin_list_voters', 'admin_register_voter',
        'admin_confirm_in_person', 'admin_in_person_requests', 'admin_resolve_review',
        'admin_set_registration_mode', 'admin_restore_voter', 'Registered voters', 'Register in person',
        'ypm-register-2026-12-v1', 'ypm-voter-session', 'href="/voter"',
        // development prototype, simulator, providers, sandbox, biometrics
        'dev_simulate_verification', 'dev_provider_start', 'dev_sandbox_start', 'provider_webhook_result',
        'Tester panel', 'Sign in as tester', 'Start face check', 'Simulated camera',
        'prototype/voter', 'ypm-dev-voter-session', 'draft-2026-11-dev', '08155500',
      ]) {
        assert.ok(!text.includes(marker), `production bundle contains "${marker}"`)
      }
      // The release: voting, voting codes, the dashboard.
      for (const marker of [
        'begin_ballot', 'save_vote', 'submit_ballot', 'voting_status',
        'admin_login', 'admin_dashboard', 'admin_set_voting_open', 'admin_set_code_required',
        'admin_issue_codes', 'admin_list_codes', 'admin_revoke_code',
      ]) {
        assert.ok(text.includes(marker), `production bundle is missing "${marker}"`)
      }
    } finally {
      for (const k of tries) delete process.env[k]
      rmSync(out, { recursive: true, force: true })
    }
  })
})
