import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'

// After signing in. ballot: { state: 'none' | 'in_progress' | 'submitted', answered }
// (from voter_login), or null after a page reload.
export default function Welcome({ firstName, ballot, total, onOpenBallot, onLogout }) {
  const [busy, setBusy] = useState(false)

  async function open() {
    setBusy(true)
    await onOpenBallot()
    setBusy(false)
  }

  if (ballot?.state === 'submitted') {
    return (
      <ScreenFrame title={`You’ve already voted, ${firstName}`}>
        <p className="dim">
          Each registered voter can submit one ballot, and yours is in. Thank you for taking part.
        </p>
        <button type="button" className="btn primary" onClick={onLogout}>
          Sign out
        </button>
      </ScreenFrame>
    )
  }

  const answered = ballot?.answered ?? 0
  return (
    <ScreenFrame title={`Welcome${firstName ? `, ${firstName}` : ''}`}>
      {ballot?.state === 'in_progress' ? (
        <>
          <p className="dim">
            You have an unfinished ballot: {answered} of {total} categories answered.
          </p>
          <div className="progressBar protoInlineBar" aria-hidden="true">
            <div className="progressFill" style={{ width: `${(answered / total) * 100}%` }} />
          </div>
        </>
      ) : (
        <p className="dim">You’re signed in. Your ballot has {total} categories.</p>
      )}
      <button type="button" className="btn primary" onClick={open} disabled={busy}>
        {busy ? 'Opening…' : ballot?.state === 'in_progress' ? 'Resume my ballot' : 'Open my ballot'}
      </button>
      <button type="button" className="linkBtn protoLink" onClick={onLogout}>
        Sign out
      </button>
    </ScreenFrame>
  )
}
