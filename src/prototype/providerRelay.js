// DEVELOPMENT ONLY (Phase 4). The simulated provider seen from the voter's
// page: start a check, relay the provider's deliveries to the public
// callback (playing the provider's network, exactly as a webhook would
// arrive), and wait for the registration status to change.
//
// The page never sees the signing key and can't alter a delivery without
// the server refusing it. The registration status is always the truth,
// whatever any single reply said.

// Picks up due deliveries and posts each one to the callback.
// Resolves to 'ok' | 'unauthorized' (tester session ended) | 'failed'.
export async function relayDue(api, adminSession) {
  const out = await api.providerOutbox(adminSession)
  if (out.kind === 'unauthorized') return 'unauthorized'
  if (out.kind !== 'answer' || out.status !== 'ok') return 'failed'
  for (const d of out.data.deliveries || []) {
    // The reply only says accepted or rejected; the status is checked next.
    await api.providerCallback(d.body, d.signature)
  }
  return 'ok'
}

const pause = (ms) => new Promise((res) => setTimeout(res, ms))

// Starts a simulated provider check and waits for its result, backing off
// between checks. Resolves to one of:
//   { type: 'status', status }   the registration left 'pending'
//   { type: 'still_pending' }    gave up waiting (nothing is lost; the
//                                voter can check again later)
//   { type: 'tester_needed' }    no valid tester session
//   { type: 'disabled' }         this database doesn't allow it
//   { type: 'cancelled' }        the screen was left
//
// With an external delivery (the sandbox vendor), nothing is relayed: the
// page opens a sandbox session, hands its reference to onExternal (for the
// tester to give the vendor script) and waits for the webhook's result.
export async function runProviderCheck({
  api, adminSession, token, outcome, reasonCode, delivery, timing, onSlow, onExternal, isCancelled = () => false,
}) {
  const started = delivery.external
    ? await api.sandboxStart(adminSession, token)
    : await api.providerStart(adminSession, token, outcome, reasonCode, delivery.delay, delivery.scenario)
  if (started.kind === 'unauthorized') return { type: 'tester_needed' }
  if (started.kind === 'answer' && started.status === 'disabled') return { type: 'disabled' }
  if (delivery.external && started.kind === 'answer' && started.data?.provider_ref) onExternal?.(started.data.provider_ref)
  const giveUpAfterMs = delivery.giveUpAfterMs ?? timing.giveUpAfterMs
  // Anything else (ok, "already running" after a reload, no reply): carry
  // on and let the status say what happened.

  const t0 = Date.now()
  let wait = timing.firstPollMs
  let slow = false
  for (;;) {
    await pause(wait)
    if (isCancelled()) return { type: 'cancelled' }
    if (!delivery.external && (await relayDue(api, adminSession)) === 'unauthorized') return { type: 'tester_needed' }
    const st = await api.status(token)
    if (st.kind === 'answer' && st.status !== 'pending') return { type: 'status', status: st.status }
    const elapsed = Date.now() - t0
    if (!slow && elapsed >= timing.slowAfterMs) {
      slow = true
      onSlow?.()
    }
    if (elapsed >= giveUpAfterMs) return { type: 'still_pending' }
    wait = Math.min(wait * 2, timing.maxPollMs)
  }
}
