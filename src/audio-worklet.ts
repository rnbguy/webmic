import { SAMPLE_RATE, PACKET_SAMPLES, HEADER_BYTES, PACKET_BYTES } from './audio-format'

declare const sampleRate: number
declare const currentTime: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void

class MicrophoneProcessor extends AudioWorkletProcessor {
  sequence: number
  offset: number
  packet: ArrayBuffer
  view: DataView

  constructor() {
    super()
    this.sequence = 0
    this.offset = 0
    this.packet = new ArrayBuffer(PACKET_BYTES)
    this.view = new DataView(this.packet)
  }

  process(inputs: Float32Array[][]): boolean {
    const channels = inputs[0]
    if (!channels.length) return true
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0
      for (const channel of channels) sample += channel[i] / channels.length
      sample = Math.max(-1, Math.min(1, sample))
      this.view.setInt16(HEADER_BYTES + this.offset * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true)
      if (++this.offset == PACKET_SAMPLES) {
        this.view.setUint32(0, this.sequence++, true)
        this.port.postMessage({ packet: this.packet, time: currentTime }, [this.packet])
        this.packet = new ArrayBuffer(PACKET_BYTES)
        this.view = new DataView(this.packet)
        this.offset = 0
      }
    }
    return true
  }
}

class SpeakerProcessor extends AudioWorkletProcessor {
  samples: Float32Array
  read: number
  length: number
  expected: number | null
  playing: boolean

  constructor() {
    super()
    this.samples = new Float32Array(PACKET_SAMPLES * 8)
    this.read = 0
    this.length = 0
    this.expected = null
    this.playing = false
    this.port.onmessage = ({ data }) => this.enqueue(data)
  }

  enqueue(packet: ArrayBuffer): void {
    if (!(packet instanceof ArrayBuffer) || packet.byteLength != PACKET_BYTES) {
      this.port.postMessage({ error: 'Invalid audio packet' })
      return
    }
    const view = new DataView(packet)
    const sequence = view.getUint32(0, true)
    const gap = this.expected === null ? 0 : (sequence - this.expected) | 0
    if (gap < 0) return
    if (gap > 3 || this.length + (gap + 1) * PACKET_SAMPLES > PACKET_SAMPLES * 6) {
      this.read = 0
      this.length = 0
      this.playing = false
    } else {
      for (let i = 0; i < gap * PACKET_SAMPLES; i++) this.append(0)
    }
    for (let i = 0; i < PACKET_SAMPLES; i++) {
      this.append(view.getInt16(HEADER_BYTES + i * 2, true) / 32768)
    }
    this.expected = (sequence + 1) >>> 0
  }

  append(sample: number): void {
    this.samples[(this.read + this.length) % this.samples.length] = sample
    this.length++
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0][0]
    if (!this.playing && this.length >= PACKET_SAMPLES * 2) this.playing = true
    if (!this.playing) return true
    for (let i = 0; i < output.length; i++) {
      if (!this.length) {
        this.playing = false
        break
      }
      output[i] = this.samples[this.read]
      this.read = (this.read + 1) % this.samples.length
      this.length--
    }
    return true
  }
}

if (sampleRate != SAMPLE_RATE) throw new Error('Audio requires a 24000 Hz context')
registerProcessor('webmic-microphone', MicrophoneProcessor)
registerProcessor('webmic-speaker', SpeakerProcessor)
