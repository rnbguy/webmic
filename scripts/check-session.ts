import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'

// Run the real controller without Alpine's DOM startup or a network connection.
const built = await Bun.build({
  entrypoints: [new URL('../src/script.ts', import.meta.url).pathname],
  target: 'browser', format: 'iife',
  plugins: [{ name: 'controller-harness', setup(build) {
    build.onResolve({ filter: /^alpinejs$/ }, () => ({ path: 'alpine', namespace: 'harness' }))
    build.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({ contents: 'export default { start() {} }', loader: 'js' }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'text' }))
  } }]
})
assert.equal(built.success, true)
const code = await built.outputs[0].text()

function harness() {
  const contexts: { closed: boolean }[] = []
  const { promise: captured, resolve: resolveCapture } = Promise.withResolvers<unknown>()
  const listeners = new Map<string, () => void>()
  const location = new URL('https://example.test/webmic/')
  const window = {
    isSecureContext: true, AudioWorkletNode: class {},
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback) },
    removeEventListener(name: string) { listeners.delete(name) }
  } as any
  const navigator = {
    onLine: true,
    mediaDevices: { getUserMedia: () => captured },
    clipboard: { writeText: async () => { throw new Error('Clipboard denied') } }
  }
  const document = {
    baseURI: location.href, visibilityState: 'visible',
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}
  }
  class AudioContext {
    closed = false
    state = 'running'
    constructor() { contexts.push(this) }
    resume() { return Promise.resolve() }
    close() { this.closed = true; return Promise.resolve() }
  }
  runInNewContext(code, {
    window, navigator, document, location, AudioContext,
    history: { replaceState() {} }, URL, URLSearchParams, atob, btoa,
    console: { info() {}, debug() {}, error() {} }, setTimeout, clearTimeout,
    TextEncoder, TextDecoder, crypto
  })
  const app = window.webmic.root()
  const address = btoa(JSON.stringify({ id: 'test-address' })).replace(/=+$/, '')
  const link = `${location.href}#speaker=${address}&key=${'a'.repeat(64)}`
  return { app, navigator, contexts, resolveCapture, listeners, link }
}

{
  const { app } = harness()
  await app.toggle()
  assert.equal(app.active, false)
  assert.match(app.error, /Start the speaker/)
  app.invitation = 'https://other.test/webmic/#speaker=e30&key=' + 'a'.repeat(64)
  app.applyPairing()
  assert.equal(app.paired, false)
  assert.match(app.error, /Invalid pairing/)
}
{
  const { app, link, navigator } = harness()
  app.invitation = link
  app.applyPairing()
  assert.equal(app.paired, true)
  assert.equal(app.error, '')
  navigator.onLine = false
  await app.toggle()
  assert.equal(app.state, 'error')
  assert.equal(app.active, false)
  assert.match(app.error, /offline/)
}
{
  const { app, link, contexts, resolveCapture } = harness()
  app.invitation = link
  app.applyPairing()
  const starting = app.toggle()
  assert.equal(app.state, 'requesting')
  assert.equal(app.busy, true)
  await app.toggle()
  assert.equal(app.state, 'idle')
  let stopped = 0
  resolveCapture({ getTracks: () => [{ stop() { stopped++ } }] })
  await starting
  assert.equal(stopped, 1, 'Late permission grant must release its microphone after cancellation')
  assert.equal(contexts[0].closed, true)
  assert.equal(app.active, false)
  assert.equal(app.inputLevel, 0)
}
{
  const { app, link, contexts, resolveCapture } = harness()
  app.invitation = link
  app.applyPairing()
  const starting = app.toggle()
  app.setMode('speaker')
  let stopped = 0
  resolveCapture({ getTracks: () => [{ stop() { stopped++ } }] })
  await starting
  assert.equal(stopped, 1, 'Changing role must invalidate a pending permission grant')
  assert.equal(contexts[0].closed, true)
  assert.equal(app.mode, 'speaker')
  assert.equal(app.state, 'idle')
}
{
  const { app } = harness()
  app.state = 'connected'
  app.toggleHelp()
  assert.equal(app.state, 'connected', 'Help must not interrupt a live session')
  assert.equal(app.showHelp, true)
  app.toggleMute()
  assert.equal(app.state, 'muted')
  assert.equal(app.muted, true)
  app.toggleMute()
  assert.equal(app.state, 'connected')
  app.stop()
  assert.equal(app.muted, false)
  app.fail(new DOMException('denied', 'NotAllowedError'), 1)
  assert.match(app.error, /site settings/)
  assert.equal(app.state, 'error')
  app.fail(new Error('stale failure'), 0)
  assert.match(app.error, /site settings/, 'An obsolete asynchronous failure cannot replace the current error')
}
{
  const { app, listeners } = harness()
  app.init()
  app.state = 'waiting'
  listeners.get('offline')!()
  assert.equal(app.state, 'error')
  assert.match(app.error, /offline/)
  app.destroy()
  assert.equal(listeners.size, 0)
}
{
  const { app } = harness()
  app.state = 'waiting'
  app.pairingLink = 'https://example.test/webmic/#secret'
  await app.copyPairing()
  assert.equal(app.state, 'waiting', 'Clipboard denial must not stop pairing')
  assert.equal(app.pairingLink, 'https://example.test/webmic/#secret')
  assert.match(app.error, /Select and copy/)
}
console.info('Session checks passed: invalid links, offline recovery, cancellation, late permission, role changes, help, mute, stale errors, clipboard fallback')
