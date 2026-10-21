import platform from 'platform'
import Alpine from 'alpinejs'
import QRCode from 'qrcode'
import { SAMPLE_RATE, PACKET_BYTES, HEADER_BYTES } from './audio-format'
import type { AudioEndpoint, AudioConnection } from '../dist/iroh/webmic_transport'
import type * as TransportModule from '../dist/iroh/webmic_transport'
import './style.css'

window.Alpine = Alpine
type Mode = 'microphone' | 'speaker'
type SessionState = 'idle' | 'requesting' | 'preparing' | 'connecting' | 'waiting' | 'connected' | 'muted' | 'error'
type Transport = typeof TransportModule
type Pairing = { address: string, token: string }

let transportPromise: Promise<Transport> | null = null

async function loadTransport(): Promise<Transport> {
  if (!transportPromise) {
    const url = new URL('dist/iroh/webmic_transport.js', document.baseURI).href
    transportPromise = (import(url) as Promise<Transport>).then(async module => {
      await module.default()
      return module
    }).catch(error => {
      transportPromise = null
      throw error
    })
  }
  return transportPromise
}

function root() {
  let generation = 0
  let endpoint: AudioEndpoint | null = null
  let connection: AudioConnection | null = null
  let audio: AudioContext | null = null
  let processor: AudioWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let stream: MediaStream | null = null
  let pairing: Pairing | null = null
  let peerLabel = ''
  let wakeLock: WakeLockSentinel | null = null
  let output: GainNode | null = null
  let meterPackets = 0

  return {
    mode: 'microphone' as Mode,
    showHelp: false,
    state: 'idle' as SessionState,
    error: '',
    invitation: '',
    pairingLink: '',
    qrCode: '',
    copied: false,
    paired: false,
    muted: false,
    volume: 70,
    inputLevel: 0,
    audioStatus: 'Browser echo cancellation and noise suppression are requested. Keep the microphone behind the speaker.',
    onPageHide: undefined as (() => void) | undefined,
    onPairingLink: undefined as (() => void) | undefined,
    onOffline: undefined as (() => void) | undefined,
    onVisibility: undefined as (() => void) | undefined,

    get active(): boolean { return this.state != 'idle' && this.state != 'error' },
    get busy(): boolean { return ['requesting', 'preparing', 'connecting'].includes(this.state) },
    get status(): string {
      if (this.error && this.state == 'error') return 'Session stopped'
      if (this.state == 'requesting') return 'Allow microphone access in your browser'
      if (this.state == 'preparing') return 'Preparing audio and secure connection...'
      if (this.state == 'connecting') return 'Connecting...'
      if (this.state == 'waiting') return 'Scan to pair your microphone'
      if (this.state == 'muted') return 'Microphone muted'
      if (this.state == 'connected') {
        return `${this.mode == 'microphone' ? 'Streaming to' : 'Listening from'} ${peerLabel}`
      }
      if (this.mode == 'microphone' && !this.paired) return 'Start your speaker, then scan its QR code'
      return this.mode == 'microphone' ? 'Tap above to start streaming' : 'Tap above to start listening'
    },

    init() {
      this.onPairingLink = () => {
        if (location.hash) {
          this.invitation = location.href
          this.applyPairing()
        }
      }
      this.onPairingLink()
      window.addEventListener('hashchange', this.onPairingLink)
      this.onPageHide = () => this.stop()
      window.addEventListener('pagehide', this.onPageHide)
      this.onOffline = () => {
        if (this.active) this.fail(new Error('You are offline. Reconnect to the internet, then start the speaker and pair again.'), generation)
      }
      window.addEventListener('offline', this.onOffline)
      this.onVisibility = () => {
        if (document.visibilityState == 'visible' && this.active) this.holdScreen(generation)
      }
      document.addEventListener('visibilitychange', this.onVisibility)
    },

    destroy() {
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide)
      if (this.onPairingLink) window.removeEventListener('hashchange', this.onPairingLink)
      if (this.onOffline) window.removeEventListener('offline', this.onOffline)
      if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility)
      this.stop()
    },

    setMode(mode: Mode) {
      if (mode == this.mode) return
      this.stop()
      this.error = ''
      this.mode = mode
      document.querySelectorAll<HTMLLinkElement>('link[rel=icon]').forEach(icon => {
        icon.href = icon.href.replace(/microphone|speaker/, mode)
      })
    },

    toggleHelp() {
      this.showHelp = !this.showHelp
    },

    toggleMute() {
      if (this.mode != 'microphone' || !['connected', 'muted'].includes(this.state)) return
      this.muted = !this.muted
      stream?.getAudioTracks().forEach(track => { track.enabled = !this.muted })
      this.state = this.muted ? 'muted' : 'connected'
      if (this.muted) this.inputLevel = 0
    },

    setVolume() {
      this.volume = Math.max(0, Math.min(100, Number(this.volume)))
      if (output && audio) output.gain.setTargetAtTime(this.volume / 100, audio.currentTime, 0.015)
    },

    applyPairing() {
      try {
        const url = new URL(this.invitation.trim())
        const params = new URLSearchParams(url.hash.slice(1))
        const address = params.get('speaker')
        const token = params.get('key')
        if (url.origin != location.origin || url.pathname != location.pathname ||
            !address || address.length > 8192 || !token || !/^[0-9a-f]{64}$/.test(token)) {
          throw new Error('Paste a pairing link from this app on your speaker.')
        }
        const decoded = atob(address.replace(/-/g, '+').replace(/_/g, '/'))
        JSON.parse(decoded)
        this.stop()
        pairing = { address: decoded, token }
        this.paired = true
        this.mode = 'microphone'
        this.invitation = ''
        this.error = ''
        history.replaceState(null, '', `${location.pathname}${location.search}`)
      } catch (error) {
        this.stop()
        pairing = null
        this.paired = false
        this.error = 'Invalid pairing link. Start the speaker and copy its new link.'
        console.debug('Pairing link rejected', { reason: error.message })
      }
    },

    async copyPairing() {
      try {
        await navigator.clipboard.writeText(this.pairingLink)
        this.copied = true
      } catch (error) {
        this.error = 'Copy is unavailable. Select and copy the pairing link below.'
        console.debug('Clipboard unavailable', { reason: error.message })
      }
    },

    async toggle(): Promise<void> {
      if (this.active) {
        this.stop()
        return
      }
      if (!navigator.onLine) {
        this.state = 'error'
        this.error = 'You are offline. Reconnect to the internet, then try again.'
        return
      }
      if (this.mode == 'microphone' && !pairing) {
        this.error = 'Start the speaker, then scan its QR code or paste its pairing link.'
        return
      }
      this.error = ''
      this.state = this.mode == 'microphone' ? 'requesting' : 'preparing'
      const current = ++generation
      const mode = this.mode
      const invite = pairing
      try {
        if (!window.isSecureContext || !navigator.mediaDevices || !window.AudioWorkletNode) {
          throw new Error('Open this app over HTTPS in a browser with microphone and AudioWorklet support.')
        }
        audio = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
        const context = audio
        const resumed = context.resume()
        // Request permission in the tap handler, before loading Wasm or contacting relays.
        const capture = mode == 'microphone'
          ? navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
            video: false
          }).then(captured => {
            if (current != generation) captured.getTracks().forEach(track => track.stop())
            else {
              stream = captured
              const settings = captured.getAudioTracks()[0].getSettings()
              this.audioStatus = `Browser echo cancellation: ${settings.echoCancellation ? 'on' : 'not confirmed'}. Noise suppression: ${settings.noiseSuppression ? 'on' : 'not confirmed'}. Neither guarantees remote-speaker feedback removal.`
              captured.getTracks().forEach(track => {
                track.onended = () => this.fail(new Error('Microphone disconnected. Connect it again, then tap to restart.'), current)
              })
            }
          })
          : Promise.resolve()
        await Promise.all([resumed, capture])
        if (current != generation) return
        this.state = 'preparing'
        await context.audioWorklet.addModule(new URL('dist/audio-worklet.js', document.baseURI))
        if (current != generation) return
        const transport = await loadTransport()
        if (current != generation) return
        const opened = await transport.AudioEndpoint.create()
        if (current != generation) {
          opened.close()
          return
        }
        endpoint = opened
        const label = `${platform.name || 'Browser'} (${platform.os?.family || 'Device'})`.slice(0, 80)
        let pairedConnection: AudioConnection
        if (mode == 'speaker') {
          processor = new AudioWorkletNode(context, 'webmic-speaker', { numberOfInputs: 0, outputChannelCount: [1] })
          output = context.createGain()
          output.gain.value = this.volume / 100
          processor.connect(output)
          output.connect(context.destination)
          const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
          const address = btoa(opened.address()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          const url = new URL(location.href)
          url.hash = new URLSearchParams({ speaker: address, key: token }).toString()
          const qrCode = await QRCode.toDataURL(url.href, { width: 256, margin: 4, errorCorrectionLevel: 'M' })
          if (current != generation) return
          this.pairingLink = url.href
          this.qrCode = qrCode
          this.state = 'waiting'
          pairedConnection = await opened.accept(token, label)
        } else {
          this.state = 'connecting'
          pairedConnection = await opened.connect(invite!.address, invite!.token, label)
        }
        if (current != generation) {
          pairedConnection.close()
          return
        }
        connection = pairedConnection
        peerLabel = pairedConnection.label
        if (mode == 'microphone') {
          // shortcut: PCM uses about 384 kbit/s; add Opus if relay bandwidth becomes a constraint.
          processor = new AudioWorkletNode(context, 'webmic-microphone', { channelCount: 1, outputChannelCount: [1] })
          source = context.createMediaStreamSource(stream!)
          source.connect(processor)
          processor.connect(context.destination)
          processor.port.onmessage = ({ data }) => {
            if (current != generation) return
            if (context.currentTime - data.time > 0.12) {
              console.debug('Dropped stale microphone packet', { reason: 'capture_backlog' })
              return
            }
            if (++meterPackets % 5 == 0) {
              const samples = new DataView(data.packet)
              let peak = 0
              for (let offset = HEADER_BYTES; offset < samples.byteLength; offset += 2) {
                peak = Math.max(peak, Math.abs(samples.getInt16(offset, true)) / 32768)
              }
              this.inputLevel = this.muted ? 0 : peak
            }
            try {
              pairedConnection.send(new Uint8Array(data.packet))
            } catch (error) {
              this.fail(error, current)
            }
          }
        }
        processor!.onprocessorerror = () => this.fail(new Error('Audio processing stopped. Tap to start again.'), current)
        processor!.port.onmessageerror = () => this.fail(new Error('Could not transfer audio. Tap to start again.'), current)
        if (mode == 'speaker') {
          processor!.port.onmessage = ({ data }) => {
            if (data.error) this.fail(new Error(data.error), current)
          }
        }
        context.onstatechange = () => {
          if ((context.state as string) == 'interrupted' || context.state == 'suspended') {
            this.fail(new Error('Audio was interrupted. Keep this page open and tap to start again.'), current)
          }
        }
        this.state = 'connected'
        this.pairingLink = ''
        this.qrCode = ''
        console.info('Audio connected', { role: mode, transport: 'iroh', sampleRate: context.sampleRate })
        this.holdScreen(current)
        const player = processor!
        try {
          while (current == generation) {
            const packet = await pairedConnection.receive()
            if (current != generation) break
            if (mode != 'speaker' || packet.byteLength != PACKET_BYTES) throw new Error('Peer sent an invalid audio packet.')
            const buffer = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength)
            player.port.postMessage(buffer, [buffer])
          }
        } catch (error) {
          this.fail(new Error(`Connection ended. Start the speaker and pair again. ${error.message}`), current)
        }
      } catch (error) {
        this.fail(error, current)
      }
    },

    async holdScreen(current: number) {
      if (wakeLock && !wakeLock.released || document.visibilityState != 'visible') return
      if (!navigator.wakeLock) {
        console.debug('Screen wake lock unavailable', { reason: 'unsupported_browser' })
        return
      }
      try {
        const lock = await navigator.wakeLock.request('screen')
        if (current != generation) await lock.release()
        else wakeLock = lock
      } catch (error) {
        console.debug('Screen wake lock unavailable', { reason: error.message })
      }
    },

    fail(error: Error, current: number) {
      if (current != generation) return
      console.error('Audio session failed', { reason: error.message })
      if (this.mode == 'microphone' && this.state == 'connecting') {
        pairing = null
        this.paired = false
      }
      this.stop()
      this.state = 'error'
      const messages: Record<string, string> = {
        NotAllowedError: 'Microphone access was denied. Allow it in your browser site settings, then tap to retry.',
        NotFoundError: 'No microphone was found. Connect a microphone, then tap to retry.',
        NotReadableError: 'The microphone is busy or unavailable. Close other recording apps and reconnect it, then retry.',
        OverconstrainedError: 'This microphone does not support the requested audio settings. Try another microphone.',
        SecurityError: 'The browser blocked microphone access. Open this app directly over HTTPS and check site permissions.'
      }
      this.error = messages[error.name] || error.message || 'Audio could not start. Tap to try again.'
    },

    stop() {
      generation++
      if (processor) {
        processor.port.onmessage = null
        processor.disconnect()
        processor.port.close()
      }
      source?.disconnect()
      output?.disconnect()
      stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
      if (connection && this.mode == 'microphone') {
        pairing = null
        this.paired = false
      }
      connection?.close()
      endpoint?.close()
      if (audio) {
        audio.onstatechange = null
        audio.close().catch(error => console.debug('Audio context already stopped', { reason: error.message }))
      }
      if (wakeLock) wakeLock.release().catch(error => console.debug('Screen wake lock already released', { reason: error.message }))
      processor = source = stream = connection = endpoint = audio = wakeLock = null
      if (this.active) console.info('Audio stopped', { role: this.mode })
      output = null
      this.muted = false
      this.inputLevel = 0
      meterPackets = 0
      this.state = 'idle'
      this.qrCode = ''
      this.pairingLink = ''
      this.copied = false
    }
  }
}

declare global {
  interface Window {
    Alpine: typeof Alpine
    webmic: { root: typeof root }
  }
}

window.webmic = { root }
Alpine.start()
