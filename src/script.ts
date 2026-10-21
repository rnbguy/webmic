import platform from 'platform'
import Alpine from 'alpinejs'
import QRCode from 'qrcode'
import { SAMPLE_RATE, PACKET_BYTES } from './audio-format'
import type { AudioEndpoint, AudioConnection } from '../dist/iroh/webmic_transport'
import type * as TransportModule from '../dist/iroh/webmic_transport'
import './style.css'

window.Alpine = Alpine
type Mode = 'microphone' | 'speaker'
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

  return {
    mode: 'microphone' as Mode,
    modes: ['microphone', 'speaker'] as Mode[],
    showHelp: false,
    state: 'idle',
    error: '',
    invitation: '',
    pairingLink: '',
    qrCode: '',
    copied: false,
    paired: false,
    onPageHide: undefined as (() => void) | undefined,
    onPairingLink: undefined as (() => void) | undefined,

    get active(): boolean { return this.state != 'idle' },
    get stateIcon(): string {
      if (this.error) return 'error_outline'
      if (this.state == 'connecting') return 'public'
      if (this.state == 'waiting') return 'qr_code'
      return this.mode == 'microphone' ? 'mic_none' : 'volume_up'
    },
    get status(): string {
      if (this.state == 'connecting') return 'Connecting...'
      if (this.state == 'waiting') return 'Scan to pair your microphone'
      if (this.state == 'connected') {
        return `${this.mode == 'microphone' ? 'Streaming to' : 'Listening from'} ${peerLabel}`
      }
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
    },

    destroy() {
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide)
      if (this.onPairingLink) window.removeEventListener('hashchange', this.onPairingLink)
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
      this.stop()
      this.showHelp = !this.showHelp
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
      if (this.mode == 'microphone' && !pairing) {
        this.error = 'Start the speaker, then scan its QR code or paste its pairing link.'
        return
      }
      this.error = ''
      this.state = 'connecting'
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
            else stream = captured
          })
          : Promise.resolve()
        await Promise.all([resumed, capture])
        if (current != generation) return
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
          processor.connect(context.destination)
          const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
          const address = btoa(opened.address()).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
          const url = new URL(location.href)
          url.hash = new URLSearchParams({ speaker: address, key: token }).toString()
          this.pairingLink = url.href
          this.qrCode = await QRCode.toDataURL(url.href, { width: 256, margin: 4, errorCorrectionLevel: 'M' })
          if (current != generation) return
          this.state = 'waiting'
          pairedConnection = await opened.accept(token, label)
        } else {
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
            try {
              pairedConnection.send(new Uint8Array(data.packet))
            } catch (error) {
              this.fail(error, current)
            }
          }
          stream!.getTracks().forEach(track => {
            track.onended = () => this.fail(new Error('Microphone disconnected. Tap to start again.'), current)
          })
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
      this.stop()
      this.error = error.name == 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in your browser settings, then tap to start.'
        : error.message || 'Audio could not start. Tap to try again.'
    },

    stop() {
      generation++
      if (processor) {
        processor.port.onmessage = null
        processor.disconnect()
        processor.port.close()
      }
      source?.disconnect()
      stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
      connection?.close()
      endpoint?.close()
      if (audio) {
        audio.onstatechange = null
        audio.close().catch(error => console.debug('Audio context already stopped', { reason: error.message }))
      }
      if (wakeLock) wakeLock.release().catch(error => console.debug('Screen wake lock already released', { reason: error.message }))
      processor = source = stream = connection = endpoint = audio = wakeLock = null
      if (this.active) console.info('Audio stopped', { role: this.mode })
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
