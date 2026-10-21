# Web Microphone

Send a browser microphone to another browser over encrypted iroh connections.
This fork preserves [suda's WebMic](https://github.com/suda/wireless-microphone)
interface and replaces IPFS discovery and WebRTC with browser iroh.

[Open WebMic](https://ranadeep.in/webmic/)
([GitHub Pages address](https://rnbguy.github.io/webmic/)). The account's existing
custom domain may redirect the GitHub address.

## Use

1. On the computer connected to your speaker, select **speaker** and tap the large
   speaker control. Start with a low output volume.
2. Scan its QR code with the microphone phone's camera and open the link. Or copy
   the private pairing link and paste it into WebMic on the microphone device.
3. Tap the large microphone control and allow microphone access. Audio starts
   after the status changes to **Streaming to** / **Listening from**.
4. Tap either large control to stop. Restarting the speaker creates a new pairing
   link; scan or paste that new link before reconnecting.

Keep both pages open. The devices need internet access, not the same network.
Bluetooth input routing depends on the phone and browser; pairing a Bluetooth
microphone with the OS does not guarantee the browser will capture it.

## Privacy and limits

- The QR/link contains the speaker's endpoint address and a random pairing secret.
  Anyone with the link can attempt to connect. A speaker accepts one authenticated
  microphone per session; stopping it invalidates the old endpoint.
- The secret is in the URL fragment, not an HTTP query. The microphone removes it
  from the address bar after reading it. Do not publish screenshots of active QR
  codes or share pairing links with untrusted people.
- Browser iroh currently sends traffic through relays. Audio is encrypted between
  endpoints; the relay cannot read it, but can observe connection metadata.
- This app uses iroh's default public relays. Their provider describes them as
  [development/testing infrastructure without uptime or performance guarantees](https://docs.iroh.computer/concepts/relays).
- Audio is mono PCM16 at 24 kHz, in 20 ms QUIC datagrams: about 384 kbit/s before
  transport overhead. Playback starts with a 40 ms buffer and discards accumulated
  backlog rather than letting playback delay grow indefinitely.
- There is no recording, application server, STUN/TURN service, or WebRTC fallback.
  The static page uses external font/icon stylesheets; executable code is bundled
  locally.
- Noise suppression is requested from the browser, but this is **not automatic
  acoustic feedback suppression**. Keep the microphone close to the mouth and
  away from speakers. Bluetooth and network delay remain audible risks.
- HTTPS, WebAssembly, AudioWorklet, and microphone permission are required.
  Backgrounding, screen locking, calls, and changing audio devices can interrupt
  a session. A screen wake lock is requested where supported.

## Build

Requires Bun 1.4.3, the Rust toolchain in `rust-toolchain.toml`, and the matching
Wasm binding generator:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129 --locked
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run check
bun run serve
```

The preview is at `http://127.0.0.1:4173/webmic/`. Microphone permissions on another
device require serving over HTTPS; a phone cannot reach this loopback preview.

`bun run build` compiles the Rust bridge to Wasm and TypeScript to JavaScript/CSS,
then assembles `_site/`. The frontend uses Alpine.js and the original neumorphic
CSS. `bun run check` checks TypeScript and runs an assert-based audio self-check
for PCM clipping/decoding, buffering, packet loss, duplicates, sequence wrap,
backlog limits, and malformed packets.

`.github/workflows/pages.yaml` builds and deploys `_site/` on pushes to `main`.
Generated files are not committed. The `upstream` branch preserves the original
repository and remains the fork's default branch by project choice; development
and Pages deployment use `main`.

## Verification

A local Chromium smoke run used a synthetic microphone and actual public iroh
relay connections. It rejected an incorrect pairing secret, delivered non-silent
audio into the receiving Web Audio graph with WebRTC disabled, and propagated
Stop to the other peer. This does not verify physical Bluetooth devices,
classroom acoustics, or mobile Safari/Android behavior.

## Credits and license

- Original WebMic: [Wojtek Siudzinski](https://github.com/suda), MIT license retained
  in `LICENSE`.
- Original neumorphic design and CSS: [Maria Munoz](https://dribbble.com/myacode),
  [Neumorphic Components](https://codepen.io/myacode/pen/PoqQQNM).
- Original IPFS signaling proof of concept: [Chad Retz](https://github.com/cretz/webrtc-ipfs-signaling).
- Browser transport: [iroh](https://github.com/n0-computer/iroh); browser integration
  follows its [official browser echo example](https://github.com/n0-computer/iroh-examples/tree/main/browser-echo).

Control sizing, focus, status feedback, and reduced motion follow
[Apple's button guidance](https://developer.apple.com/design/human-interface-guidelines/buttons)
and [Android's accessibility guidance](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility).
