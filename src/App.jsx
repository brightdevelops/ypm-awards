import Vote from './pages/Vote.jsx'
import Admin from './pages/Admin.jsx'
import { configured } from './supabaseClient.js'

export default function App() {
  const isAdmin = window.location.pathname.replace(/\/+$/, '') === '/admin'

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
