import ScreenFrame from '../ScreenFrame.jsx'

// The no-face-scan route: in person, using the existing admin-issued voting
// codes (migration 001), which already work today.
export default function Alternative({ go }) {
  return (
    <ScreenFrame title="Register without a face scan" lead="You can still vote. It just takes a quick chat in person.">
      <ol className="altSteps">
        <li>
          <strong>Find a youth leader</strong>
          <span>At church or a YPM meeting.</span>
        </li>
        <li>
          <strong>They confirm who you are</strong>
          <span>The same way they would for any church event.</span>
        </li>
        <li>
          <strong>You get a voting code</strong>
          <span>Enter it on the voting page under “I have a voting code”. It works once.</span>
        </li>
      </ol>
      <p className="dim small">
        Choosing this doesn’t affect your vote in any way, and no face data is collected.
      </p>
      <button type="button" className="btn primary" onClick={() => go('login')}>
        Got it
      </button>
      <button type="button" className="linkBtn protoLink" onClick={() => go('consent')}>
        Back to the face check option
      </button>
    </ScreenFrame>
  )
}
