import ScreenFrame from '../ScreenFrame.jsx'

// A message with one or more actions: used for every outcome that isn't a
// screen of its own (needs help, expired, couldn't confirm, and so on).
//   actions: [{ label, onClick, primary }]
export default function Notice({ title, body, note, actions = [], tone }) {
  return (
    <ScreenFrame title={title}>
      {(Array.isArray(body) ? body : [body]).filter(Boolean).map((p, i) => (
        <p className="dim" key={i}>
          {p}
        </p>
      ))}
      {note && (
        <div className={`callout ${tone === 'warn' ? 'warnBox' : 'infoBox'}`} role="note">
          {note}
        </div>
      )}
      {actions.map((a, i) => (
        <button
          key={a.label}
          type="button"
          className={a.primary || (i === 0 && !actions.some((x) => x.primary)) ? 'btn primary' : 'btn ghost protoAlt'}
          onClick={a.onClick}
          disabled={a.disabled}
        >
          {a.label}
        </button>
      ))}
    </ScreenFrame>
  )
}
