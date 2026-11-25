import { useEffect, useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { VERIFY_STEPS, after } from '../simulator.js'

// SIMULATED checks: each step is a timer. The outcome is whatever was picked
// in the prototype controls.
const FAIL_AT = { liveness_failed: 1, network: 2 }

export default function Verifying({ go, outcome, onResult }) {
  const [step, setStep] = useState(0)
  const [failed, setFailed] = useState(null)

  useEffect(() => {
    if (failed) return
    if (FAIL_AT[outcome] === step) {
      return after(1300, () => setFailed(outcome))
    }
    if (step >= VERIFY_STEPS.length) {
      return after(400, () => onResult(outcome === 'duplicate' ? 'duplicate' : 'approved'))
    }
    return after(1300, () => setStep((s) => s + 1))
  }, [step, failed, outcome, onResult])

  if (failed === 'liveness_failed') {
    return (
      <ScreenFrame title="We couldn’t complete the face check">
        <p className="dim">
          This usually means the light was too dim or the face moved out of the oval. Nothing
          has been saved.
        </p>
        <button type="button" className="btn primary" onClick={() => go('camera')}>
          Try again
        </button>
        <button type="button" className="btn ghost protoAlt" onClick={() => go('alternative')}>
          Register another way
        </button>
      </ScreenFrame>
    )
  }

  if (failed === 'network') {
    return (
      <ScreenFrame title="Connection lost">
        <p className="dim">
          We couldn’t confirm whether your registration went through. If you try again and see
          “We may already have you registered”, choose <strong>Recover my voter code</strong>.
        </p>
        <button type="button" className="btn primary" onClick={() => go('camera')}>
          Try again
        </button>
        <button type="button" className="btn ghost protoAlt" onClick={() => go('recovery')}>
          Recover my voter code
        </button>
      </ScreenFrame>
    )
  }

  return (
    <ScreenFrame title="Checking your registration" lead="This takes a few seconds. Please keep this page open.">
      <ol className="verifySteps" aria-live="polite">
        {VERIFY_STEPS.map((s, i) => {
          const state = i < step ? 'done' : i === step ? 'now' : 'todo'
          return (
            <li key={s.id} className={state}>
              <span className="verifyIcon" aria-hidden="true">
                {state === 'done' ? '✓' : state === 'now' ? <span className="spinner" /> : ''}
              </span>
              <span>
                {s.label}
                <span className="srOnly">
                  {state === 'done' ? ', done' : state === 'now' ? ', in progress' : ', waiting'}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </ScreenFrame>
  )
}
