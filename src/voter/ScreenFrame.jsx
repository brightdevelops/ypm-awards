import { useEffect, useRef } from 'react'

// One screen of the prototype. Focus moves to the heading when a screen
// opens, so screen-reader and keyboard users hear where they are.
export default function ScreenFrame({ eyebrow = 'YPM Youth Awards', title, lead, children }) {
  const ref = useRef(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])

  return (
    <section className="card protoCard" aria-labelledby="proto-screen-title">
      <p className="eyebrow">{eyebrow}</p>
      <h1 id="proto-screen-title" className="display" tabIndex={-1} ref={ref}>
        {title}
      </h1>
      {lead && <p className="dim">{lead}</p>}
      {children}
    </section>
  )
}

const STEPS = ['Your details', 'Consent', 'Face check', 'Voter code']

export function Progress({ current }) {
  return (
    <nav className="protoProgress" aria-label={`Registration, step ${current + 1} of ${STEPS.length}`}>
      <ol>
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={i < current ? 'done' : i === current ? 'now' : ''}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="protoStepNum" aria-hidden="true">
              {i < current ? '✓' : i + 1}
            </span>
            <span className="protoStepLabel">{s}</span>
          </li>
        ))}
      </ol>
    </nav>
  )
}
