import { useCallback, useState } from 'react'
import './prototype.css'
import { Progress } from './ScreenFrame.jsx'
import { DEMO_RETURNING, DEMO_SUBMITTED, OUTCOMES, demoVoterCode } from './simulator.js'
import Login from './screens/Login.jsx'
import Register from './screens/Register.jsx'
import Consent from './screens/Consent.jsx'
import Camera from './screens/Camera.jsx'
import Verifying from './screens/Verifying.jsx'
import Success from './screens/Success.jsx'
import Duplicate from './screens/Duplicate.jsx'
import Recovery from './screens/Recovery.jsx'
import Alternative from './screens/Alternative.jsx'
import Welcome from './screens/Welcome.jsx'

// Phase 3.1 PROTOTYPE: screens only, every result simulated.
// Opened only from /prototype/voter in local development (see App.jsx).
// Nothing here touches the camera, the network, Supabase or browser storage.

const PROGRESS = { register: 0, consent: 1, camera: 2, verifying: 2, success: 3 }

export default function VoterPrototype() {
  const [screen, setScreen] = useState('login')
  const [details, setDetails] = useState({ name: '', phone: '' })
  const [outcome, setOutcome] = useState('approved')
  const [voterCode, setVoterCode] = useState(null) // show-once; cleared on leaving
  const [returning, setReturning] = useState(null)

  // Stable, so the screens' simulated timers aren't restarted by re-renders.
  const go = useCallback((next) => {
    if (next !== 'success') setVoterCode(null)
    if (next === 'login') {
      setDetails({ name: '', phone: '' })
      setReturning(null)
    }
    setScreen(next)
    window.scrollTo(0, 0)
  }, [])

  const verified = useCallback(
    (result) => {
      if (result === 'approved') {
        setVoterCode(demoVoterCode())
        go('success')
      } else if (result === 'duplicate') {
        go('duplicate')
      }
    },
    [go],
  )

  const props = { go, details, outcome }
  const screens = {
    login: (
      <Login
        go={go}
        onReturning={(voter) => {
          setReturning(voter)
          go('welcome')
        }}
      />
    ),
    register: <Register {...props} onSubmit={(d) => { setDetails(d); go('consent') }} />,
    consent: <Consent {...props} />,
    camera: <Camera {...props} />,
    verifying: <Verifying {...props} onResult={verified} />,
    success: <Success {...props} code={voterCode} />,
    duplicate: <Duplicate {...props} />,
    recovery: <Recovery {...props} />,
    alternative: <Alternative {...props} />,
    welcome: <Welcome go={go} voter={returning} />,
  }

  return (
    <div className="shell protoShell">
      <div className="protoBanner" role="note">
        <strong>Prototype</strong> · Simulated results · No camera is used. Nothing you enter is sent
        or saved. Use fictional details only.
      </div>

      <div className="inner">
        {screen in PROGRESS && <Progress current={PROGRESS[screen]} />}
        <div key={screen}>{screens[screen]}</div>
      </div>

      <details className="protoPanel">
        <summary>Prototype controls</summary>
        <fieldset>
          <legend>Result of the next face check</legend>
          {Object.entries(OUTCOMES).map(([id, label]) => (
            <label key={id}>
              <input
                type="radio"
                name="outcome"
                value={id}
                checked={outcome === id}
                onChange={() => setOutcome(id)}
              />
              {label}
            </label>
          ))}
        </fieldset>
        <p className="small dim">
          Returning voter: <code>{DEMO_RETURNING.code}</code> (unfinished ballot) or{' '}
          <code>{DEMO_SUBMITTED.code}</code> (already voted). Any other code is “not found”.
        </p>
        <button type="button" className="btn ghost small" onClick={() => go('login')}>
          Restart prototype
        </button>
      </details>
    </div>
  )
}
