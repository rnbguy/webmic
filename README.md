# Web Microphone

Send a browser microphone to another browser over encrypted iroh connections.
Pair a microphone and speaker with a private QR code or link. The static frontend
uses Alpine.js's CSP-compatible build. Its viewport-sized interface uses
borderless, rounded panels with subtle shadows; only panel contents scroll.

[Open WebMic](https://ranadeep.in/webmic/)
([GitHub Pages address](https://rnbguy.github.io/webmic/)). The account's existing
custom domain may redirect the GitHub address.

## Use

Desktop browsers start as Speaker; Android/iOS devices start as Microphone.
Opening a speaker's pairing link selects Microphone on either device.

1. On the computer connected to your speaker, select **Speaker** and press
   **Start speaker**. Start with a low output volume.
2. Scan its QR code with the microphone phone's camera and open the link. Use the
   expand button beside the private link for a complete QR view on short screens.
   Or press **Pair with speaker** on the microphone and paste the private link.
3. Press **Start microphone** and allow microphone access. The microphone shows
   **Microphone live**; the speaker shows **Receiving audio** once frames arrive.
4. The microphone's primary action is **Mute microphone** / **Unmute microphone**.
   Use its separate **End session** control or **Stop speaker** to disconnect.
   Restarting the speaker creates a new link; pair again before reconnecting.

Use **Mute microphone** to silence microphone audio without closing the connection. Adjust
**Speaker volume** before increasing your device's output volume. Help does not
interrupt audio. The interface follows the system's light or dark appearance,
with light as the fallback when no preference is available.
On small screens and touch-first devices, buttons, role choices, and pairing
fields are at least 56 CSS pixels high; session actions are at least 64 CSS
pixels high. Icons are larger too, without changing desktop pointer layouts.

Keyboard controls use native Tab/Shift+Tab, Enter/Space, radio/volume arrow keys,
and system copy/paste. Escape dismisses Help, collapses the expanded QR, or
otherwise cancels pending setup; it does not end a live session.
Pairing-code preparation shows an animated icon and text; reduced-motion
preferences keep the icon and text without animation.

Keep both pages open. The devices need internet access, not the same network.
Bluetooth input routing depends on the phone and browser; pairing a Bluetooth
microphone with the OS does not guarantee the browser will capture it.

The speaker distinguishes an open connection, arriving frames, and interrupted
audio. Its received-level meter can show silent frames without implying a remote
mute. A one-second receive gap changes the health indicator, not the connection;
this is initial UI tuning, not a measured latency target. Browser online status
is advisory. Temporary microphone-source mute/unmute is separate from your mute
button. A wake lock is requested while pairing and streaming where supported.

Help includes low-rate diagnostics: skipped sequence numbers, late/duplicate
packets, render underruns, queued audio, and capture-backlog drops. These do not
measure physical end-to-end latency. Ten-minute virtual drift checks exercise
the existing bounded queue; they do not calibrate real device clocks.

### Interface state contract

| Session state | Roles | Persistent action | Context |
| --- | --- | --- | --- |
| Idle, unpaired | Microphone | Pair with speaker | Focus the existing pairing input |
| Idle, paired | Microphone | Start microphone | Speaker link ready |
| Idle | Speaker | Start speaker | Pairing setup |
| Requesting | Microphone | Cancel | Browser permission prompt |
| Preparing | Both | Cancel | Audio and relay initialization |
| Connecting | Microphone | Cancel | Peer authentication |
| Waiting | Speaker | Stop speaker | Private QR/link sharing; expanded QR available |
| Connected | Microphone | Mute and separate End session | Source availability and input level |
| Connected | Speaker | Stop speaker | Receive health, incoming level, output volume |
| Muted | Microphone | Unmute and separate End session | Same connection, no microphone voice |
| Error | Both | Retry, pair, or Reload app | Actionable failure and asset recovery |

Help and system appearance changes do not stop streaming. While waiting for a
microphone, QR expansion uses the existing workspace, not a modal or overlay;
header/session actions stay visible. The expanded view reserves space for the
code, keeping its heading available to screen readers. It collapses on connection
or stop. Pairing validation and clipboard errors can
appear without entering the fatal Error state. Cancelling setup invalidates late
callbacks; old operations cannot release a newer session's resources. Enlarged
text reflows into a bounded scroll island instead of narrow clipped columns.
This is the UI contract, not a formally model-checked specification.

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
  Application code and SVG icons are bundled locally; system fonts are used.
  The hosting layer has been observed injecting Cloudflare Insights. The app's
  meta CSP blocks cross-origin executable scripts and unsafe JavaScript
  evaluation, while permitting its own Wasm/worklet and encrypted relay traffic.
  Hosting-side injection is not controlled by this repository; disabling the
  tag itself still requires the provider's configuration. No claim is made that
  audio or pairing secrets were sent to analytics.
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
bunx playwright install --with-deps --no-shell chromium firefox webkit
bun run build
bun run check
bun run serve
```

The preview is at `http://127.0.0.1:4173/webmic/`. Microphone permissions on another
device require serving over HTTPS; a phone cannot reach this loopback preview.

`bun run build` compiles Rust/Wasm and TypeScript, embeds selected packaged SVG
icons, generates matching preview/install images, and assembles `_site/`.
Transport glue and Wasm share an independent content-hashed directory. UI-only
edits reuse its URL. Each UI release references its matching worklet, images,
manifest, and transport graph. Publishing retains the current plus two distinct
prior UI releases and the transports they use. Older tabs outside that window
may need the explicit **Reload app** recovery action and a fresh pairing link.
Versions predating that action need a browser reload instead.
This follows standard
[cache busting](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching).
GitHub Pages controls HTTP cache headers; this repo cannot impose custom
`Cache-Control` with an unsupported `_headers` file. Long-lived immutable CDN
caching remains a separate hosting setting, not a claim of this build.
`bun run check` checks TypeScript and runs assert-based asset, deployment, audio,
and session checks: safe archive extraction and graph retention, rollback/rerun
archive selection, PCM/transfer boundaries, loss, sequence wrap, queue limits,
diagnostics/drift, malformed packets, and deterministic cancellation/replacement
sequences with stale permission, source, clipboard, timer, and wake-lock results.

```sh
bun run check:browser
```

The browser check starts and stops its own preview and runs sequentially in
Chromium, Firefox, and WebKit, locally and in CI. It verifies both system
themes at 320, 390, 768, and 1280 px, touch targets, text contrast, pairing-link
validation, Help focus restoration, permission denial, and advisory network
status. It also checks desktop/phone defaults, radio restoration, pairing
precedence, preview/icons, manifest identity, old-tab deferred worklet/Wasm
loading across deployment, and unchanged transport URLs for UI-only changes.
Layout checks cover keyboard role selection and focus contrast, short/landscape
inline QR expansion, enlarged text with different font metrics, Speaker errors,
persistent actions, edge taps, system appearance, and the light fallback. CSP
checks verify a usable app while blocking third-party scripts and unsafe
JavaScript evaluation.
Set `WEBMIC_TEST_URL` to check an already running preview or deployed site.
Chromium uses full-browser headless mode, not the reduced headless shell, so
microphone permission behavior is exercised with working capture APIs.
Firefox denies capture through its browser preference because Playwright does
not expose a Firefox microphone permission override.
Use a supported Linux host or the matching Playwright Ubuntu container for the
complete suite; native Windows WebKit does not support its capture checks.

`.github/workflows/pages.yaml` builds and deploys `_site/` on pushes to `main`.
Generated files are not committed. The `upstream` branch preserves the original
repository. The default branch, development, and Pages deployment use `main`.

CI uses `setup-bun`'s built-in executable cache and `rust-cache` for Cargo
dependencies, build outputs, and installed tools, including `wasm-bindgen`.
Bun package downloads are cached separately by Bun version and lockfile.
Browser binaries are installed fresh, following
[Playwright's caching guidance](https://playwright.dev/docs/ci#caching-browsers).
The workflow restores the last successfully deployed main Pages artifact, using
environment deployment history rather than workflow creation order. It identifies
the completed build behind that deployment, including rollback and deploy-only
reruns. New archive names include the build attempt; the existing first-attempt
Pages archive is imported during cutover. Paths and file types are validated
before extraction; new retained graphs have a 90-day artifact lifetime. If the
deployed archive has expired or been deleted, deployment fails rather than
silently evicting assets used by open tabs; restore it before retrying.

## Verification

A local Chromium/CloakBrowser smoke used synthetic capture and actual public iroh
relays with WebRTC disabled. It verified retained published-page startup, failed
asset reload, non-silent audio, mute/unmute, output gain, and QR collapse on
connection. Dropped frames changed receive health and recovered without
disconnecting; a false offline hint left working audio open. The screenshot
review covers desktop/mobile light/dark, short/landscape QR, errors, and enlarged
text. Earlier runs also rejected an incorrect pairing secret, kept Help
non-disruptive, and re-paired without reloading.

A desktop WebKit run reproduced the 30-second relay timeout and rejected the
dotted relay hostname's TLS certificate. With the upstream workaround, Firefox
and WebKit both reached a relay, advertised undotted addresses, authenticated
each other, and delivered a QUIC datagram. This was not a physical iPhone test.
The browser regression suite covers all three engines, including Help focus,
Escape dismissal, system appearance, and cached-deployment upgrades.
Installed Linux Chrome Stable also passed the UI, device-role, layout, and
cached-upgrade checks.
The compatibility target is current Chrome, Edge, Firefox, and Safari, including
phone browsers. Engine tests and mobile viewport emulation do not establish
compatibility with every branded browser or physical device.

A mixed-engine audio smoke delivered microphone audio through real iroh relays
from Chromium to Firefox, Firefox to WebKit, and WebKit to Chromium. Mute,
unmute, and output gain were verified on each route using synthetic capture
devices and a virtual Linux audio output, not physical microphones or speakers.

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
