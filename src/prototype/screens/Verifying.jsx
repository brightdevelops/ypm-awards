import { useEffect, useRef, useState } from 'react'
import ScreenFrame from '../../voter/ScreenFrame.jsx'
import { VERIFY_STEPS, after } from '../simulator.js'

// Shows progress while `task` (simulated provider + status checks on the
// server) runs, then hands its result to onResult. The steps are display
// only: the outcome comes from the server's registration status. If the
// result is slow, says so; leaving the screen stops the checks.
export default function Verifying({ task, onResult }) {
  const [step, setStep] = useState(0)
  const [result, setResult] = useState(null)
  const [slow, setSlow] = useState(false)
  const started = useRef(false)
  const gone = useRef(false)

  useEffect(() => {
    gone.current = false
    if (!started.current) {
      started.current = true
      task({ onSlow: () => !gone.current && setSlow(true), isCancelled: () => gone.current }).then(
        (r) => !gone.current && setResult(r),
      )
    }
    return () => {
      gone.current = true
    }
  }, [task])

  useEffect(() => {
    if (step < VERIFY_STEPS.length) return after(1100, () => setStep((s) => s + 1))
    if (result) return after(300, () => onResult(result))
  }, [step, result, onResult])

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
      {slow && !result && (
        <p className="small" role="status">
          Still checking. This can take up to a minute. Please keep this page open.
        </p>
      )}
      <p className="fineprint">Development: the result is simulated. No face comparison takes place.</p>
    </ScreenFrame>
  )
}
