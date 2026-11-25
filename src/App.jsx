import { Suspense, lazy } from 'react'
import Vote from './pages/Vote.jsx'
import Admin from './pages/Admin.jsx'
import { configured } from './supabaseClient.js'

// Phase 3.1 voter-registration PROTOTYPE (simulated, no camera, no data).
// Only in local development (`npm run dev`). In a production build this is
// false, so the prototype is never reachable and its code isn't bundled.
const VoterPrototype = import.meta.env.DEV
  ? lazy(() => import('./prototype/VoterPrototype.jsx'))
  : null

export default function App() {
  // Both doors show the same dashboard; each has its own key (see admin_keys).
  const path = window.location.pathname.replace(/\/+$/, '')
  const isAdmin = path === '/admin' || path === '/inventor'

  if (VoterPrototype && path === '/prototype/voter') {
    return (
      <Suspense fallback={<div className="shell"><div className="card center dim">Loading…</div></div>}>
        <VoterPrototype />
      </Suspense>
    )
  }

  if (!configured) {
    return (
      <div className="shell">
        <div className="card notice">
          <h2>Setup needed</h2>
          <p>
            Supabase keys are missing. Add <code>VITE_SUPABASE_URL</code> and{' '}
            <code>VITE_SUPABASE_ANON_KEY</code> as environment variables, then redeploy.
          </p>
        </div>
      </div>
    )
  }

  return isAdmin ? <Admin /> : <Vote />
}
