// Simulated browser: the shared admin Dialog (src/components/admin/Dialog.jsx).
//
// Regression test for "Register in person does nothing" on the development
// server. React's StrictMode (development only) mounts, unmounts and
// remounts every component; the unmount calls dialog.close(), whose "close"
// event the browser delivers later, after the remount has opened the dialog
// again. Dialog took that stale event for the user closing it, so every
// dashboard dialog vanished as soon as it opened. Chrome shows this; happy-dom
// doesn't deliver the stale event by itself, so these tests send it the way
// Chrome does.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { installDom, startVite, mount, React, sleep, waitFor } from './dom-setup.mjs'

let vite
let Dialog
let win

before(async () => {
  win = installDom('http://localhost:5173/admin')
  vite = await startVite()
  Dialog = (await vite.ssrLoadModule('/src/components/admin/Dialog.jsx')).default
})
after(async () => {
  await vite?.close()
  await win?.happyDOM.close()
})

// Dialog inside StrictMode, as src/main.jsx renders the app.
function strict(props) {
  let closes = 0
  function Host() {
    return React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        Dialog,
        { title: 'Test dialog', onClose: () => { closes += 1 }, ...props },
        React.createElement('input', { 'data-autofocus': true }),
      ),
    )
  }
  const view = mount(Host)
  return { view, closes: () => closes }
}

// Waits until the dialog has mounted and opened (a fixed sleep was flaky
// when the whole suite runs in parallel).
const opened = (view) =>
  waitFor(() => {
    const d = view.host.querySelector('dialog')
    return d?.open ? d : null
  }, 'dialog open')

// What the browser does after dialog.close(): fire "close" (unless the test
// DOM already did).
async function closeNatively(el) {
  el.close()
  await sleep(20)
}

describe('admin Dialog', () => {
  it('stays open when a stale close event arrives after StrictMode remounts it', async () => {
    const { view, closes } = strict({})
    try {
      const el = await opened(view)
      assert.equal(el.open, true, 'opened')
      // The event queued by StrictMode's unmount, delivered after the remount.
      el.dispatchEvent(new window.Event('close'))
      await sleep(20)
      assert.equal(closes(), 0, 'onClose not called')
      assert.equal(el.open, true, 'still open')
    } finally {
      view.unmount()
    }
  })

  it('a real close still reaches the parent', async () => {
    const { view, closes } = strict({})
    try {
      const el = await opened(view)
      await closeNatively(el)
      if (closes() === 0) el.dispatchEvent(new window.Event('close'))
      await sleep(20)
      assert.equal(closes(), 1)
    } finally {
      view.unmount()
    }
  })

  it('Escape closes a dismissable dialog', async () => {
    const { view, closes } = strict({})
    try {
      const el = await opened(view)
      el.dispatchEvent(new window.Event('cancel', { cancelable: true }))
      await sleep(20)
      assert.equal(closes(), 1)
    } finally {
      view.unmount()
    }
  })

  it('a dialog that must not be dismissed (show-once code) reopens and stays', async () => {
    const { view, closes } = strict({ canDismiss: false })
    try {
      const el = await opened(view)
      el.dispatchEvent(new window.Event('cancel', { cancelable: true }))
      await sleep(20)
      assert.equal(el.open, true, 'Escape ignored')
      await closeNatively(el)
      if (!el.open) el.dispatchEvent(new window.Event('close'))
      await sleep(20)
      assert.equal(el.open, true, 'reopened')
      assert.equal(closes(), 0, 'onClose not called')
    } finally {
      view.unmount()
    }
  })
})
