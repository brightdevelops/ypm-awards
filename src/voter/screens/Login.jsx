import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { looksLikeVotingCode, normalizeVoterCode } from '../codes.js'

// Returning voters sign in with their voter code. No face scan.
const FACE_HELP = 'You received this code when you registered. You won’t need to scan your face again.'

export default function Login({ go, api, onSignedIn, message, help = FACE_HELP }) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setError('')

    if (!code.trim()) return setError('Enter your voter code.')
    if (looksLikeVotingCode(code)) {
      return setError(
        'That looks like a voting code from a youth leader, not a voter code. Use it on the voting page under “I have a voting code”.',
      )
    }
    const normal = normalizeVoterCode(code)
    if (!normal) return setError('Voter codes look like YPM-ABCD-2345-HJKM. Check it and try again.')

    setBusy(true)
    const r = await api.login(normal)
    setBusy(false)

    if (r.kind === 'failed') {
      return setError('Couldn’t reach the server. Check your connection and try again.')
    }
    if (r.status === 'ok') {
      setCode('')
      return onSignedIn({
        session: r.data.session,
        expiresAt: r.data.expires_at,
        firstName: r.data.first_name,
        ballot: r.data.ballot,
      })
    }
    if (r.status === 'rate_limited') return setError('Too many attempts. Please wait 15 minutes and try again.')
    if (r.status === 'disabled') {
      // 004: voter accounts are switched off for this database. Not a wrong code.
      return setError('Voter accounts aren’t available here. Vote on the main voting page instead.')
    }
    return setError('We couldn’t find that voter code. Check it, or recover your code below.')
  }

  return (
    <ScreenFrame title="Welcome back" lead="Sign in with your voter code to continue voting.">
      {message && (
        <p className="warnText small" role="status">
          {message}
        </p>
      )}
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
          {help}
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
