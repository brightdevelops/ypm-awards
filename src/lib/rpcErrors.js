// True when the database doesn't have the function that was called (for
// example, a migration that isn't installed there). PostgREST reports
// PGRST202; Postgres itself reports 42883 (undefined_function).
export function isMissingFunction(err) {
  if (!err) return false
  return (
    err.code === 'PGRST202' ||
    err.code === '42883' ||
    /could not find the function|function .* does not exist/i.test(err.message || '')
  )
}

// How the admin dashboard reads a reply from supabase.rpc:
//   { kind: 'ok', res }          the server did it
//   { kind: 'unauthorized' }     the admin session isn't valid any more
//   { kind: 'unexpected', res }  the server answered and refused
//   { kind: 'network', missing } no usable reply (it may still have worked);
//                                missing: the database lacks the function
export function adminReply(res, err) {
  if (err) return { kind: 'network', missing: isMissingFunction(err) }
  if (res?.status === 'unauthorized') return { kind: 'unauthorized' }
  if (res?.status !== 'ok') return { kind: 'unexpected', res }
  return { kind: 'ok', res }
}
