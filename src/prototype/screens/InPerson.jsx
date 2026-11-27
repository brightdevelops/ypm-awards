import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'

// Waiting for a youth leader to confirm the voter in person (Phase 5.1).
// The reference isn't secret: it only helps the leader find the request.
export default function InPerson({ reference, maskedPhone, expiresAt, onCheck, go }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function check() {
    setBusy(true)
    setMsg('')
    const m = await onCheck()
    setBusy(false)
    if (m) setMsg(m)
  }

  const until = expiresAt ? new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : null

  return (
    <ScreenFrame title="Show this to a youth leader" lead="They’ll check it’s you and give you your voter code.">
      <div className="voterCodeBox">
        <span className="srOnly">Your reference is </span>
        <span className="voterCode">{reference}</span>
        <span className="vcDemo">Reference{maskedPhone ? ` for ${maskedPhone}` : ''}</span>
      </div>
      <p className="dim small">
        Bring this phone. The leader gives you your voter code there and then; you use it to sign
        in and vote, like everyone else.{until ? ` This request stays open until ${until}.` : ''} If
        you close this page, the leader can still find your request by your name.
      </p>

      {msg && (
        <p className="dim small" role="status">
          {msg}
        </p>
      )}

      <button type="button" className="btn primary" onClick={check} disabled={busy}>
        {busy ? 'Checking…' : 'Has a leader confirmed me?'}
      </button>
      <button type="button" className="linkBtn protoLink" onClick={() => go('login')}>
        I have my voter code
      </button>
    </ScreenFrame>
  )
}
