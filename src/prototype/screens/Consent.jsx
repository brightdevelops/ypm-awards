import { useState } from 'react'
import ScreenFrame from '../../voter/ScreenFrame.jsx'

// DRAFT wording for the prototype. It has not been reviewed against the
// NDPA 2023 / GAID 2025, no DPIA has been done, and the retention period is
// a proposal. It must be replaced by approved text before any real use.
// onAgree() starts the registration on the server and moves on; if it
// can't, it returns a message to show here.
export default function Consent({ go, onAgree }) {
  const [agree, setAgree] = useState(false)
  const [age, setAge] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    if (busy) return
    setError('')
    if (!age) return setError('Tell us whether you are 18 or older.')
    if (!agree) return setError('Tick the box to agree, or choose another way to register.')
    setBusy(true)
    const message = await onAgree()
    setBusy(false)
    if (message) setError(message)
  }

  return (
    <ScreenFrame title="Your face and your privacy" lead="Please read this before continuing.">
      <p className="protoDraft" role="note">
        Draft wording for review. Not yet approved by a legal or privacy adviser.
      </p>

      <div className="protoNotice" tabIndex={0} aria-label="Biometric privacy notice">
        <h2>What we would collect</h2>
        <p>
          A short face scan, turned into a numerical template, together with the name and phone
          number you entered.
        </p>
        <h2>Why</h2>
        <p>
          Only to stop the same person registering twice. It is not used for anything else, and
          it is never used to see how you voted.
        </p>
        <h2>Who can see it</h2>
        <p>
          No one sees your face scan. A small number of named organisers can see your name and
          masked phone number.
        </p>
        <h2>How long we keep it</h2>
        <p>
          Proposed: deleted 30 days after the results are announced. Your votes are kept
          separately and are not linked to your face.
        </p>
        <h2>Your choices</h2>
        <ul>
          <li>Saying no is fine. You can register in person with a youth leader instead.</li>
          <li>You can ask for your face data to be deleted at any time before then.</li>
          <li>Questions: contact the YPM organisers (contact details to be added).</li>
        </ul>
      </div>

      <form className="form" onSubmit={submit} noValidate>
        <fieldset className="protoChoice">
          <legend>Are you 18 or older?</legend>
          <label>
            <input type="radio" name="age" value="adult" checked={age === 'adult'} onChange={() => setAge('adult')} />
            Yes, I am 18 or older
          </label>
          <label>
            <input type="radio" name="age" value="minor" checked={age === 'minor'} onChange={() => setAge('minor')} />
            No, I am under 18
          </label>
        </fieldset>

        {age === 'minor' && (
          <div className="callout warnBox" role="note">
            Under-18s need a parent or guardian’s consent before any face scan. Until that process
            is in place, please register in person with a youth leader.
          </div>
        )}

        {age === 'adult' && (
          <label className="protoCheck">
            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I have read this notice and agree to a face scan for duplicate checking.</span>
          </label>
        )}

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        {age !== 'minor' && (
          <button className="btn primary" disabled={busy || (age === 'adult' && !agree)}>
            {busy ? 'Starting…' : 'I agree, continue'}
          </button>
        )}
      </form>

      <button type="button" className="btn ghost protoAlt" onClick={() => go('alternative')}>
        Register another way, without a face scan
      </button>
      <button type="button" className="linkBtn protoLink" onClick={() => go('register')}>
        Back
      </button>
    </ScreenFrame>
  )
}
