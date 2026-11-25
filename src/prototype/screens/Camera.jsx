import { useEffect, useState } from 'react'
import ScreenFrame from '../ScreenFrame.jsx'
import { LIVENESS_PROMPTS, after } from '../simulator.js'

const TIPS = [
  'Face a light source. Avoid bright light behind you.',
  'Remove sunglasses, hats or face coverings.',
  'Hold your phone at eye level, about an arm’s length away.',
  'Fit your face inside the oval, with only you in the frame.',
]

// SIMULATED camera. This screen never asks for the camera and records
// nothing: the "viewfinder" is a drawing, and the prompts run on a timer.
export default function Camera({ go, outcome }) {
  const [phase, setPhase] = useState('guide') // guide | starting | prompts | denied
  const [prompt, setPrompt] = useState(0)

  useEffect(() => {
    if (phase === 'starting') {
      return after(900, () => setPhase(outcome === 'camera_denied' ? 'denied' : 'prompts'))
    }
    if (phase === 'prompts') {
      if (prompt >= LIVENESS_PROMPTS.length) return after(400, () => go('verifying'))
      return after(1500, () => setPrompt((p) => p + 1))
    }
  }, [phase, prompt, outcome, go])

  if (phase === 'denied') {
    return (
      <ScreenFrame title="Camera access is off">
        <p className="dim">
          The face check needs your camera. To turn it on, open your browser’s site settings for
          this page, allow the camera, then try again.
        </p>
        <button type="button" className="btn primary" onClick={() => setPhase('guide')}>
          Try again
        </button>
        <button type="button" className="btn ghost protoAlt" onClick={() => go('alternative')}>
          Register another way
        </button>
      </ScreenFrame>
    )
  }

  const active = phase === 'prompts'
  const current = LIVENESS_PROMPTS[Math.min(prompt, LIVENESS_PROMPTS.length - 1)]

  return (
    <ScreenFrame title="Face check" lead="We’ll ask you to make a few small movements.">
      <div className={`viewfinder${active ? ' live' : ''}`} aria-hidden="true">
        <svg viewBox="0 0 200 240" className="vfSvg">
          <defs>
            <mask id="vf-oval">
              <rect width="200" height="240" fill="white" />
              <ellipse cx="100" cy="112" rx="64" ry="84" fill="black" />
            </mask>
          </defs>
          <rect width="200" height="240" className="vfShade" mask="url(#vf-oval)" />
          <ellipse cx="100" cy="112" rx="64" ry="84" className="vfOval" />
          <circle cx="100" cy="98" r="30" className="vfHead" />
          <path d="M52 196 C60 158 140 158 148 196" className="vfHead" />
        </svg>
        <span className="vfTag">Simulated camera · nothing recorded</span>
        {active && <span className="vfScan" />}
      </div>

      <p className="protoPrompt" role="status" aria-live="assertive">
        {phase === 'guide' && 'Ready when you are.'}
        {phase === 'starting' && 'Starting camera…'}
        {active && (prompt < LIVENESS_PROMPTS.length ? current : 'Hold still…')}
      </p>

      {phase === 'guide' && (
        <>
          <ul className="protoTips">
            {TIPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
          <button type="button" className="btn primary" onClick={() => setPhase('starting')}>
            Start face check
          </button>
        </>
      )}

      {phase !== 'guide' && (
        <button
          type="button"
          className="btn ghost"
          onClick={() => {
            setPrompt(0)
            setPhase('guide')
          }}
        >
          Cancel
        </button>
      )}

      <button type="button" className="linkBtn protoLink" onClick={() => go('alternative')}>
        Having trouble? Register another way
      </button>
    </ScreenFrame>
  )
}
