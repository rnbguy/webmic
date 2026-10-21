# Web Microphone

Send a browser microphone to another browser over encrypted iroh connections.
Pair a microphone and speaker with a private QR code or link. The static frontend
uses Alpine.js and a responsive neumorphic interface.

[Open WebMic](https://ranadeep.in/webmic/)
([GitHub Pages address](https://rnbguy.github.io/webmic/)). The account's existing
custom domain may redirect the GitHub address.

## Use

Desktop browsers start as Speaker; Android/iOS devices start as Microphone.
Opening a speaker's pairing link selects Microphone on either device.

1. On the computer connected to your speaker, select **speaker** and tap the large
   speaker control. Start with a low output volume.
2. Scan its QR code with the microphone phone's camera and open the link. Or copy
   the private pairing link and paste it into WebMic on the microphone device.
3. Tap the large microphone control and allow microphone access. Audio starts
   after the status changes to **Streaming to** / **Listening from**.
4. Tap either large control to stop. Restarting the speaker creates a new pairing
   link; scan or paste that new link before reconnecting.

Use **Mute microphone** to silence microphone audio without closing the connection. Adjust
**Speaker volume** before increasing your device's output volume. Help stays open
without interrupting audio. The interface follows the device's light/dark theme.

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
  Their hostnames omit the trailing DNS dot to avoid Safari/WebKit certificate
  failures, following [iroh's workaround](https://github.com/n0-computer/iroh/issues/4519).
  After updating, reload both devices and restart the speaker before scanning a
  new QR code; an old running speaker still advertises dotted relay URLs.
- Audio is mono PCM16 at 24 kHz, in 20 ms QUIC datagrams: about 384 kbit/s before
  transport overhead. Playback starts with one 20 ms packet and keeps at most
  60 ms of queued samples, dropping older audio when packets arrive in bursts.
  Lower buffering can produce more dropouts on jittery connections.
- There is no recording, application server, STUN/TURN service, or WebRTC fallback.
  The static page uses an external font stylesheet; executable code and icons are
  bundled locally.
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
bunx playwright install --with-deps --no-shell chromium
bun run build
bun run check
bun run serve
```

The preview is at `http://127.0.0.1:4173/webmic/`. Microphone permissions on another
device require serving over HTTPS; a phone cannot reach this loopback preview.

`bun run build` compiles Rust/Wasm and TypeScript, embeds selected packaged SVG
icons, generates matching preview/install images, and assembles `_site/`.
The complete asset set uses one content-hashed URL directory; worklet and Wasm
loads resolve relative to that same release. This follows standard
[cache busting](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching).
An already-cached pre-versioning page may still need one hard reload.
`bun run check` checks TypeScript and runs assert-based audio and session checks:
PCM/transfer boundaries, loss, sequence wrap, queue limits, malformed packets,
cancelled permission grants, role changes, offline errors, and stale callbacks.

```sh
bun run check:browser
```

The browser check starts and stops its own preview. It verifies both system
themes at 320, 390, 768, and 1280 px, touch targets, text contrast, pairing-link
validation, help focus restoration, permission denial, and offline retry.
It also checks desktop/phone defaults, pairing precedence, preview/icon images,
manifest launch paths, and an upgrade with the previous deployment's assets
still cached in the browser.
Set `WEBMIC_TEST_URL` to check an already running preview or deployed site.
The checks use full Chromium's headless mode, not the reduced headless shell,
so microphone permission behavior is exercised with working capture APIs.

`.github/workflows/pages.yaml` builds and deploys `_site/` on pushes to `main`.
Generated files are not committed. The `upstream` branch preserves the original
repository. The default branch, development, and Pages deployment use `main`.

CI uses `setup-bun`'s built-in executable cache and `rust-cache` for Cargo
dependencies, build outputs, and installed tools, including `wasm-bindgen`.
Bun package downloads are cached separately by Bun version and lockfile.
Browser binaries are installed fresh, following
[Playwright's caching guidance](https://playwright.dev/docs/ci#caching-browsers).

## Verification

A Chromium smoke run used a synthetic microphone and actual public iroh relay
connections, with WebRTC disabled. It rejected an incorrect pairing secret,
delivered non-silent audio, verified that mute produces silence, preserved the
session while help was open, re-paired without reloading, and stopped on network
loss. Light/dark desktop and mobile screenshots were inspected.

A desktop WebKit run reproduced the 30-second relay timeout and rejected the
dotted relay hostname's TLS certificate. With the upstream workaround, Firefox
and WebKit both reached a relay, advertised undotted addresses, authenticated
each other, and delivered a QUIC datagram. This was not a physical iPhone test.

These checks do not verify physical Bluetooth devices, classroom acoustics, or
mobile Safari/Android behavior. Native browser echo cancellation and noise
suppression are requested and their reported settings are shown. They are not
a guarantee against remote-speaker feedback. Automatic feedback cancellation
was deliberately excluded: a megaphone's playback is correlated with the desired
voice, which can bias ordinary adaptive echo cancellation and suppress speech.
See the [feedback-cancellation analysis](https://pmc.ncbi.nlm.nih.gov/articles/PMC7545262/).

## Credits and license

This is a fork of [suda/wireless-microphone (WebMic)](https://github.com/suda/wireless-microphone),
originally created by Wojtek Siudzinski. Its MIT license and copyright notices
are retained in `LICENSE`.
The original CSS design attribution is retained in `src/style.css`.
Browser transport uses [iroh](https://github.com/n0-computer/iroh), following its
[official browser echo example](https://github.com/n0-computer/iroh-examples/tree/main/browser-echo).
UI icons use [Lucide](https://lucide.dev/) and the GitHub mark from
[Simple Icons](https://simpleicons.org/). Only selected SVGs and their license
notices are included in the deployed asset set.

Control sizing, focus, status feedback, and reduced motion follow
[Apple's button guidance](https://developer.apple.com/design/human-interface-guidelines/buttons)
and [Android's accessibility guidance](https://developer.android.com/design/ui/mobile/guides/foundations/accessibility).
