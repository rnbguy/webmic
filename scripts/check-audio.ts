import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { SAMPLE_RATE, PACKET_SAMPLES, PACKET_BYTES, HEADER_BYTES } from '../src/audio-format'

type Packet = { packet: ArrayBuffer, time: number }
class Port {
  messages: (Packet | { error: string })[] = []
  onmessage: ((event: { data: ArrayBuffer }) => void) | null = null
  postMessage(message: Packet | { error: string }) { this.messages.push(message) }
}
type Processor = { port: Port, process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean }
const processors = new Map<string, new () => Processor>()
const build = await Bun.build({ entrypoints: [new URL('../src/audio-worklet.ts', import.meta.url).pathname], target: 'browser' })
assert.equal(build.success, true)
runInNewContext(await build.outputs[0].text(), {
  AudioWorkletProcessor: class { port = new Port() },
  registerProcessor: (name: string, processor: new () => Processor) => processors.set(name, processor),
  sampleRate: SAMPLE_RATE, currentTime: 0, ArrayBuffer, DataView, Float32Array
})
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
assert.ok(render(player).every(sample => sample == 0), 'Wait for the initial jitter buffer')
enqueue(player, 1, -16384)
assert.ok(render(player).every(sample => sample == 0.25), 'Decode positive PCM')
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
assert.ok(render(backlog).every(sample => sample >= 18000 / 32768), 'Drop stale audio instead of growing latency')
backlog.port.onmessage!({ data: new ArrayBuffer(3) })
const rejected = backlog.port.messages.at(-1)
assert.ok(rejected && 'error' in rejected)
assert.equal(rejected.error, 'Invalid audio packet')
console.info('Audio self-check passed: clipping, PCM, buffering, loss, duplicates, wrap, backlog, invalid packets')
