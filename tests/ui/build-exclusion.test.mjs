// The development voter flow, simulator and tester panel must not be in a
// production build. Builds into a temporary folder (dist/ is untouched).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))

describe('production build', () => {
  it('contains no part of the development voter flow', async () => {
    const out = mkdtempSync(join(tmpdir(), 'ypm-build-'))
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
      ]) {
        assert.ok(!text.includes(marker), `production bundle contains "${marker}"`)
      }
      // Sanity check: it is the real app.
      assert.ok(text.includes('admin_dashboard'))
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
