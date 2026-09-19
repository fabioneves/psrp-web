# Tasks

- [x] Software transcoder and bounded receiver, verified with generated H.264.
- [x] Session tickets, ownership and lifecycle, verified by backend/API tests.
- [x] Canvas UI and controls, verified in Chromium with GPU disabled.
- [x] Docker Compose startup and migration, verified with health and API checks.
- [x] README, source attribution and performance report.

Hardware acceptance remains external: actual PS4/PS5 pairing/gameplay and Tesla
browser performance. See `docs/validation.md`; no console result is claimed.

- [x] Optional gamepads with Tesla mappings, source selection and analog controls.
- [x] Same-account input-only clients with per-source cleanup and connection caps.
- [x] Fresh-ticket reconnects, renderer fallback, display settings and diagnostics.
- [x] Server Opus decode, Web Audio output, worklet jitter buffer and mute/volume.
- [x] 360p/540p/720p/1080p profiles at 30/60 fps and configurable encoder threads.
- [x] Synthetic 1080p60/audio, fallback, attachment and authorization validation.
- [x] Docker HTTPS overlay, updated setup instructions and Tesla parity audit.

## WebRTC video transport (spec/webrtc.md, plan in tasks/plan.md)

### Phase 0: decide

- [x] **1. Library spike.** SIPSorcery and libdatachannel each send 10 and 30 Mbps of 1100-byte unreliable messages to Chrome on the LAN, from inside the Docker image.
  - Accept: per-message delay (median, p95, max), rate, loss and CPU recorded for both; whether each exposes the channel's buffered amount; both channel-to-worker modes timed in Chrome. Added 2026-09-19: proof that `maxRetransmits: 0` really abandons lost messages under 2 % induced loss; the same runs with 16 KiB and 64 KiB messages plus the receiving Chrome's CPU, to choose the fragment size; a complete non-trickle answer on a fixed port with an advertised public address.
  - Verify: numbers written into spec Tech Stack; spike branch not merged.
  - Depends: none. Files: `spikes/webrtc/*`, `spec/webrtc.md`. Size: M.
- [ ] **2. Probe reports data-channel transfer to a worker.**
  - Accept: `/probe.html` shows whether an `RTCDataChannel` can be transferred to a worker and still receive; result included in the copied report.
  - Verify: `npm run test:unit`, `npx playwright test tests/browser/probe.spec.js`; run in the car and record the result in the spec.
  - Depends: none. Files: `web/probe.js`, `web/probe-results.js`, `tests/probe-results.test.mjs`, `tests/browser/probe.spec.js`. Size: S.
  - State 2026-09-19: built and tested; desktop Chrome 150 hands the channel over (200 of 200). Open until it has run in the car, which needs a deploy.
- [ ] **Checkpoint A:** done 2026-09-19 except the car: the user chose libdatachannel, 64 KiB messages and the replacement for criterion 2. Open: the probe's worker hand-off result from the car (deployed for it).

### Phase 1: pure modules

- [x] **3. FrameFragmenter.** Access unit → messages of ≤ 64 KiB with `frameId, index, count` (first built at 1100 bytes; changed after the spike).
  - Accept: round trip for 1 byte, exactly 1100 bytes and 2 MiB; `count` overflow rejected.
  - Verify: `docker build --target test -t player-one-tests .`
  - Depends: none. Files: `RemotePlay/Services/Software/FrameFragmenter.cs`, `tests/backend/RtcTests.cs`, `tests/backend/Program.cs`. Size: S.
- [x] **4. Frame reassembler.** Fragments → complete access units with the spec's drop policy.
  - Accept: in-order, reorder and duplicates deliver; a lost fragment abandons only that frame; newer-complete and two-interval deadline abandon; after abandonment nothing is delivered until a keyframe; keyframe requests ≤ 1 per 500 ms; ≤ 4 frames and 2 MiB per frame held.
  - Verify: `node --test tests/frame-reassembler.test.mjs`
  - Depends: none. Files: `web/frame-reassembler.js`, `tests/frame-reassembler.test.mjs`. Size: S.

### Phase 2: one path end to end

- [x] **5. Tickets carry a transport.**
  - Accept: `POST /api/software/tickets` accepts `transport`; `webrtc` with `mpeg1` answers 400; omitted means `websocket`.
  - Verify: backend tests.
  - Depends: none. Files: `StreamTickets.cs`, `SoftwareController.cs`, `tests/backend/RtcTests.cs`. Size: S.
- [ ] **6. Server data channel and signaling.**
  - Accept: for a `webrtc` ticket the server answers the browser's `rtc-offer` with `rtc-answer`, trickles candidates on `WEBRTC_PORT` with LAN and configured public address, and after the channel opens sends video on it from the next keyframe, announcing it with a `transport` message; video runs on the WebSocket until then; SDP never logged at information level.
  - Verify: backend test with an in-process peer receives fragments that reassemble to the sent access units.
  - State 2026-09-19: the channel itself is built and tested (libdatachannel build stage, binding, `RtcPeer`, `RtcVideoChannel`, non-trickle answer with advertised addresses). Still to do: signaling through the WebSocket and the switch-over in `SoftwareSession`.
  - Depends: 1, 3, 5. Files: `RtcVideoChannel.cs`, `SoftwareSession.cs`, `SoftwareInputRouter.cs`, `SoftwareInputState.cs`, `RemotePlay.csproj` (+ `Dockerfile` if native). Size: M.
- [ ] **7. Browser data channel, setting and label.**
  - Accept: Stream settings → Advanced → Transport, saved with the other settings and hidden for Canvas; with WebRTC selected the test stream plays through the reassembler, the playback label says WebRTC, and 720p60 H.264 holds > 55 fps.
  - Verify: `tests/browser/webrtc.spec.js` against the isolated instance; `npm run test:unit`.
  - Depends: 2, 4, 6. Files: `web/rtc-video.js`, `web/stream-runtime.js`, `web/stream-worker.js`, `web/app.js`, `web/index.html`. Size: M.
- [ ] **Checkpoint B:** all suites green; a real PS5 session plays over WebRTC on the LAN (criterion 1) before anything else is built.

### Phase 3: give up what is late, fall back when it breaks

- [ ] **8. Sender backlog skipping.**
  - Accept: with the channel's buffered amount above the threshold the server skips units until a keyframe and requests one at most every 500 ms; skipped units are counted.
  - Verify: backend test with a channel double whose buffer fills and drains.
  - Depends: 6. Files: `RtcVideoChannel.cs`, `SoftwareSession.cs`, `StreamTelemetry.cs`, `tests/backend/RtcTests.cs`. Size: S.
- [ ] **9. Fallback when the channel never opens.**
  - Accept: not open within 5 s → video stays on the WebSocket, playback within 6 s, label and diagnostics give the reason.
  - Verify: browser test with an unroutable advertised address.
  - Depends: 7. Files: `RtcVideoChannel.cs`, `web/rtc-video.js`, `web/app.js`, `tests/browser/webrtc.spec.js`. Size: S.
- [ ] **10. Fallback mid-session.**
  - Accept: channel closed or failed → video resumes on the WebSocket at the next keyframe in under 2 s, same console session.
  - Verify: browser test closes the channel mid-stream and checks the session id and picture.
  - Depends: 9. Files: `SoftwareSession.cs`, `RtcVideoChannel.cs`, `web/stream-runtime.js`, `tests/browser/webrtc.spec.js`. Size: S.

### Phase 4: see it, ship it, measure it

- [ ] **11. Diagnostics and the loss test.**
  - Accept: per-second samples and server telemetry carry transport in use, fragments, abandoned frames, sender-skipped units, transport-caused keyframe requests, and the candidate pair's round trip and type; a test-only server option drops 2 % of fragments and playback continues with bounded media-ready-to-canvas age.
  - Verify: `tests/diagnostics.test.mjs`, `tests/backend/StreamTelemetryTests.cs`, browser loss test.
  - Depends: 8, 10. Files: `web/diagnostics.js`, `web/rtc-video.js`, `StreamTelemetry.cs`, `RtcVideoChannel.cs`, tests. Size: M.
- [ ] **Checkpoint C:** user approves publishing the UDP port and forwards it on the router.
- [ ] **12. Port publishing and docs.**
  - Accept: `WEBRTC_PORT/udp` published in Compose; the Proxmox installer asks for the UDP port, offering the default, and opens it; `docs/architecture.md` has the wire format and negotiation; README has setup and troubleshooting.
  - Verify: fresh `docker compose up --build -d`, WebRTC session from another LAN machine.
  - Depends: 11. Files: `compose.yaml`, `compose.lxc.yaml`, `deploy/proxmox/install.sh`, `docs/architecture.md`, `README.md`. Size: M.
- [ ] **13. Emulated-link comparison.**
  - Accept: criterion 2 as replaced on 2026-09-19: at 80 ms round trip and 10 Mbps, through a 30 s dip to 4 Mbit/s WebRTC video age is back under 150 ms within 1 s of the dip ending and WebSocket is not, and at 0.1 % loss for 5 minutes WebRTC keeps `transportP95` below RTT/2 + 40 ms; 1080p at 30 Mbps holds 60 fps on the LAN (criterion 3).
  - Verify: `tc netem` on the isolated instance; numbers in the commit message and `docs/validation.md`.
  - Depends: 11. Size: S.
- [ ] **14. Car session against the baseline.**
  - Accept: same place, same profile as `20260919T111146Z.json`; fewer and shorter delay excursions than the baseline (criterion 6); capture names recorded in the spec.
  - Depends: 12. Needs the user.
- [ ] **15. WebRTC with fallback becomes the default.** Only after task 14 passes.
  - Accept: a new profile and the presets select WebRTC for H.264/H.265; a saved WebSocket choice is kept; Canvas mode still uses WebSocket; README and the setting's hint say so.
  - Verify: `tests/browser/settings-sync.spec.js`, `tests/browser/webrtc.spec.js`, unit tests.
  - Depends: 14. Files: `web/app.js`, `web/index.html`, `README.md`, tests. Size: S.
- [ ] **Checkpoint D:** all seven success criteria checked off in the spec; remaining open questions (WebSocket backlog skipping, audio channel) decided.
