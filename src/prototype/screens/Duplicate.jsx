import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'

// The registration is waiting for an admin review. In development this
// result was chosen by the tester: no faces were compared.
export default function Duplicate({ go, maskedPhone, onCheck }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function check() {
    setBusy(true)
    setMsg('')
    const m = await onCheck()
    setBusy(false)
    if (m) setMsg(m)
  }

  return (
    <ScreenFrame title="We may already have you registered">
      <p className="protoDraft" role="note">
        Development: this “possible duplicate” was chosen in the tester panel. It is not the
        result of any face comparison.
      </p>
      <p className="dim">
        Your registration looks similar to an existing one. This can happen if you registered
        before, or occasionally with family members who look alike.
      </p>
      <p className="dim">
        A youth leader will review it{maskedPhone ? ` and may contact you on ${maskedPhone}` : ''}.
        Nothing has been changed, and no details about anyone else are shown.
      </p>

      {msg && (
        <p className="dim small" role="status">
          {msg}
        </p>
      )}

      <div className="choiceList">
        <button type="button" className="choiceCard" onClick={check} disabled={busy}>
          <strong>Check my review</strong>
          <span>{busy ? 'Checking…' : 'See whether a youth leader has decided'}</span>
        </button>
        <button type="button" className="choiceCard" onClick={() => go('recovery')}>
          <strong>I’ve registered before</strong>
          <span>Recover my voter code</span>
        </button>
      </div>
    </ScreenFrame>
  )
}
