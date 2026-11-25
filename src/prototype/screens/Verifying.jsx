import { useEffect, useRef, useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { VERIFY_STEPS, after } from '../simulator.js'

// Shows progress while `task` (simulate + status check on the server) runs,
// then hands its result to onResult. The steps are display only: the
// outcome comes from the server's registration status.
export default function Verifying({ task, onResult }) {
  const [step, setStep] = useState(0)
  const [result, setResult] = useState(null)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    task().then(setResult)
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
      <p className="fineprint">Development: the result is simulated. No face comparison takes place.</p>
    </ScreenFrame>
  )
}
