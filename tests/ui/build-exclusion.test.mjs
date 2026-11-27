// Production build (release of the youth-leader path): the voter page and
// the Registered voters tab are in it (the database switches them on, 007);
// the development prototype, simulator, tester panel, face-check
// registration, provider functions, draft notice and synthetic numbers are
// not, even when someone sets environment variables that look like they
// would switch them on. Builds into a temporary folder (dist/ is untouched).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('production build', () => {
  it('contains the youth-leader path and no part of the development voter flow', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ypm-build-'))
    const tries = ['VITE_VOTER_ACCOUNTS', 'VITE_DEV', 'VITE_ENABLE_VOTERS']
    for (const k of tries) process.env[k] = 'true'
    try {
      await build({ root, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } })
      const text = readdirSync(join(out, 'assets'))
        .map((f) => readFileSync(join(out, 'assets', f), 'utf8'))
        .join('\n')
      for (const marker of [
        'dev_simulate_verification',
        'voter_registration_start',
        'voter_registration_claim',
        'Tester panel',
        'Sign in as tester',
        'Simulated camera',
        'Start face check',
        'prototype/voter',
        'ypm-dev-voter-session',
        'dev_provider_start',
        'dev_provider_outbox',
        'dev_provider_callback',
        'dev_sandbox_start',
        'provider_webhook_result',
        'draft-2026-11-dev',
        '08155500',
      ]) {
        assert.ok(!text.includes(marker), `production bundle contains "${marker}"`)
      }
      // The release: the voter page, the youth-leader path and voter management.
      for (const marker of [
        'voter_request_in_person', 'voter_login', 'voter_begin_ballot', 'ypm-register-2026-12-v1',
        'admin_confirm_in_person', 'admin_in_person_requests', 'admin_register_voter', 'Registered voters',
      ]) {
        assert.ok(text.includes(marker), `production bundle is missing "${marker}"`)
      }
      // Sanity check: it is the real app.
      assert.ok(text.includes('admin_dashboard'))
      assert.ok(text.includes('admin_list_codes'), 'the Phase 2.1 code management is there')
      assert.ok(text.includes('registration_required'), 'the voting page messages are there')
    } finally {
      for (const k of tries) delete process.env[k]
      rmSync(out, { recursive: true, force: true })
    }
  })
})
