import { useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { after, maskPhone } from '../simulator.js'

// Shown when the (simulated) duplicate check finds a likely match. It never
// says who matched or shows anything about the other registration.
export default function Duplicate({ go, details }) {
  const [state, setState] = useState('choose') // choose | sending | sent

  function requestReview() {
    setState('sending')
    after(900, () => setState('sent'))
  }

  if (state === 'sent') {
    return (
      <ScreenFrame title="Review requested">
        <p className="dim">
          A youth leader will check this and contact you on {maskPhone(details.phone)}, or you
          can see them in person. You won’t be able to vote until it’s sorted out, so nobody
          votes twice.
        </p>
        <p className="fineprint">Prototype: no request was actually sent.</p>
        <button type="button" className="btn primary" onClick={() => go('login')}>
          Done
        </button>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame title="We may already have you registered">
      <p className="dim">
        Your face check looks similar to an existing registration. This can happen if you
        registered before, or occasionally with family members who look alike.
      </p>
      <p className="dim">Nothing has been changed, and no details about anyone else are shown.</p>

      <div className="choiceList">
        <button type="button" className="choiceCard" onClick={() => go('recovery')}>
          <strong>I’ve registered before</strong>
          <span>Recover my voter code</span>
        </button>
        <button
          type="button"
          className="choiceCard"
          onClick={requestReview}
          disabled={state === 'sending'}
        >
          <strong>This is my first time</strong>
          <span>{state === 'sending' ? 'Sending…' : 'Ask a youth leader to review it'}</span>
        </button>
      </div>
    </ScreenFrame>
  )
}
