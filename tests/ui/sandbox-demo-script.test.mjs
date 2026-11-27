// The automated sandbox demonstration (npm run demo:sandbox) keeps working:
// duplicate-person detection (1:N), liveness, webhook refusals, deletion.
// Local only; synthetic fixture labels; no images.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../scripts/sandbox-demo.mjs', import.meta.url))

describe('automated sandbox demonstration', () => {
  it('runs every step as expected', () => {
    const r = spawnSync(process.execPath, [script, '--quiet'], { encoding: 'utf8', timeout: 240000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout, /SANDBOX DEMO PASSED/)
  })
})
