# Canvas Remote Play

## Objective
Run PS4/PS5 Remote Play in a browser with no GPU, hardware video decoder,
physical controller requirement. Default to 1280×720 at 60 fps with stereo audio.
Support 360p/540p/720p/1080p and 30/60 fps, up to 30 Mbps output.
Target Tesla Chromium; desktop Chromium is the available automated test target.
Touch, keyboard, optional gamepads and same-account input-only clients are required.

## Architecture
Reuse o1298098/remote-play's .NET 10 console discovery, registration, encrypted
session, packet reassembly and controller protocol. Add an authenticated,
single-viewer WebSocket service and a small browser client.

Console H.264 → FFmpeg CPU decoder → MPEG-1 encoder (no B frames) → MPEG-TS
over WebSocket → JSMpeg WASM/JS decoder → Canvas2D putImageData.
Prefer decoding/rendering in a worker with OffscreenCanvas; support main-thread
Canvas2D when unavailable. No WebRTC, WebCodecs, HTML video or WebGL
in this playback path. Server Opus decode supplies PCM to Web Audio, with a bounded
AudioWorklet jitter buffer and a scheduled Web Audio fallback. MPEG-1 costs additional bandwidth and server CPU and is
a deliberate tradeoff for deterministic software decoding.

The Moonlight reference uses decoded WebRTC tracks and canvas. It does not
explicitly force a software decoder. We adopt canvas rendering, not its decoder.

## Commands
- Run: `docker compose up --build -d`
- Backend tests: `docker build --target test -t canvas-remote-play-tests .`
- Browser tests: `npm ci && npm test`
- Stop: `docker compose down`

## Structure and style
- `RemotePlay/`, `RemotePlay.DBTool/`: retained upstream backend and migrations.
- `RemotePlay/Services/Software/`: bounded stream transport, transcoder, session lifecycle.
- `web/`: static HTML, CSS and JavaScript modules, locally served JSMpeg.
- `tests/`: protocol, lifecycle, transcoding and browser tests.
- `docs/`: architecture, sources and validation limits.
- `tasks/`: implementation plan and acceptance checklist.

Use descriptive names and small functions; preserve upstream code except where
integration requires changes. Example: `const socket = new WebSocket(streamUrl)`.

## Verification and boundaries
Always test the real software decoding path with GPU disabled, test malformed
input and queue overflow, keep secrets out of responses and logs, and clean up
sessions and FFmpeg on socket closure. Pairing remains a real upstream operation.
No GPU devices or privileged containers are required. Optional controllers use
the Gamepad API when allowed by the browser.
Do not claim actual console/Tesla performance without running on those devices.
Actual sustained 720p60 is a performance target, not guaranteed on arbitrary CPUs.

Default deployment uses Docker bridge networking and manual console IP entry;
rootful Linux host networking is an optional override for broadcast discovery.
Unused upstream WebRTC implementation and dependencies are removed from this fork.

## Acceptance
1. Docker Compose builds locally, migrates PostgreSQL and serves one web origin.
2. User can sign up, log in, discover/pair a console and start/stop a stream.
3. Synthetic 720p60 stream exercises the same transcoder and browser decoder.
4. Touch/keyboard input requires no hardware controller; audio supports mute, volume and autoplay recovery.
5. Socket access requires a short-lived single-use ticket; queues are bounded.
6. Browser displays measured frame rate and decode time; failures are actionable.

7. Tesla gamepad mapping, controller selection and reconnect behavior match the
   relevant reference behaviors documented in `tesla-parity.md`.
8. Same-account input attachments cannot access another user's session and release
   their own controls on detach; four-client maximum.
9. 1080p60 is selectable and benchmarked without GPU acceleration. Keep 720p60 as
   the default until target-device measurements justify changing it.
