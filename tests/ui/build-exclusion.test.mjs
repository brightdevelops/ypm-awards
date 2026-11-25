// The development voter flow, simulator, tester panel and the admin
// "Registered voters" tab must not be in a production build, even when
// someone sets environment variables that look like they would switch them
// on. Builds into a temporary folder (dist/ is untouched).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('production build', () => {
  it('contains no part of the development voter flow or voter management', async () => {
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
        'Simulated verification',
        'Simulated camera',
        'prototype/voter',
        'ypm-dev-voter-session',
        // Phase 3.4 admin tab
        'admin_voter_stats',
        'admin_list_voters',
        'admin_register_voter',
        'admin_reissue_voter_code',
        'admin_revoke_voter',
        'admin_resolve_review',
        'admin_set_registration_mode',
        'admin_restore_voter',
        'Restore with a new code',
        'Registered voters',
        'Register in person',
        'voterHandover',
      ]) {
        assert.ok(!text.includes(marker), `production bundle contains "${marker}"`)
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
