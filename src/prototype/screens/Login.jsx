import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { DEMO_RETURNING, DEMO_SUBMITTED, after, normalizeVoterCode } from '../simulator.js'

const MAX_TRIES = 5

// Returning voters sign in with their voter code. No face scan.
export default function Login({ go, onReturning }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [fails, setFails] = useState(0)

  function submit(e) {
    e.preventDefault()
    if (busy) return
    setError('')

    const raw = code.replace(/[^A-Za-z0-9]/g, '')
    if (!raw) return setError('Enter your voter code.')
    // An admin-issued voting code has 10 characters and no "YPM" prefix.
    if (raw.length === 10 && !raw.toUpperCase().startsWith('YPM')) {
      return setError(
        'That looks like a voting code from a youth leader, not a voter code. Use it on the voting page under “I have a voting code”.',
      )
    }
    const normal = normalizeVoterCode(code)
    if (!normal) return setError('Voter codes look like YPM-ABCD-2345-HJKM. Check it and try again.')
    if (fails >= MAX_TRIES) return setError('Too many attempts. Please wait 15 minutes and try again.')

    setBusy(true)
    after(900, () => {
      setBusy(false)
      if (normal === DEMO_RETURNING.code) return onReturning(DEMO_RETURNING)
      if (normal === DEMO_SUBMITTED.code) return onReturning(DEMO_SUBMITTED)
      const n = fails + 1
      setFails(n)
      setError(
        n >= MAX_TRIES
          ? 'Too many attempts. Please wait 15 minutes and try again.'
          : 'We couldn’t find that voter code. Check it, or recover your code below.',
      )
    })
  }

  return (
    <ScreenFrame title="Welcome back" lead="Sign in with your voter code to continue voting.">
      <form className="form" onSubmit={submit} noValidate>
        <label>
          <span>Voter code</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="YPM-ABCD-2345-HJKM"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-describedby="login-help"
            aria-invalid={error ? true : undefined}
            className="codeInput"
          />
        </label>
        <p id="login-help" className="fineprint">
          You received this code when you registered. You won’t need to scan your face again.
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" disabled={busy}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
      </form>

      <div className="protoDivider" role="separator" />

      <button type="button" className="btn ghost" onClick={() => go('register')}>
        First time? Register to vote
      </button>
      <button type="button" className="linkBtn protoLink" onClick={() => go('recovery')}>
        Lost your voter code?
      </button>
    </ScreenFrame>
  )
}
