// Shared setup for the simulated-browser tests (happy-dom, pinned in
// package.json). The real React components are loaded through Vite and
// rendered into a happy-dom window; the Supabase client is replaced by a
// stand-in that sends each call to a PGlite test database.
//
// happy-dom is used only to render our own components: page JavaScript
// evaluation, script/CSS/iframe loading and navigation are all off, and
// nothing is fetched from the network.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { createServer } from 'vite'
import { call } from '../../db/helpers.mjs'

export const root = fileURLToPath(new URL('../../../', import.meta.url))
const req = createRequire(root + 'package.json')
export const React = req('react')
// react-dom decides at load time what the "browser" supports (for example
// the input event), so it must only be loaded after installDom().
let createRoot = null

const GLOBALS = [
  'window', 'document', 'navigator', 'Node', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
  'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'localStorage', 'sessionStorage',
]

export function installDom(url = 'http://localhost:5173/') {
  const win = new Window({
    url,
    settings: {
      disableJavaScriptFileLoading: true,
      disableComputedStyleRendering: true,
      navigation: {
        disableMainFrameNavigation: true,
        disableChildFrameNavigation: true,
        disableChildPageNavigation: true,
      },
    },
  })
  for (const k of GLOBALS) {
    Object.defineProperty(globalThis, k, {
      value: k === 'window' ? win : win[k],
      configurable: true,
      writable: true,
    })
  }
  createRoot = req('react-dom/client').createRoot
  return win
}

// The browser's supabase client, replaced: every rpc goes to globalThis.__ypmRpc.
const stubSupabase = {
  name: 'ypm-test-supabase',
  enforce: 'pre',
  resolveId(id) {
    if (id.endsWith('supabaseClient.js')) return '\0ypm-test-supabase'
    return null
  },
  load(id) {
    if (id !== '\0ypm-test-supabase') return null
    return `export const configured = true
      export const supabase = { rpc: (fn, args) => globalThis.__ypmRpc(fn, args) }`
  },
}

export async function startVite() {
  return createServer({
    root,
    logLevel: 'error',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
    plugins: [stubSupabase],
  })
}

// supabase.rpc played by a test database. `override(fn, args)` may return a
// reply (e.g. a network error) instead of asking the database.
export function setRpc(db, override) {
  globalThis.__ypmRpc = async (fn, args = {}) => {
    const forced = override ? await override(fn, args) : undefined
    if (forced !== undefined) return forced
    try {
      return { data: await call(db, fn, args), error: null }
    } catch (error) {
      return { data: null, error: { message: error.message, code: error.code } }
    }
  }
}

export function mount(Component, props = {}) {
  if (!createRoot) throw new Error('Call installDom() before mount().')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(Component, props))
  return {
    host,
    unmount() {
      root.unmount()
      host.remove()
    },
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const text = (el = document.body) => el.textContent

export async function waitFor(check, what, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = check()
    if (v) return v
    await sleep(15)
  }
  const open = document.querySelector('dialog[open]')
  throw new Error(
    `Timed out waiting for: ${what}\n--- ${open ? 'open dialog' : 'page'} ---\n` +
      (open ? open.textContent : text()).slice(0, 2500),
  )
}

export function buttons(scope = document) {
  return [...scope.querySelectorAll('button')]
}

export function button(label, scope = document) {
  return buttons(scope).find(
    (b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label,
  )
}

export function dialog() {
  return document.querySelector('dialog[open]')
}

export function typeInto(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

// Tick every checkbox in the open dialog (in order), then let React settle.
export async function tickAll(scope = dialog()) {
  for (const box of scope.querySelectorAll('input[type=checkbox]')) {
    if (!box.checked) box.click()
  }
  await sleep(20)
}
