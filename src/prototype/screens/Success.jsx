import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'

// Show-once voter code. It lives only in memory and is cleared as soon as
// this screen is left. Fictional in the prototype.
export default function Success({ go, details, code }) {
  const [saved, setSaved] = useState(false)
  const [copyMsg, setCopyMsg] = useState('')
  const first = details.name.split(/\s+/)[0] || 'there'

  if (!code) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopyMsg('Copied. Paste it somewhere private, such as your notes.')
    } catch {
      setCopyMsg('Copying didn’t work. Write the code down instead.')
    }
  }

  return (
    <ScreenFrame title={`You’re registered, ${first}`}>
      <p className="dim">This is your voter code. You’ll use it to sign in, instead of a face scan.</p>

      <div className="voterCodeBox">
        <span className="srOnly">Your voter code is </span>
        <span className="voterCode">{code}</span>
        <span className="vcDemo">Fictional code (prototype)</span>
      </div>

      <div className="callout warnBox" role="note">
        <strong>It will only be shown once.</strong> Write it down or save it now. Keep it to
        yourself: anyone with this code could sign in as you.
      </div>

      <button type="button" className="btn ghost" onClick={copy}>
        Copy code
      </button>
      {copyMsg && (
        <p className="dim small" role="status">
          {copyMsg}
        </p>
      )}

      <label className="protoCheck">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I’ve saved my voter code</span>
      </label>

      <button type="button" className="btn primary" disabled={!saved} onClick={() => go('login')}>
        Continue to my ballot
      </button>
      <p className="fineprint">Prototype: the ballot would open here. The code is now cleared.</p>
    </ScreenFrame>
  )
}
