import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { SAMPLE_RATE, PACKET_SAMPLES, PACKET_BYTES, HEADER_BYTES } from '../src/audio-format'

type Packet = { packet: ArrayBuffer, time: number }
class Port {
  messages: (Packet | { error: string })[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  postMessage(message: Packet | { error: string }, transfer: ArrayBuffer[] = []) {
    this.messages.push(structuredClone(message, { transfer }))
  }
}
type Processor = { port: Port, process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
const processors = new Map<string, new () => Processor>()
const build = await Bun.build({ entrypoints: [new URL('../src/audio-worklet.ts', import.meta.url).pathname], target: 'browser' })
assert.equal(build.success, true)
const workletCode = await build.outputs[0].text()
const workletGlobals = {
  AudioWorkletProcessor: class { port = new Port() },
  registerProcessor: (name: string, processor: new () => Processor) => processors.set(name, processor),
  sampleRate: SAMPLE_RATE, currentTime: 0, ArrayBuffer, DataView, Float32Array
}
runInNewContext(workletCode, workletGlobals)
assert.throws(() => runInNewContext(workletCode, { ...workletGlobals, sampleRate: 48000 }), /24000 Hz/)
const capture = new (processors.get('webmic-microphone')!)()
const samples = new Float32Array(PACKET_SAMPLES)
samples.fill(0.25)
samples[0] = -2
samples[1] = 2
capture.process([[samples]], [])
const encoded = (capture.port.messages[0] as Packet).packet
const encodedView = new DataView(encoded)
assert.equal(encoded.byteLength, PACKET_BYTES)
assert.equal(encodedView.getInt16(HEADER_BYTES, true), -32768)
assert.equal(encodedView.getInt16(HEADER_BYTES + 2, true), 32767)
assert.equal(encodedView.getInt16(HEADER_BYTES + 4, true), 8192)
assert.equal(encodedView.getUint32(0, true), 0)
assert.equal((capture.port.messages[0] as Packet).time, 0)

const partial = new (processors.get('webmic-microphone')!)()
assert.equal(partial.process([], []), true)
assert.equal(partial.process([[]], []), true)
assert.equal(partial.port.messages.length, 0, 'Disconnected capture does not emit fake audio')
const quantum = new Float32Array(128).fill(0.5)
for (let i = 0; i < 3; i++) partial.process([[quantum]], [])
assert.equal(partial.port.messages.length, 0, 'A partial packet is not transmitted')
partial.process([[quantum]], [])
assert.equal(partial.port.messages.length, 1, '128-sample worklet quanta cross the 480-sample packet boundary')
partial.process([[new Float32Array(PACKET_SAMPLES - 32).fill(-0.5)]], [])
assert.equal(partial.port.messages.length, 2, 'Transferred capture buffers are replaced, not reused')
const second = new DataView((partial.port.messages[1] as Packet).packet)
assert.equal(second.getUint32(0, true), 1)
assert.equal(second.getInt16(HEADER_BYTES + 31 * 2, true), 16384, 'Carry the untransmitted samples into the next packet')
assert.equal(second.getInt16(HEADER_BYTES + 32 * 2, true), -16384)

const stereo = new (processors.get('webmic-microphone')!)()
stereo.process([[new Float32Array(PACKET_SAMPLES).fill(0.75), new Float32Array(PACKET_SAMPLES).fill(-0.25)]], [])
const downmix = new DataView((stereo.port.messages[0] as Packet).packet)
for (let i = 0; i < PACKET_SAMPLES; i++) assert.equal(downmix.getInt16(HEADER_BYTES + i * 2, true), 8192)
const captureWrap = new (processors.get('webmic-microphone')!)() as Processor & { sequence: number }
captureWrap.sequence = 0xffffffff
captureWrap.process([[new Float32Array(PACKET_SAMPLES * 2)]], [])
assert.deepEqual(captureWrap.port.messages.map(message => new DataView((message as Packet).packet).getUint32(0, true)), [0xffffffff, 0])

function packet(sequence: number, value: number) {
  const buffer = new ArrayBuffer(PACKET_BYTES)
  const view = new DataView(buffer)
  view.setUint32(0, sequence, true)
  for (let i = 0; i < PACKET_SAMPLES; i++) view.setInt16(HEADER_BYTES + i * 2, value, true)
  return buffer
}
function speaker() { return new (processors.get('webmic-speaker')!)() }
function enqueue(player: Processor, sequence: number, value: number) { player.port.onmessage!({ data: packet(sequence, value) }) }
function render(player: Processor, count = PACKET_SAMPLES) {
  const output = new Float32Array(count)
  player.process([], [[output]])
  return output
}
const player = speaker()
enqueue(player, 0, 8192)
assert.ok(render(player).every(sample => sample == 0.25), 'Play the first 20 ms packet without an additional startup packet')
enqueue(player, 1, -16384)
enqueue(player, 1, 30000)
enqueue(player, 3, 4096)
assert.ok(render(player).every(sample => sample == -0.5), 'Discard duplicate audio')
assert.ok(render(player).every(sample => sample == 0), 'Replace a missing packet with silence')
assert.ok(render(player).every(sample => sample == 0.125), 'Resume after packet loss')
assert.ok(render(player).every(sample => sample == 0), 'Underrun produces silence')

const wrap = speaker()
enqueue(wrap, 0xffffffff, 8192)
enqueue(wrap, 0, 16384)
assert.ok(render(wrap).every(sample => sample == 0.25), 'Sequence wrap preserves ordering')
assert.ok(render(wrap).every(sample => sample == 0.5))

const backlog = speaker()
for (let i = 0; i < 20; i++) enqueue(backlog, i, i * 1000)
for (let i = 17; i < 20; i++) {
  assert.ok(render(backlog).every(sample => sample == i * 1000 / 32768), 'Keep only the newest three packets (60 ms)')
}
assert.ok(render(backlog).every(sample => sample == 0), 'A burst cannot grow the playout queue past 60 ms')

const partialBacklog = speaker()
for (let i = 0; i < 3; i++) enqueue(partialBacklog, i, (i + 1) * 1000)
assert.ok(render(partialBacklog, 128).every(sample => sample == 1000 / 32768))
enqueue(partialBacklog, 3, 4000)
assert.ok(render(partialBacklog, PACKET_SAMPLES - 128).every(sample => sample == 2000 / 32768), 'Shed a whole old packet even after partial rendering')
assert.ok(render(partialBacklog).every(sample => sample == 3000 / 32768))
assert.ok(render(partialBacklog).every(sample => sample == 4000 / 32768))
assert.ok(render(partialBacklog).every(sample => sample == 0))

const burstLoss = speaker()
enqueue(burstLoss, 0, 1000)
enqueue(burstLoss, 3, 4000)
assert.ok(render(burstLoss, PACKET_SAMPLES * 2).every(sample => sample == 0), 'Two lost packets are bounded silence, shedding older queued audio')
assert.ok(render(burstLoss).every(sample => sample == 4000 / 32768))
enqueue(burstLoss, 8, 8000)
enqueue(burstLoss, 7, 7000)
assert.ok(render(burstLoss).every(sample => sample == 8000 / 32768), 'Large gaps jump to current audio; late packets do not replay')
assert.ok(render(burstLoss).every(sample => sample == 0))

const underrun = speaker()
enqueue(underrun, 0, 8192)
const tail = render(underrun, PACKET_SAMPLES + 128)
assert.ok(tail.subarray(0, PACKET_SAMPLES).every(sample => sample == 0.25))
assert.ok(tail.subarray(PACKET_SAMPLES).every(sample => sample == 0), 'A partial render underrun leaves silence, not stale samples')
enqueue(underrun, 1, -32768)
assert.ok(render(underrun).every(sample => sample == -1), 'Playback resumes on the next packet after an underrun')

const invalid = speaker()
for (const data of [null, {}, new Uint8Array(PACKET_BYTES), new ArrayBuffer(0), new ArrayBuffer(PACKET_BYTES - 1), new ArrayBuffer(PACKET_BYTES + 1)]) {
  invalid.port.onmessage!({ data })
  const rejected = invalid.port.messages.at(-1)
  assert.ok(rejected && 'error' in rejected)
  assert.equal(rejected.error, 'Invalid audio packet')
}
enqueue(invalid, 0, 32767)
assert.ok(render(invalid).every(sample => sample == 32767 / 32768), 'Malformed packets do not poison playback state')
console.info('Audio self-check passed: PCM, transferred buffers, quantum boundaries, stereo, sequence wrap, 20 ms startup, 60 ms queue, loss, late packets, underruns, invalid packets')
