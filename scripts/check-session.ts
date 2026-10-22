import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { PACKET_BYTES } from '../src/audio-format'
import type { ControllerFactory } from '../src/script'

type CapturedStream = { track: Track, getTracks(): Track[], getAudioTracks(): Track[] }
type ScreenLock = { released: boolean, release(): Promise<void> }

// Replace only browser/import boundaries; exercise the actual registered controller.
const built = await Bun.build({
  entrypoints: [new URL('../src/script.ts', import.meta.url).pathname],
  target: 'browser', format: 'iife',
  define: {
    'import.meta.url': JSON.stringify(new URL('../src/script.ts', import.meta.url).href),
    __TRANSPORT_PATH__: JSON.stringify('../transport/test/webmic_transport.js')
  },
  plugins: [{ name: 'controller-harness', setup(build) {
    build.onResolve({ filter: /^@alpinejs\/csp$/ }, () => ({ path: 'alpine', namespace: 'harness' }))
    build.onResolve({ filter: /^qrcode$/ }, () => ({ path: 'qr', namespace: 'harness' }))
    build.onLoad({ filter: /.*/, namespace: 'harness' }, ({ path }) => ({
      contents: path == 'alpine'
        ? 'export default { data(name, root) { window.registered = { name, root } }, start() {}, nextTick(callback) { return Promise.resolve().then(callback) } }'
        : 'export default { async toDataURL() { return "data:image/png;base64,AA" } }',
      loader: 'js'
    }))
    build.onLoad({ filter: /\/src\/script\.ts$/ }, async ({ path }) => ({
      // VM dynamic imports need a host loader; leave loadTransport caching/error handling intact.
      contents: (await Bun.file(path).text()).replace('import(url)', 'globalThis.__testTransport(url)'), loader: 'ts'
    }))
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'text' }))
  } }]
})
assert.equal(built.success, true)
const code = await built.outputs[0].text()

class Track {
  enabled = true
  muted = false
  stops = 0
  onended: (() => void) | null = null
  onmute: (() => void) | null = null
  onunmute: (() => void) | null = null
  getSettings() { return { echoCancellation: true, noiseSuppression: true } }
  stop() { this.stops++ }
}
function capture(track = new Track()): CapturedStream {
  return { track, getTracks: () => [track], getAudioTracks: () => [track] }
}
async function until(ready: () => boolean) {
  for (let turn = 0; turn < 30 && !ready(); turn++) await Promise.resolve()
  assert.equal(ready(), true, 'Controller must reach the expected deterministic stage')
}
function harness(options: { moduleError?: boolean, transportError?: boolean, deferEndpoint?: boolean } = {}) {
  const contexts: AudioContext[] = []
  const processors: AudioWorkletNode[] = []
  const captures: PromiseWithResolvers<CapturedStream>[] = []
  const listeners = new Map<string, () => void>()
  const documentListeners = new Map<string, () => void>()
  const timers = new Map<number, () => void>()
  const frames: (() => void)[] = []
  const wakeRequests: PromiseWithResolvers<ScreenLock>[] = []
  const incoming: PromiseWithResolvers<Uint8Array>[] = []
  const peer = Promise.withResolvers<typeof connection>()
  const opened = Promise.withResolvers<typeof endpoint>()
  let now = 0
  let timerId = 0
  let reloads = 0
  let imports = 0
  let endpointCalls = 0
  let focused = ''
  let replaced = ''
  const location = Object.assign(new URL('https://example.test/webmic/'), { reload() { reloads++ } })
  const nodes = new Map(['speaker', 'microphone', 'invitation', 'help-toggle', 'help-panel', 'expand-pairing', 'collapse-pairing', 'session-toggle'].map(id => [id, {
    checked: id == 'speaker', focus() { focused = id }
  }]))
  const connection = {
    label: 'Other browser', closed: 0, sent: [] as Uint8Array[],
    close() { this.closed++ },
    send(packet: Uint8Array) { this.sent.push(packet) },
    receive() { const packet = Promise.withResolvers<Uint8Array>(); incoming.push(packet); return packet.promise }
  }
  const endpoint = {
    closed: 0, accepts: [] as string[][], connects: [] as string[][],
    address() { return JSON.stringify({ id: 'speaker' }) },
    close() { this.closed++ },
    accept(...args: string[]) { this.accepts.push(args); return peer.promise },
    connect(...args: string[]) { this.connects.push(args); return peer.promise }
  }
  const window = {
    registered: undefined as { name: string, root: ControllerFactory } | undefined,
    webmic: undefined as unknown,
    AudioWorkletNode: undefined as typeof AudioWorkletNode | undefined,
    isSecureContext: true, innerHeight: 844, visualViewport: null,
    addEventListener(name: string, callback: () => void) { listeners.set(name, callback) },
    removeEventListener(name: string) { listeners.delete(name) },
    setInterval(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id },
    clearInterval(id: number) { timers.delete(id) }
  }
  const navigator = {
    onLine: true,
    mediaDevices: { getUserMedia() { const request = Promise.withResolvers<CapturedStream>(); captures.push(request); return request.promise } },
    clipboard: { writeText: async (_text: string): Promise<void> => { throw new Error('Clipboard denied') } },
    wakeLock: { request() { const request = Promise.withResolvers<ScreenLock>(); wakeRequests.push(request); return request.promise } }
  }
  const document = {
    baseURI: location.href, visibilityState: 'visible',
    get activeElement() { return nodes.get(focused) },
    documentElement: { style: { setProperty() {} } },
    getElementById(id: string) { return nodes.get(id) },
    querySelectorAll: () => [],
    addEventListener(name: string, callback: () => void) { documentListeners.set(name, callback) },
    removeEventListener(name: string) { documentListeners.delete(name) }
  }
  class AudioContext {
    closed = false
    state = 'running'
    currentTime = 0
    sampleRate = 24000
    destination = {}
    onstatechange: (() => void) | null = null
    audioWorklet = { addModule: async () => { if (options.moduleError) throw new Error('Missing worklet') } }
    constructor() { contexts.push(this) }
    resume() { return Promise.resolve() }
    close() { this.closed = true; return Promise.resolve() }
    createGain() { return { gain: { value: 1, setTargetAtTime() {} }, connect() {}, disconnect() {} } }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  }
  class AudioWorkletNode {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null as (() => void) | null,
      messages: [] as ArrayBuffer[], closed: false,
      postMessage(buffer: ArrayBuffer) { this.messages.push(buffer) },
      close() { this.closed = true }
    }
    onprocessorerror: (() => void) | null = null
    constructor(_context: AudioContext, readonly name: string) { processors.push(this) }
    connect() {}
    disconnect() {}
  }
  window.AudioWorkletNode = AudioWorkletNode
  runInNewContext(code, {
    window, navigator, document, location, AudioContext, AudioWorkletNode,
    history: { replaceState(_state: unknown, _unused: string, url: string) { replaced = url } },
    URL, URLSearchParams, atob, btoa, performance: { now: () => now },
    requestAnimationFrame(callback: () => void) { frames.push(callback) },
    console: { info() {}, debug() {}, error() {} }, setTimeout, clearTimeout,
    TextEncoder, TextDecoder, crypto,
    async __testTransport() {
      imports++
      if (options.transportError) throw new Error('Missing transport')
      return { default: async () => {}, AudioEndpoint: { create() { endpointCalls++; return options.deferEndpoint ? opened.promise : Promise.resolve(endpoint) } } }
    }
  })
  const app = window.registered!.root()
  app.setMode('microphone')
  const address = btoa(JSON.stringify({ id: 'test-address' })).replace(/=+$/, '')
  const link = `${location.href}#speaker=${address}&key=${'a'.repeat(64)}`
  function pair() { app.invitation = link; app.applyPairing() }
  return {
    app, navigator, document, contexts, processors, captures, listeners, documentListeners, timers, frames,
    nodes, peer, opened, endpoint, connection, incoming, wakeRequests, link, pair,
    get focused() { return focused }, get replaced() { return replaced }, get reloads() { return reloads },
    get imports() { return imports }, get endpointCalls() { return endpointCalls },
    tick(milliseconds: number) { now += milliseconds; for (const callback of timers.values()) callback() }
  }
}

{
  const h = harness()
  assert.equal(h.app.primaryLabel, 'Pair with speaker')
  assert.equal(h.app.statusHeading, 'Not paired')
  await h.app.primaryAction()
  assert.equal(h.focused, 'invitation')
  assert.equal(h.contexts.length, 0, 'Pairing action must not request media or contact relays')
  h.app.invitation = 'https://other.test/webmic/#speaker=e30&key=' + 'a'.repeat(64)
  h.app.applyPairing()
  assert.equal(h.app.paired, false)
  assert.equal(h.app.pairingInvalid, true)
  assert.match(h.app.error, /Invalid pairing/)
  h.pair()
  assert.equal(h.app.paired, true)
  assert.equal(h.app.primaryLabel, 'Start microphone')
  assert.equal(h.app.statusHeading, 'Ready to connect')
  assert.equal(h.replaced, '/webmic/', 'Pairing secrets must leave the URL')
}
{
  const h = harness()
  h.app.init()
  h.pair()
  h.navigator.onLine = false
  h.listeners.get('offline')!()
  const starting = h.app.primaryAction()
  assert.equal(h.app.state, 'requesting', 'Offline hints must not block a real setup attempt')
  assert.equal(h.app.primaryLabel, 'Cancel setup')
  assert.match(h.app.networkWarning, /reports offline/)
  h.captures[0].reject(new DOMException('denied', 'NotAllowedError'))
  await starting
  assert.equal(h.app.state, 'error')
  assert.match(h.app.error, /Microphone access was denied/)
  assert.equal(h.app.primaryLabel, 'Retry microphone')
  assert.equal(h.app.paired, true, 'Permission denial keeps a valid pairing for retry')
  assert.equal(h.contexts[0].closed, true)
  h.navigator.onLine = true
  h.listeners.get('online')!()
  assert.equal(h.app.networkWarning, '')
  h.app.destroy()
  assert.equal(h.listeners.size + h.documentListeners.size, 0)
}
{
  const h = harness()
  h.pair()
  const oldStart = h.app.primaryAction()
  await h.app.primaryAction()
  const newStart = h.app.primaryAction()
  const staleCapture = capture()
  h.captures[0].resolve(staleCapture)
  await oldStart
  assert.equal(staleCapture.track.stops, 1, 'A late permission grant releases only its own stream')
  assert.equal(h.app.state, 'requesting', 'Old permission events must not alter the replacement session')
  assert.equal(h.contexts[0].closed, true)
  assert.equal(h.contexts[1].closed, false)
  h.captures[1].reject(new DOMException('new denial', 'NotAllowedError'))
  await newStart
  assert.match(h.app.error, /Microphone access was denied/)
}
{
  const h = harness()
  h.pair()
  const starting = h.app.primaryAction()
  h.app.setMode('speaker')
  const late = capture()
  h.captures[0].resolve(late)
  await starting
  assert.equal(late.track.stops, 1, 'Role changes invalidate pending permissions')
  assert.equal(h.app.mode, 'speaker')
  h.nodes.get('speaker')!.checked = false
  h.nodes.get('microphone')!.checked = true
  h.app.setMode('speaker')
  assert.equal(h.nodes.get('speaker')!.checked, true, 'Same-mode sync repairs native dirty radio properties')
  assert.equal(h.nodes.get('microphone')!.checked, false)
}
{
  const h = harness()
  h.pair()
  const starting = h.app.primaryAction()
  await h.app.primaryAction()
  h.captures[0].reject(new DOMException('late denial', 'NotAllowedError'))
  await starting
  assert.equal(h.app.state, 'idle')
  assert.equal(h.app.error, '', 'Stale permission errors cannot replace cancellation')
  h.app.toggleHelp()
  await until(() => h.frames.length > 0)
  h.frames.shift()!()
  assert.equal(h.focused, 'help-panel')
  h.app.dismissPanel()
  assert.equal(h.focused, 'help-toggle')
  assert.equal(h.app.showHelp, false)
  h.app.toggleHelp()
  h.app.dismissPanel()
  await Promise.resolve()
  for (const frame of h.frames) frame()
  assert.equal(h.focused, 'help-toggle', 'A stale Help focus callback must not reopen focus')
}
for (const failure of ['moduleError', 'transportError'] as const) {
  const h = harness({ [failure]: true })
  h.app.setMode('speaker')
  await h.app.primaryAction()
  assert.equal(h.app.state, 'error')
  assert.equal(h.app.primaryLabel, 'Reload app')
  assert.match(h.app.error, /App files could not load/)
  assert.equal(h.contexts[0].closed, true)
  await h.app.primaryAction()
  assert.equal(h.reloads, 1)
}
{
  const h = harness({ deferEndpoint: true })
  h.app.setMode('speaker')
  const starting = h.app.primaryAction()
  await until(() => h.endpointCalls == 1)
  h.app.endSession()
  h.opened.resolve(h.endpoint)
  await starting
  assert.equal(h.endpoint.closed, 1, 'Endpoints created after cancellation must close')
  assert.equal(h.endpoint.accepts.length, 0)
  assert.equal(h.app.state, 'idle')
}
{
  const h = harness()
  h.app.init()
  h.app.setMode('speaker')
  const starting = h.app.primaryAction()
  await until(() => h.app.state == 'waiting')
  assert.equal(h.app.primaryLabel, 'Stop speaker')
  assert.equal(h.wakeRequests.length, 1, 'Pairing QR waiting already requests screen wake lock')
  h.documentListeners.get('visibilitychange')!()
  h.documentListeners.get('visibilitychange')!()
  assert.equal(h.wakeRequests.length, 1, 'A pending lock request is single-flight')
  h.app.showPairingQr()
  h.app.showPairingQr()
  assert.equal(h.app.pairingExpanded, true)
  h.app.endSession()
  assert.equal(h.app.pairingExpanded, false)
  h.peer.resolve(h.connection)
  let releases = 0
  h.wakeRequests[0].resolve({ released: false, async release() { releases++ } })
  await starting
  await until(() => releases == 1)
  assert.equal(h.connection.closed, 1, 'Connections accepted after cancel must close')
  assert.equal(h.app.state, 'idle')
  assert.equal(h.timers.size, 0)
  h.app.destroy()
}
{
  const h = harness()
  h.app.init()
  h.app.setMode('speaker')
  const starting = h.app.primaryAction()
  await until(() => h.app.state == 'waiting')
  h.app.showPairingQr()
  await until(() => h.frames.length > 0)
  h.frames.shift()!()
  h.peer.resolve(h.connection)
  await until(() => h.incoming.length == 1)
  assert.equal(h.app.pairingExpanded, false, 'Successful pairing returns the workspace to audio controls')
  await until(() => h.frames.length > 0)
  h.frames.shift()!()
  assert.equal(h.focused, 'session-toggle', 'Automatic QR collapse restores focus to the visible session control')
  assert.equal(h.app.statusHeading, 'Connected - waiting for audio')
  const staleTimer = [...h.timers.values()][0]
  h.tick(999)
  assert.equal(h.app.receiveHealth, 'awaiting-audio')
  h.tick(1)
  assert.equal(h.app.receiveHealth, 'stalled')
  assert.equal(h.app.statusTone, 'warning')
  h.incoming[0].resolve(new Uint8Array(PACKET_BYTES))
  await until(() => h.incoming.length == 2)
  assert.equal(h.app.receiveHealth, 'receiving', 'Valid frames recover health without reconnecting')
  assert.equal(h.app.statusHeading, 'Receiving audio')
  assert.equal(h.app.statusTone, 'live')
  const onmessage = h.processors[0].port.onmessage!
  onmessage({ data: { stats: { gaps: 2, late: 3, underruns: 4, queuedMs: 20, level: 0.5 } } })
  assert.equal(h.app.playbackStats.gaps, 2)
  assert.equal(h.app.playbackStats.level, 0.5)
  h.navigator.onLine = false
  h.listeners.get('offline')!()
  assert.equal(h.app.state, 'connected', 'An offline hint must not kill a healthy transport')
  h.tick(1000)
  assert.equal(h.app.receiveHealth, 'stalled')
  assert.equal(h.connection.closed, 0, 'Receive health is advisory, not a transport timeout')
  h.app.endSession()
  staleTimer()
  onmessage({ data: { stats: { gaps: 99, level: 1 } } })
  h.incoming[1].resolve(new Uint8Array(PACKET_BYTES))
  await starting
  assert.equal(h.app.receiveHealth, 'awaiting-audio')
  assert.equal(h.app.playbackStats.gaps, 0, 'Old worklet reports cannot mutate a stopped session')
  assert.equal(h.processors[0].port.messages.length, 1, 'Old transport packets cannot reach the closed worklet')
  assert.equal(h.timers.size, 0)
  h.app.destroy()
}
{
  const h = harness()
  h.pair()
  const starting = h.app.primaryAction()
  const live = capture()
  h.captures[0].resolve(live)
  await until(() => h.endpoint.connects.length == 1)
  h.peer.resolve(h.connection)
  await until(() => h.incoming.length == 1)
  const oldMute = live.track.onmute!
  const oldEnded = live.track.onended!
  live.track.muted = true
  oldMute()
  assert.equal(h.app.sourceInterrupted, true)
  assert.equal(h.app.statusHeading, 'Microphone interrupted')
  assert.equal(h.app.statusTone, 'warning')
  assert.equal(h.connection.closed, 0, 'Temporary source mute keeps the transport open')
  await h.app.primaryAction()
  assert.equal(h.app.primaryLabel, 'Unmute microphone')
  assert.equal(live.track.enabled, false)
  assert.equal(h.app.sourceInterrupted, true, 'Own mute must not overwrite source interruption')
  live.track.muted = false
  live.track.onunmute!()
  assert.equal(h.app.state, 'muted')
  assert.equal(h.app.sourceInterrupted, false)
  await h.app.primaryAction()
  assert.equal(live.track.enabled, true)
  assert.equal(h.app.primaryLabel, 'Mute microphone')
  const onmessage = h.processors[0].port.onmessage!
  h.contexts[0].currentTime = 1
  onmessage({ data: { time: 0, packet: new ArrayBuffer(PACKET_BYTES) } })
  assert.equal(h.app.captureDrops, 1)
  assert.equal(h.connection.sent.length, 0)
  onmessage({ data: { time: 1, packet: new ArrayBuffer(PACKET_BYTES) } })
  assert.equal(h.connection.sent.length, 1)
  h.app.endSession()
  oldMute()
  oldEnded()
  onmessage({ data: { time: 0, packet: new ArrayBuffer(PACKET_BYTES) } })
  h.incoming[0].reject(new Error('Closed'))
  await starting
  assert.equal(h.app.state, 'idle')
  assert.equal(h.app.sourceInterrupted, false)
  assert.equal(h.app.captureDrops, 0)
  assert.equal(h.app.paired, false, 'Ending an established mic session invalidates its consumed pairing')
  assert.equal(live.track.stops, 1)
  assert.equal(live.track.onmute, null)
}
{
  const h = harness()
  h.app.setMode('speaker')
  const starting = h.app.primaryAction()
  await until(() => h.app.state == 'waiting')
  h.peer.resolve(h.connection)
  await until(() => h.incoming.length == 1)
  h.incoming[0].resolve(new Uint8Array(PACKET_BYTES - 1))
  await starting
  assert.equal(h.app.state, 'error', 'Invalid transport audio must fail explicitly')
  assert.match(h.app.error, /invalid audio packet/)
  assert.equal(h.timers.size, 0)
}
{
  const h = harness()
  h.app.setMode('speaker')
  const oldStart = h.app.primaryAction()
  await until(() => h.endpoint.accepts.length == 1)
  h.app.endSession()
  const newStart = h.app.primaryAction()
  await until(() => h.endpoint.accepts.length == 2)
  assert.equal(h.wakeRequests.length, 1, 'Replacement sessions share an outstanding wake lock request')
  let staleReleases = 0
  let currentReleases = 0
  h.wakeRequests[0].resolve({ released: false, async release() { staleReleases++ } })
  await until(() => h.wakeRequests.length == 2)
  assert.equal(staleReleases, 1, 'A stale wake lock result must release before the new request')
  h.wakeRequests[1].resolve({ released: false, async release() { currentReleases++ } })
  await Promise.resolve()
  await Promise.resolve()
  h.app.endSession()
  assert.equal(currentReleases, 1, 'Ending the replacement session releases its held lock')
  h.peer.resolve(h.connection)
  await Promise.all([oldStart, newStart])
}
{
  const h = harness()
  h.pair()
  const starting = h.app.primaryAction()
  const live = capture()
  h.captures[0].resolve(live)
  await until(() => h.endpoint.connects.length == 1)
  h.peer.resolve(h.connection)
  await until(() => h.incoming.length == 1)
  const oldStateChange = h.contexts[0].onstatechange!
  live.track.onended!()
  assert.equal(h.app.state, 'error', 'A genuinely ended capture must stop, unlike temporary source mute')
  assert.match(h.app.error, /Microphone disconnected/)
  assert.equal(h.connection.closed, 1)
  assert.equal(h.contexts[0].closed, true)
  h.app.setMode('speaker')
  h.contexts[0].state = 'suspended'
  oldStateChange()
  h.incoming[0].reject(new Error('Closed'))
  await starting
  assert.equal(h.app.state, 'idle', 'Old context events must not replace the new role')
  assert.equal(h.app.error, '')
}
{
  const h = harness()
  h.app.state = 'waiting'
  h.app.pairingLink = 'https://example.test/webmic/#secret'
  await h.app.copyPairing()
  assert.equal(h.app.state, 'waiting', 'Clipboard denial must not stop pairing')
  assert.match(h.app.error, /Select and copy/)
  const pending = Promise.withResolvers<void>()
  h.navigator.clipboard.writeText = () => pending.promise
  const copying = h.app.copyPairing()
  h.app.endSession()
  assert.equal(h.app.error, '', 'Stopping clears copy guidance for the pairing link that is no longer displayed')
  pending.resolve()
  await copying
  assert.equal(h.app.copied, false, 'A stale copy completion must not alter a later session')
}
console.info('Session checks passed: CSP registration, pairing actions, permissions, cancellation, stale resources, radio sync, Help focus, asset reload, QR lifecycle, wake locks, receive health, source interruption, diagnostics, protocol and clipboard fallback')
