// DEVELOPMENT ONLY. The one place the connected voter flow touches Supabase.
import { supabase, configured } from '../supabaseClient.js'
import { createVoterApi } from './voterApi.js'

export { configured }
export const voterApi = createVoterApi((fn, args) => supabase.rpc(fn, args))
