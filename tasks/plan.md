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

### From moonlight-web-stream-tsla (read 2026-09-19, user's pointer)

github.com/Argon2000/moonlight-web-stream-tsla streams Sunshine to the Tesla
browser. It sends video as a WebRTC **media track** (webrtc-rs 0.14), audio
and input over data channels; it has no video-over-data-channel path, so
nothing there can be reused for fragments or backlog. It is GPL-3.0-or-later:
read for facts, copy nothing. Its dated field notes are the useful part. They
are that project's observations, not ours; each is marked with what we do
about it.

| Their finding (file) | Bearing on this plan |
|---|---|
| Tesla renderer stalls scale with per-message cost; ~6.3 Mbps over a media track gave regular ~270 ms stalls, ~2.6 Mbps none (`settings_menu.ts:226`) | Biggest new risk. 10 Mbps in 1100-byte fragments is ~1100 JS events a second; our WebSocket delivers 60. The spike now also measures 16 KiB and 64 KiB messages (SCTP fragments natively, one event per frame) and the receiving Chrome's CPU. `MaxPayload` stays a constant in both modules so the spike can decide it. Our own car probe moved 30 Mbps of 1100-byte messages with no loss on 2026-09-18, but with no video decoding beside it. |
| webrtc-rs mis-parses FORWARD-TSN, so they keep every browser→server channel reliable (`input.ts:164`) | Partial reliability is only as good as the sender's SCTP. The spike must show each library really abandons lost messages with `maxRetransmits: 0`; one that retransmits anyway is out. Our browser sends nothing on the video channel, so their exact bug cannot hit us. |
| Non-trickle ICE, because the Tesla browser "drops the WS send path after the initial offer"; WebSocket connects fail about half the time (`index.ts:987`, README) | Our WebSocket carries input from the car all session, so the first claim does not match what we see. Non-trickle is still simpler with one fixed server port: one offer, one answer, no candidate messages. Proposed for task 6; the spike confirms both libraries can do it. Needs the spec's Negotiation step 2 changed. |
| IDR requests rate-limited to 300 ms after PLI→IDR storms made freezes longer (`video.rs:436`) | Same idea as our 500 ms limit on both sides. No change. |
| Keyframe bursts paced at 3× bitrate (`sender.rs:164`) | SCTP's congestion window paces a data channel; the spike's delay max at 30 Mbps shows whether that is enough. |
| Shorter ICE timeouts for cellular: 4 s disconnected, 8 s failed; a network switch once cost 37 s (`main.rs:222`) | Task 10 (mid-session fallback) should not wait for the library's default failure timeout. Criterion 5 already demands under 2 s. |
| 2D canvas fed by VideoFrame capped near 30 fps on Tesla; they use `bitmaprenderer` (`canvas.ts:9`) | Not what we measure: the car held 57–60 fps on "Canvas 2D · worker" on 2026-09-19. No change. |
| `<video>` playback is killed in drive mode (`canvas.ts:59`) | Confirms the spec's choice not to use a media track into a video element. |
| Rumble's `playEffect()` stalls the Tesla main thread and causes micro-stutter; they ignore rumble in the car (`input.ts:1238`) | Outside this plan. We have rumble on; the captures of 2026-09-19 show `rumble=0`, so it played no part in them. Worth an A/B in the car. |
| Audio primed to 240 ms after 200–300 ms cellular radio pauses drained 150 ms (`audio_playback_worklet.js:43`) | Outside this plan. Our capture had 143 ms queued and 26 underruns; relevant to spec Open Question 3. |
| Mirrored gamepads: one press can show on the physical and the virtual pad; prefer the physical (`input.ts:1160`) | Matches `web/gamepad.js:54`. Nothing there about a focus requirement or lost buttons. |

### Decided by the user, 2026-09-19

- The Proxmox installer asks for the UDP port (task 12).
- WebRTC with fallback becomes the default transport once the car session
  confirms it works (task 15, after task 14). Opt-in until then.
- Build proceeds: tasks 1–4 first, stopping at checkpoint A for the library
  choice and the car's probe result.

### Spike outcome, 2026-09-19

Full table in the spec (Spike result). libdatachannel is the only candidate
left: SIPSorcery delivered 1.4–2.7 Mbps of 10 offered and has no partial
reliability. Consequences for the tasks: task 6 binds libdatachannel's C API
by P/Invoke and adds a build stage to the `psn-build` image, signals with one
offer and one answer, and adds the public address as a candidate line in the
answer; task 7 transfers the channel to the worker and keeps forwarding as
the fallback; task 8 sets a 128 KiB SCTP send buffer and skips on any
buffered amount; task 13 waits on spec Open Question 5, because criterion 2
as written is beyond any loss-based transport.

### Decided by the user, 2026-09-19 (checkpoint A)

libdatachannel; messages of up to 64 KiB instead of 1100-byte fragments;
criterion 2 replaced by a rate-dip and a 0.1 % loss scenario; deploy the
branch so the probe's worker check can run in the car. Whether the WebSocket
path gets backlog skipping was listed beside these but not among the four
questions asked, so it stays open.

### Field results, 2026-09-19 evening (iPhone, Chrome on iOS, mobile data)

Captures on the production server: `20260919T190916Z.json` (720p60, 6 Mbps) and
`20260919T191905Z.json` (1080p60, 10 Mbps), both over WebRTC through the
forwarded UDP 8443.

- **WebRTC works from outside, on WebKit too.** 720p: 133 s at a median 59 fps,
  video never more than 264 ms behind, through a 2.3 s pause in arrivals; one
  second at 0 fps; keyframe requests 2 → 8.
- **1080p is not usable yet.** 70 of 124 seconds at 0 fps, freezes of 37 s and
  19 s, keyframe requests 2 → 55, the server's backlog skipping firing ten
  times. Delay was about 100 ms until the first event, so the link carried the
  stream; what fails is recovery. Best explanation, not yet proven because the
  captures carry no reassembler counts (task 11): a 1080p keyframe is several
  hundred datagrams, nothing is retransmitted, so one lost datagram loses the
  whole keyframe; the browser asks again every 500 ms, the bursts congest the
  link and lose the next one too. The Moonlight fork's notes describe the same
  storm. The spec's "no retransmission in this version" is what has to change
  for keyframes: task 16 below.
- **Console lockout.** With the goodbye acknowledged (`e291b1a`) the PS5 freed
  the session in about 8 s, twice, against 42 s to over 2 minutes before. A
  session that ends before its stream starts still cannot say goodbye.

### Added tasks

- [ ] **16. Keyframes survive loss.** Decide and specify first (spec change:
  retransmission was "Ask first"). Candidates: a partially reliable lifetime
  for key units with the browser holding the deltas that overtake them; a
  slower keyframe request rate so storms cannot build; pacing keyframes.
  Needs task 11's counters to confirm the cause, and a 1080p car or phone
  session to accept.
- [ ] **17. A session that dies while starting says goodbye.** Finish bringing
  the console stream up under its own short deadline, then stop it normally.

### Open questions

1. Should the WebSocket path get the same backlog skipping? It is the fallback
   whenever UDP is blocked and has the same 2.4 s failure today. Asked
   2026-09-19, not answered yet; nothing in tasks 1–15 depends on it.
2. Spec Q3: audio on a second unreliable channel later?
