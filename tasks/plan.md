# Implementation plan

1. Establish the software pipeline and Docker build; prove FFmpeg → MPEG-TS →
   JSMpeg → Canvas2D against a synthetic 720p60 source.
2. Add bounded receiver queues and authenticated socket tickets, then wire
   upstream console registration and session lifecycle into the stream.
3. Add responsive pairing/stream UI, keyboard and touch controls, and metrics.
4. Test startup, authorization, disconnect cleanup and software-only playback;
   document measured performance and hardware validation still needed.


## Tesla compatibility, audio and selectable profiles

- Implement optional analog gamepads, Tesla swaps/device selection and poll discovery.
- Add same-account input-only attachments and per-client input release.
- Add bounded fresh-ticket retries and automatic rendering fallback.
- Add server Opus decoding and Web Audio output based on the IPTV audio approach.
- Keep game latency bounded with a small jitter buffer and direct worker/audio port.
- Add Remote Play 360p/540p/720p/1080p, 30/60 fps, and configurable CPU encoder threads.
- Verify synthetic 1080p60 with software rendering, real audio samples and UI stalls.
- Include a Docker HTTPS overlay and document differences from Moonlight.

Target hardware acceptance remains open: actual console pairing/gameplay, Tesla
controller mappings, sustained FPS, speaker routing and audiovisual latency.


## WebRTC video transport (spec/webrtc.md, approved 2026-09-19)

An unreliable WebRTC data channel carries video next to the WebSocket, which
stays the default, the fallback and the carrier of everything else. The
captures of 2026-09-19 set the target: at 1080p60 a dip in link rate left video
2.1–2.6 s behind for 27 s because nothing gave up late frames.

### Decisions

- Dependency order: library spike → pure fragment/reassembly modules → one
  end-to-end path on loopback → sender backlog skipping → fallbacks →
  diagnostics and loss test → ports and docs → emulated-link and car
  validation. The spike is first because every server task depends on the
  library and it can fail the 30 Mbps criterion outright.
- The sender skips to the next keyframe when the channel's buffer passes about
  100 ms of video (spec: Sender backlog). Without it the data channel queues
  exactly what TCP queued. The spike must show the library exposes the
  buffered amount; one that does not is out.
- The page owns the peer connection because the stream worker cannot
  (`web/stream-runtime.js:23` opens the socket inside `web/stream-worker.js`).
  Signaling is relayed page ↔ worker ↔ WebSocket. The channel is transferred
  to the worker when the browser allows it, otherwise buffers are forwarded.
- Signaling messages arrive through `SoftwareInputRouter.ReceiveAsync`, the
  only reader of the socket; it gains `rtc-offer` / `rtc-candidate` the way it
  has `keyframe` and `telemetry`.
- Spike code lives under `spikes/webrtc/` on its own branch and is not merged.
  Its numbers go into the spec's Tech Stack section and the commit message.
- One branch per phase off `main`, one test-first commit per task.

### Checkpoints that need a person

1. After task 1: library choice (spec: Ask first). After task 2: car result.
2. After task 7: first LAN session against the real PS5 before fallbacks.
3. Before task 12: publishing `WEBRTC_PORT/udp` in Compose and the Proxmox
   installer, and forwarding that UDP port on the router (spec: Ask first).
4. Task 14 is a car session; task 15 changes the default only after it passes.

### Risks

| Risk | Impact | Mitigation |
|---|---|---|
| SIPSorcery's managed SCTP cannot sustain 30 Mbps | High | Spike measures it first; criterion 3 removes it if so |
| libdatachannel has no .NET binding; needs a C shim, P/Invoke and a Docker build stage | High | Spike builds it in the image, not on the host, so the cost is known before choosing |
| Library hides the send buffer, so backlog skipping is impossible | High | Spike acceptance requires it |
| Bridge-network Compose advertises a container address the browser cannot reach | Med | `WEBRTC_PUBLIC_ADDRESS` / advertised LAN address from task 6; production uses host networking (`compose.lxc.yaml`) |
| Channel transfer to a worker missing in the car's Chrome | Med | Task 2 measures it; forwarding path is built either way |
| Keyframe recovery too costly at 1–2 % loss | Med | Task 13 measures; spec names `maxPacketLifeTime` as the first thing to try, after a spec update |
| A settings change still locks the console out for 40–70 s | Med | Not part of this plan; transport changes never restart the console session |

### Not in this plan

Found on 2026-09-19 and left for their own changes: the console stays
"occupied" for 40–70 s after a settings reconnect; controller buttons not
reaching the game (two unconfirmed causes: the focus gate at `web/app.js:60`,
and two event sequence counters at `ControllerService.cs:545` and
`FeedbackSenderService.cs:529`); no input counters in diagnostics.

### Decided by the user, 2026-09-19

- The Proxmox installer asks for the UDP port (task 12).
- WebRTC with fallback becomes the default transport once the car session
  confirms it works (task 15, after task 14). Opt-in until then.
- Build proceeds: tasks 1–4 first, stopping at checkpoint A for the library
  choice and the car's probe result.

### Open questions

1. Should the WebSocket path get the same backlog skipping? It is the fallback
   whenever UDP is blocked and has the same 2.4 s failure today. Asked
   2026-09-19, not answered yet; nothing in tasks 1–15 depends on it.
2. Spec Q3: audio on a second unreliable channel later?
