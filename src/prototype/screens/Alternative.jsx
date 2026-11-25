import ScreenFrame from '../ScreenFrame.jsx'

// The no-face-scan route: a youth leader registers the voter in person
// (admin_register_voter, migration 003) and hands over their voter code.
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
          <strong>You get your voter code</strong>
          <span>The same kind of code as online registration. Use it to sign in and vote.</span>
        </li>
      </ol>
      <p className="dim small">
        Choosing this doesn’t affect your vote in any way, and no face data is collected. If
        you already started voting with your phone number, the youth leader can attach that
        ballot to your account once they’ve confirmed it’s you.
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
