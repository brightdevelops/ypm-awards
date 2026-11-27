// A throwaway PostgreSQL server for GENUINE concurrency tests.
//
// It creates its own data folder in the system temp directory, starts the
// server on a random port listening on 127.0.0.1 only (trust login, no
// password), and deletes everything when done. It never connects to any
// other server: no PG* environment variables are passed through, and
// every connection names 127.0.0.1 and this server's port explicitly.
//
// Needs PostgreSQL's programs (initdb, pg_ctl, psql). Found via
// YPM_PG_BIN, or common install locations. Without them the tests skip.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXE = process.platform === 'win32' ? '.exe' : ''

export function findPgBin() {
  const candidates = []
  if (process.env.YPM_PG_BIN) candidates.push(process.env.YPM_PG_BIN)
  if (process.platform === 'win32') {
    const base = 'C:/Program Files/PostgreSQL'
    if (existsSync(base)) {
      for (const v of readdirSync(base).sort((a, b) => Number(b) - Number(a))) candidates.push(`${base}/${v}/bin`)
    }
  } else {
    for (const base of ['/usr/lib/postgresql', '/opt/homebrew/opt']) {
      if (existsSync(base)) {
        for (const v of readdirSync(base).sort().reverse()) candidates.push(join(base, v, 'bin'))
      }
    }
    candidates.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  }
  return candidates.find((d) => ['initdb', 'pg_ctl', 'psql'].every((p) => existsSync(join(d, p + EXE)))) ?? null
}

// Children get a minimal environment: nothing that could point psql at
// another server or carry a password.
function cleanEnv() {
  const env = {}
  for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) {
    if (process.env[k]) env[k] = process.env[k]
  }
  env.PGCLIENTENCODING = 'UTF8'
  return env
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

// detached: for pg_ctl, which leaves the server running. On Windows the
// server would inherit our output pipes and this call would never return,
// so its output goes nowhere (pg_ctl writes to the server log instead).
function run(bin, args, { input, detached = false } = {}) {
  const r = spawnSync(bin, args, {
    input,
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    stdio: detached ? 'ignore' : 'pipe',
  })
  if (r.error) throw new Error(`${bin} ${args.join(' ')}: ${r.error.message}`)
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.join(' ')} failed (${r.status}):\n${r.stderr || r.stdout || ''}`)
  }
  return r.stdout ?? ''
}

export async function startCluster(binDir) {
  const dir = mkdtempSync(join(tmpdir(), 'ypm-pg-'))
  const data = join(dir, 'data')
  const port = await freePort()
  const tool = (n) => join(binDir, n + EXE)

  function stopAndDelete() {
    try {
      run(tool('pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { detached: true })
    } catch {
      /* wasn't running */
    }
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    run(tool('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'])
    run(tool('pg_ctl'), [
      '-D', data, '-l', join(dir, 'server.log'), '-w', '-t', '60',
      '-o', `-p ${port} -c listen_addresses=127.0.0.1 -c max_connections=60 -c fsync=off`,
      'start',
    ], { detached: true })
  } catch (e) {
    stopAndDelete()
    throw e
  }

  const conn = (db) => ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-At', '-h', '127.0.0.1', '-p', String(port), '-U', 'postgres', '-d', db]

  return {
    port,
    // Run SQL and return its output.
    psql(db, sqlText) {
      return run(tool('psql'), [...conn(db), '-f', '-'], { input: sqlText })
    },
    // Start SQL on its own connection; resolves with { code, out, err }.
    spawnPsql(db, sqlText) {
      return new Promise((resolve) => {
        const child = spawn(tool('psql'), [...conn(db), '-f', '-'], { env: cleanEnv() })
        const timer = setTimeout(() => child.kill(), 180000)
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (err += d))
        child.on('close', (code) => {
          clearTimeout(timer)
          resolve({ code, out, err })
        })
        child.stdin.end(sqlText)
      })
    },
    stop: stopAndDelete,
  }
}
