import platform from 'platform'
import Alpine from '@alpinejs/csp'
import QRCode from 'qrcode'
import { SAMPLE_RATE, PACKET_BYTES, HEADER_BYTES } from './audio-format'
import type { PlaybackStats } from './audio-format'
import type { AudioEndpoint, AudioConnection } from '../dist/iroh/webmic_transport'
import type * as TransportModule from '../dist/iroh/webmic_transport'
import './style.css'

window.Alpine = Alpine
type Mode = 'microphone' | 'speaker'
type SessionState = 'idle' | 'requesting' | 'preparing' | 'connecting' | 'waiting' | 'connected' | 'muted' | 'error'
type Transport = typeof TransportModule
type Pairing = { address: string, token: string }
declare const __TRANSPORT_PATH__: string

let transportPromise: Promise<Transport> | null = null

async function loadTransport(): Promise<Transport> {
  if (!transportPromise) {
    const url = new URL(__TRANSPORT_PATH__, import.meta.url).href
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
  let wakeRequest: Promise<void> | null = null
  let receiveTimer: number | undefined
  let lastAudioAt = 0
  // Initial UI health tuning, not a measured transport latency optimum.
  const stallAfterMs = 1000
  let output: GainNode | null = null
  let meterPackets = 0
  let viewport: VisualViewport | null = null

  return {
    mode: 'speaker' as Mode,
    showHelp: false,
    state: 'idle' as SessionState,
    error: '',
    invitation: '',
    pairingLink: '',
    qrCode: '',
    pairingExpanded: false,
    copied: false,
    paired: false,
    muted: false,
    volume: 70,
    inputLevel: 0,
    receiveHealth: 'awaiting-audio' as 'awaiting-audio' | 'receiving' | 'stalled',
    sourceInterrupted: false,
    playbackStats: { gaps: 0, late: 0, underruns: 0, queuedMs: 0, level: 0 } as PlaybackStats,
    captureDrops: 0,
    assetLoadFailed: false,
    networkWarning: '',
    audioStatus: 'Browser audio processing depends on the device.',
    onPageHide: undefined as (() => void) | undefined,
    onPairingLink: undefined as (() => void) | undefined,
    onNetwork: undefined as (() => void) | undefined,
    onVisibility: undefined as (() => void) | undefined,
    onViewport: undefined as (() => void) | undefined,

    get active(): boolean { return this.state != 'idle' && this.state != 'error' },
    get busy(): boolean { return ['requesting', 'preparing', 'connecting'].includes(this.state) },
    get pairingInvalid(): boolean { return Boolean(this.error && !this.paired) },
    get primaryIsReload(): boolean { return this.state == 'error' && this.assetLoadFailed },
    get primaryIsPairing(): boolean { return !this.active && !this.primaryIsReload && this.mode == 'microphone' && !this.paired },
    get primaryIsMute(): boolean { return this.mode == 'microphone' && this.state == 'connected' },
    get primaryIsUnmute(): boolean { return this.mode == 'microphone' && this.state == 'muted' },
    get primaryIsStop(): boolean { return this.active && !this.primaryIsMute && !this.primaryIsUnmute },
    get primaryLabel(): string {
      if (this.primaryIsReload) return 'Reload app'
      if (this.busy) return 'Cancel setup'
      if (this.primaryIsPairing) return 'Pair with speaker'
      if (this.primaryIsMute) return 'Mute microphone'
      if (this.primaryIsUnmute) return 'Unmute microphone'
      if (this.active) return 'Stop speaker'
      if (this.mode == 'microphone') return this.state == 'error' ? 'Retry microphone' : 'Start microphone'
      return this.state == 'error' ? 'Retry speaker' : 'Start speaker'
    },
    get statusHeading(): string {
      if (this.state == 'error') return 'Session stopped'
      if (this.state == 'requesting') return 'Microphone permission'
      if (this.state == 'preparing') return 'Preparing audio'
      if (this.state == 'connecting') return 'Connecting'
      if (this.state == 'waiting') return 'Pair your microphone'
      if (this.state == 'muted') return 'Microphone muted'
      if (this.state == 'connected') {
        if (this.mode == 'microphone') return this.sourceInterrupted ? 'Microphone interrupted' : 'Microphone live'
        if (this.receiveHealth == 'receiving') return 'Receiving audio'
        return this.receiveHealth == 'stalled' ? 'Audio interrupted' : 'Connected - waiting for audio'
      }
      return this.mode == 'speaker' ? 'Ready to listen' : this.paired ? 'Ready to connect' : 'Not paired'
    },
    get statusTone(): 'live' | 'muted' | 'warning' | 'error' | 'idle' {
      if (this.state == 'error') return 'error'
      if (this.state == 'muted') return 'muted'
      if (this.state == 'connected') {
        return this.mode == 'microphone'
          ? this.sourceInterrupted ? 'warning' : 'live'
          : this.receiveHealth == 'receiving' ? 'live' : 'warning'
      }
      return 'idle'
    },
    get status(): string {
      if (this.state == 'error') return ''
      if (this.state == 'requesting') return 'Allow access in the browser prompt.'
      if (this.state == 'preparing') return 'Opening an encrypted relay connection.'
      if (this.state == 'connecting') return 'Keep the speaker page open.'
      if (this.state == 'waiting') return ''
      if (this.state == 'muted') return peerLabel ? `To ${peerLabel}` : ''
      if (this.state == 'connected' && this.mode == 'microphone' && this.sourceInterrupted) {
        return 'The microphone source is temporarily unavailable. The connection stays open while it recovers.'
      }
      if (this.state == 'connected' && this.mode == 'speaker' && this.receiveHealth != 'receiving') {
        return this.receiveHealth == 'stalled'
          ? 'Check the microphone device and its connection.'
          : 'The connection is open. Waiting for the first audio frames.'
      }
      if (this.state == 'connected') {
        return `${this.mode == 'microphone' ? 'Streaming to' : 'Listening from'} ${peerLabel}`
      }
      return ''
    },

    init() {
      viewport = window.visualViewport
      this.onViewport = () => {
        document.documentElement.style.setProperty('--viewport-height', `${viewport?.height ?? window.innerHeight}px`)
        document.documentElement.style.setProperty('--viewport-offset', `${viewport?.offsetTop ?? 0}px`)
      }
      this.onViewport()
      window.addEventListener('resize', this.onViewport)
      viewport?.addEventListener('resize', this.onViewport)
      viewport?.addEventListener('scroll', this.onViewport)
      this.setMode(platform.os?.family == 'Android' || platform.os?.family == 'iOS' ? 'microphone' : 'speaker')
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
      this.onNetwork = () => {
        this.networkWarning = navigator.onLine ? '' : 'Your browser reports offline. Audio may still work; check your connection if setup or sound stops.'
      }
      this.onNetwork()
      window.addEventListener('offline', this.onNetwork)
      window.addEventListener('online', this.onNetwork)
      this.onVisibility = () => {
        if (document.visibilityState == 'visible') this.holdScreen(generation)
      }
      document.addEventListener('visibilitychange', this.onVisibility)
    },

    destroy() {
      if (this.onViewport) {
        window.removeEventListener('resize', this.onViewport)
        viewport?.removeEventListener('resize', this.onViewport)
        viewport?.removeEventListener('scroll', this.onViewport)
      }
      if (this.onPageHide) window.removeEventListener('pagehide', this.onPageHide)
      if (this.onPairingLink) window.removeEventListener('hashchange', this.onPairingLink)
      if (this.onNetwork) {
        window.removeEventListener('offline', this.onNetwork)
        window.removeEventListener('online', this.onNetwork)
      }
      if (this.onVisibility) document.removeEventListener('visibilitychange', this.onVisibility)
      this.stop()
    },

    setMode(mode: Mode) {
      if (mode != this.mode) {
        this.stop()
        this.assetLoadFailed = false
        this.mode = mode
        document.querySelectorAll<HTMLLinkElement>('link[rel=icon]').forEach(icon => {
          icon.href = icon.href.replace(/microphone|speaker/, mode)
        })
      }
      for (const role of ['speaker', 'microphone']) {
        const radio = document.getElementById(role) as HTMLInputElement | null
        if (radio) radio.checked = role == mode
      }
    },

    toggleHelp() {
      this.showHelp = !this.showHelp
      if (!this.showHelp) {
        document.getElementById('help-toggle')?.focus({ preventScroll: true })
        return
      }
      Alpine.nextTick(() => requestAnimationFrame(() => {
        if (this.showHelp) document.getElementById('help-panel')?.focus({ preventScroll: true })
      }))
    },

    dismissPanel() {
      if (this.showHelp) this.toggleHelp()
      else if (this.pairingExpanded) this.closePairingQr()
      else if (this.busy) this.stop()
    },

    showPairingQr() {
      if (this.state != 'waiting' || !this.qrCode || this.pairingExpanded) return
      const current = generation
      this.showHelp = false
      this.pairingExpanded = true
      Alpine.nextTick(() => requestAnimationFrame(() => {
        if (current == generation && this.pairingExpanded && !this.showHelp) document.getElementById('collapse-pairing')?.focus({ preventScroll: true })
      }))
    },

    closePairingQr() {
      if (!this.pairingExpanded) return
      const current = generation
      const focused = document.activeElement
      const restoreFocus = focused == document.getElementById('collapse-pairing') || document.getElementById('pairing-qr')?.parentElement?.contains(focused)
      this.pairingExpanded = false
      Alpine.nextTick(() => requestAnimationFrame(() => {
        if (restoreFocus && current == generation && !this.pairingExpanded && (document.activeElement == focused || document.activeElement == document.body)) {
          document.getElementById(this.showHelp ? 'help-toggle' : this.state == 'waiting' ? 'expand-pairing' : 'session-toggle')?.focus()
        }
      }))
    },

    primaryAction() {
      if (this.primaryIsReload) {
        location.reload()
        return
      }
      if (this.primaryIsPairing) {
        const current = generation
        this.showHelp = false
        const input = document.getElementById('invitation')
        input?.focus()
        if (document.activeElement != input) Alpine.nextTick(() => requestAnimationFrame(() => {
          if (current == generation && this.primaryIsPairing && !this.showHelp) input?.focus()
        }))
        return
      }
      if (this.primaryIsMute || this.primaryIsUnmute) this.toggleMute()
      else return this.toggle()
    },

    endSession() {
      this.stop()
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
        this.setMode('microphone')
        this.invitation = ''
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
      const current = generation
      try {
        await navigator.clipboard.writeText(this.pairingLink)
        if (current != generation || this.state != 'waiting') return
        this.copied = true
        this.error = ''
      } catch (error) {
        if (current != generation || this.state != 'waiting') return
        this.copied = false
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
      this.assetLoadFailed = false
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
              const tracks = captured.getAudioTracks()
              const settings = tracks[0].getSettings()
              this.audioStatus = `Echo cancellation: ${settings.echoCancellation ? 'on' : 'not confirmed'}. Noise suppression: ${settings.noiseSuppression ? 'on' : 'not confirmed'}.`
              const updateSource = () => {
                if (current != generation || stream != captured) return
                this.sourceInterrupted = tracks.some(track => track.muted)
                if (this.sourceInterrupted) this.inputLevel = 0
              }
              updateSource()
              tracks.forEach(track => {
                track.onmute = updateSource
                track.onunmute = updateSource
                track.onended = () => this.fail(new Error('Microphone disconnected. Connect it again, then tap to restart.'), current)
              })
            }
          })
          : Promise.resolve()
        await Promise.all([resumed, capture])
        if (current != generation) return
        this.state = 'preparing'
        let transport: Transport
        try {
          await context.audioWorklet.addModule(new URL('audio-worklet.js', import.meta.url))
          if (current != generation) return
          transport = await loadTransport()
        } catch (error) {
          if (current != generation) return
          this.assetLoadFailed = true
          throw new Error('App files could not load. Reload the app, then try again.', { cause: error })
        }
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
          this.holdScreen(current)
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
              this.captureDrops++
              console.debug('Dropped stale microphone packet', { reason: 'capture_backlog' })
              return
            }
            if (++meterPackets % 5 == 0) {
              const samples = new DataView(data.packet)
              let peak = 0
              for (let offset = HEADER_BYTES; offset < samples.byteLength; offset += 2) {
                peak = Math.max(peak, Math.abs(samples.getInt16(offset, true)) / 32768)
              }
              this.inputLevel = this.muted || this.sourceInterrupted ? 0 : peak
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
            if (current != generation) return
            if (data.stats) this.playbackStats = data.stats
          }
        }
        context.onstatechange = () => {
          if ((context.state as string) == 'interrupted' || context.state == 'suspended') {
            this.fail(new Error('Audio was interrupted. Keep this page open and tap to start again.'), current)
          }
        }
        this.state = 'connected'
        this.closePairingQr()
        if (mode == 'speaker') {
          lastAudioAt = performance.now()
          receiveTimer = window.setInterval(() => {
            if (current != generation) return
            if (performance.now() - lastAudioAt >= stallAfterMs) this.receiveHealth = 'stalled'
          }, 250)
        }
        this.pairingLink = ''
        this.qrCode = ''
        this.copied = false
        this.error = ''
        console.info('Audio connected', { role: mode, transport: 'iroh', sampleRate: context.sampleRate })
        this.holdScreen(current)
        const player = processor!
        try {
          while (current == generation) {
            const packet = await pairedConnection.receive()
            if (current != generation) break
            if (mode != 'speaker' || packet.byteLength != PACKET_BYTES) throw new Error('Peer sent an invalid audio packet.')
            lastAudioAt = performance.now()
            this.receiveHealth = 'receiving'
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
      if (current != generation || !['waiting', 'connected', 'muted'].includes(this.state) ||
          wakeRequest || wakeLock && !wakeLock.released || document.visibilityState != 'visible') return
      if (!navigator.wakeLock) {
        console.debug('Screen wake lock unavailable', { reason: 'unsupported_browser' })
        return
      }
      const request = (async () => {
        try {
          const lock = await navigator.wakeLock.request('screen')
          if (current != generation || document.visibilityState != 'visible') await lock.release()
          else wakeLock = lock
        } catch (error) {
          console.debug('Screen wake lock unavailable', { reason: error.message })
        }
      })()
      wakeRequest = request
      await request
      if (wakeRequest == request) wakeRequest = null
      if (current != generation) this.holdScreen(generation)
    },

    fail(error: Error, current: number) {
      if (current != generation) return
      console.error('Audio session failed', { reason: error.message, cause: error.cause })
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
      this.closePairingQr()
      window.clearInterval(receiveTimer)
      receiveTimer = undefined
      if (processor) {
        processor.port.onmessage = null
        processor.disconnect()
        processor.port.close()
      }
      source?.disconnect()
      output?.disconnect()
      stream?.getTracks().forEach(track => {
        track.onended = track.onmute = track.onunmute = null
        track.stop()
      })
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
      this.sourceInterrupted = false
      this.receiveHealth = 'awaiting-audio'
      this.playbackStats = { gaps: 0, late: 0, underruns: 0, queuedMs: 0, level: 0 }
      this.captureDrops = 0
      meterPackets = 0
      this.state = 'idle'
      this.error = ''
      this.qrCode = ''
      this.pairingLink = ''
      this.copied = false
    }
  }
}

export type ControllerFactory = typeof root

declare global {
  interface Window {
    Alpine: typeof Alpine
  }
}

Alpine.data('webmic', root)
Alpine.start()
