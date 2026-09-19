# Spec: WebRTC video transport

Status: **approved for planning 2026-09-19.** The car-session captures the
[Decision gate](#decision-gate) asked for exist and point at transport, not
decoding. Plan and tasks: `tasks/plan.md`, `tasks/todo.md`.

## Objective

Add a second way to carry video from the server to the browser: an unreliable
WebRTC data channel over UDP, next to the existing WebSocket over TCP. The user
is someone playing from a Tesla on mobile data. On a lossy link TCP holds every
later frame behind one lost packet, so delay climbs and frames arrive in bursts.
UDP lets the server and browser give up on a late frame instead, keeping delay
steady at the cost of an occasional short freeze.

Both transports stay. WebSocket remains the default, the fallback when UDP is
blocked, and the baseline for comparison.

What changes and what does not:

- Only H.264/H.265 video access units move to the data channel. The server still
  forwards the console's frames unchanged; nothing is decoded or re-encoded.
- The WebSocket stays open for the whole session and keeps carrying sign-in
  ticketing, status, ping/pong, controller input, rumble, console stats, audio,
  and now WebRTC signaling.
- The browser keeps WebCodecs decoding, `web/frame-queue.js` pacing
  (Smooth/Balanced/Responsive), the 32-byte `RPM1` timing envelope and the
  diagnostics log. Video is **not** sent as a WebRTC media track, so Chrome's
  jitter buffer never takes over pacing and H.265 keeps working.
- MPEG-1 Canvas mode always uses WebSocket: its MPEG-TS byte stream needs
  ordered, reliable delivery.
- Input-only clients (phone as second controller) are unaffected.

### Assumptions to confirm

1. One viewer per server stays the rule, so one UDP port is enough.
2. The server is reachable from the internet on a forwarded UDP port, the same
   way 443/TCP is forwarded today (confirmed acceptable). No TURN relay in this
   version: if UDP does not connect, the session uses WebSocket.
3. Audio stays on the WebSocket in this version. Once video leaves the socket,
   audio no longer queues behind it.
4. Controller input stays on the WebSocket. A lost button release is worse than
   a late one.
5. The Tesla browser supports `RTCPeerConnection` data channels and the car's
   network allows outbound UDP. **Verified 2026-09-18** with `/probe.html` in
   the car (Chrome 148) on two networks, a phone hotspot and Tesla Premium
   Connectivity: data channels present, both public STUN servers answered over
   UDP, and two in-page peers exchanged 30 of 30 Mbps in 1100-byte unreliable
   messages with 0 % loss. Both networks map a different public port per
   destination (symmetric NAT), which the forwarded-port design does not
   depend on. The browser is current Chromium, so nothing here needs to allow
   for an old engine.

## Tech Stack

- Server: .NET 10, ASP.NET Core, existing `RemotePlay/Services/Software/*`.
  New dependency: a WebRTC stack with DTLS + SCTP data channels. Candidates are
  SIPSorcery (managed; upstream used 8.0.23 before this fork removed it in
  `22c9119`) and libdatachannel through the existing `native/` CMake build.
  The rule is decided: use whichever gives the lowest added latency. The spike
  in the build order measures that; it is not chosen up front.
- Browser: plain ES modules in `web/`, no bundler dependencies.
  `RTCPeerConnection` + `RTCDataChannel` (`ordered: false, maxRetransmits: 0`).
- Tests: `node --test`, Playwright 1.58.2 with system Chrome, C# console test
  runner in `tests/backend`.

## Commands

```
Run:            docker compose up --build -d
Unit tests:     npm run test:unit
Backend tests:  docker build --target test -t player-one-tests .
Browser tests:  TEST_URL=http://127.0.0.1:18081 npx playwright test
Isolated instance for browser tests:
  COMPOSE_FILE=compose.yaml COMPOSE_PROJECT_NAME=psrp-ui-test PORT=18081 \
  ALLOW_REGISTRATION=true DISCOVERY_SUBNETS= docker compose up --build -d
Live telemetry: docker compose logs -f remote-play | rg 'Stream telemetry'
```

## Project Structure

```
RemotePlay/Services/Software/
  SoftwareSession.cs        existing; picks the video sender per ticket, owns fallback
  StreamTickets.cs          existing; ticket gains Transport ("websocket" | "webrtc")
  RtcVideoChannel.cs        new; peer connection, signaling, data channel lifetime
  FrameFragmenter.cs        new; pure: access unit -> datagram-sized fragments
RemotePlay/Controllers/SoftwareController.cs   existing; validates the ticket's transport
web/
  stream-runtime.js         existing; owns the WebSocket, gains the signaling messages
  rtc-video.js              new; peer connection + data channel, reports open/failed
  frame-reassembler.js      new; pure: fragments -> complete access units, drop policy
  app.js, index.html        existing; Transport setting under Stream settings -> Advanced
tests/
  frame-reassembler.test.mjs   new; loss, reorder, duplicates, deadlines
  backend/RtcTests.cs          new; fragmenter round trip, ticket validation
  browser/webrtc.spec.js       new; end to end on loopback, fallback, diagnostics
compose.yaml, deploy/proxmox/install.sh        publish WEBRTC_PORT/udp
docs/architecture.md, README.md                wire format, setup, troubleshooting
```

## Design

### Negotiation

1. `POST /api/software/tickets` accepts `transport`. `webrtc` is rejected with
   400 for `mpeg1`.
2. The browser opens the WebSocket as today. For a `webrtc` ticket it creates
   the peer connection and data channel, then sends
   `{"type":"rtc-offer","sdp":…}`; the server answers with `rtc-answer`; both
   sides trickle `rtc-candidate`. Signaling inherits the ticket's
   authentication and travels over WSS, which also protects the DTLS
   fingerprints.
3. The server offers host candidates on one fixed UDP port (`WEBRTC_PORT`,
   default 8443): its LAN address, plus the public address when
   `WEBRTC_PUBLIC_ADDRESS` is set or `REMOTE_PLAY_DOMAIN` resolves. No STUN or
   TURN server is contacted.
4. Video starts on the WebSocket immediately, as today. When the data channel
   opens, the server switches to it at the next keyframe and tells the browser
   with a `status`-style `transport` message. The first picture is never
   delayed by negotiation.

### Fallback

- Data channel not open within 5 s, or closed or failed mid-session: video
  continues or resumes on the WebSocket at the next keyframe. The console
  session is not restarted.
- The playback label and diagnostics show the transport actually in use and,
  after a fallback, why.

### Fragmentation and loss

- Each access unit (already wrapped in its `RPM1` envelope) is split into
  fragments of at most 1100 bytes so one lost datagram costs one fragment:
  `uint32 frameId, uint16 index, uint16 count`, little-endian, then payload.
- The reassembler delivers a frame when all fragments arrived. It abandons a
  frame when a newer frame completes first or when it is older than two frame
  intervals. After abandoning a frame the browser discards everything until
  the next keyframe and sends the existing `{"type":"keyframe"}` message, at
  most once per 500 ms. The server side already handles it
  (`SoftwareSession.cs:113`).
- No retransmission in this version. If the spike shows keyframe recovery is
  too expensive on a 1–2 % loss link, `maxPacketLifeTime` of about one round
  trip is the first thing to try; this spec is updated before that is built.
- Bounds: at most 4 frames in reassembly, 2 MiB per frame (same limit as the
  receiver), fragments for unknown or abandoned frames are dropped.

### Sender backlog

A data channel is still congestion-controlled and buffers what the link cannot
take, so an unreliable channel alone would reproduce the 2.4 s excursion in the
[2026-09-19 captures](#result-2026-09-19) as queued fragments instead of queued
TCP bytes.

- Before fragmenting an access unit the server reads the channel's buffered
  amount. Above a threshold worth about 100 ms of the ticket's bitrate it skips
  the unit, keeps skipping until a keyframe, and asks the console for one
  through the existing keyframe path, at most once per 500 ms.
- Skipped units and the keyframe requests they cause are counted in telemetry
  separately from receiver-side abandonment.
- The threshold is a constant confirmed by the spike, not a setting.

### Worker

The stream runs in `web/stream-worker.js`, where `RTCPeerConnection` does not
exist. The page owns the peer connection and relays signaling to the worker's
WebSocket. The data channel is transferred to the worker when the browser
supports transferring one; otherwise the page forwards each message's buffer
to the worker by transfer. The spike measures both in the car's Chrome and the
probe page reports which is available.

### Setting

Stream settings → Advanced → **Transport**:
`WebSocket · reliable, works everywhere` (default) and
`WebRTC · lower delay on lossy links, falls back to WebSocket`.
Saved with the other stream settings; hidden for Canvas mode.

### Diagnostics

Per-second metrics gain: transport in use, fragments received, frames abandoned,
keyframe requests caused by transport loss, and the selected candidate pair's
round trip and type from `RTCPeerConnection.getStats()`. `transportP95` keeps
its meaning because the envelope is unchanged. Server telemetry logs the same
counters plus fallback events.

## Code Style

Match the surrounding code: dense C# with primary constructors and
expression-bodied members, no comment that restates the line; small ES modules
exporting pure functions where possible so `node --test` can cover them.

```csharp
public static class FrameFragmenter
{
    public const int MaxPayload = 1100;
    public static IEnumerable<byte[]> Split(uint frameId, ReadOnlyMemory<byte> packet) { … }
}
```

```js
export function createReassembler({ frameIntervalMs, now = () => performance.now() }) {
  return { push(fragment) { … }, metrics: () => ({ abandoned, fragments }) };
}
```

## Testing Strategy

- **Unit, JS** (`tests/frame-reassembler.test.mjs`): in-order delivery, reorder,
  duplicates, a lost fragment abandons only that frame, newer-complete and
  deadline abandonment, keyframe-request rate limit, memory bounds.
- **Backend** (`tests/backend/RtcTests.cs`): fragmenter round trip for 1 byte,
  exactly 1100 bytes, and 2 MiB; `count` overflow rejected; ticket validation.
- **Browser** (`tests/browser/webrtc.spec.js`), against the isolated instance
  with the real test stream:
  - WebRTC selected → label shows WebRTC, 720p60 H.264 sustains > 55 fps.
  - UDP unreachable (server started with an unroutable advertised address) →
    playback runs on WebSocket within 6 s, label and diagnostics say why.
  - Data channel closed mid-session → video resumes on WebSocket without a new
    console session.
  - Test-only server option drops 2 % of fragments → playback continues,
    abandoned frames and keyframe requests appear in diagnostics, media-ready
    to canvas age stays bounded.
- Every test is written to fail first. Existing suites must stay green; the
  performance-bound tests keep their CI skip.

## Boundaries

- **Always:** keep WebSocket working unchanged as default and fallback; keep
  the `RPM1` envelope; bound every queue; authenticate signaling through the
  existing ticket; update `docs/architecture.md` and README setup steps in the
  same change as the behavior.
- **Ask first:** the WebRTC library choice (new dependency, possibly native);
  changing the default transport before criterion 6 holds (after it, see Open
  Question 2); moving audio or input off the WebSocket;
  adding STUN/TURN; publishing a new port in `compose.yaml` and the Proxmox
  installer; any retransmission or FEC scheme.
- **Never:** decode or re-encode video on the server for this; send video as a
  WebRTC media track; restart the console session to change transport; log
  SDP with ICE credentials at information level; weaken or skip existing tests.

## Success Criteria

1. With Transport = WebRTC on a clean LAN, the test stream and a real PS5
   session play at the same frame rate as WebSocket, and median media-ready to
   canvas age is no worse than WebSocket's by more than 5 ms.
2. Under emulated 80 ms RTT and 2 % loss at 10 Mbps, WebRTC keeps
   `transportP95` below RTT/2 + 40 ms for a 5-minute run while WebSocket in
   the same conditions does not. Input-to-picture delay does not drift upward.
3. 1080p at 30 Mbps sustains 60 fps over the data channel on the LAN. A
   library that cannot is out, whatever its latency.
4. With UDP blocked, playback starts within 6 s on WebSocket with no user
   action, and the reason is visible in diagnostics.
5. A mid-session data channel failure recovers to WebSocket in under 2 s
   without reconnecting the console.
6. A car session on mobile data shows fewer delay excursions than the
   WebSocket baseline capture taken in the same place.
7. All existing unit, backend and browser tests pass; the new tests failed
   before their implementation.

Numbers in 2 and 6 are provisional until the baseline capture exists.

## Decision gate

Before planning, read a car-session capture (**Stream diagnostics → Send to
server**) and compare `transportP95` and `arrivalMax` with `rtt` during the bad
stretches:

- Transport well above round trip → TCP stalls are the cause; proceed.
- Transport near round trip, stalls line up with decode time or long tasks →
  the browser is the bottleneck; this spec is shelved and the work goes to
  decode and pacing instead.

### Result, 2026-09-19

Two captures from a Model Y (Chrome 148), saved on the production server as
`20260919T110049Z.json` (720p60, 6 Mbps) and `20260919T111146Z.json` (1080p60,
10 Mbps, Smooth):

- The browser is not the bottleneck: median decode 1.3 ms, no long tasks in
  either capture.
- At 1080p the link dipped to about 4 Mbps under a 7.5 Mbps stream at 410 s.
  Video age rose to 2.1–2.6 s and stayed there for 27 s at 45–58 fps: the
  backlog was delivered in order instead of being given up. Ten shorter
  excursions (0.3–1.2 s) show the same shape. The server shed nothing
  (`serverDropped=0`); its video queue waits when full
  (`SoftwareReceiver.cs:15`).
- The comparison above is weaker than it reads: `rtt` comes from ping/pong on
  the same WebSocket as the video (`SoftwareInputRouter.cs:48`), so a backlog
  inflates both numbers and the ratio stays near 1 (median 0.84 here, with rtt
  itself reaching 2.8 s). Read video `age` instead; the candidate pair's round
  trip from `getStats()` gives WebRTC sessions an independent figure.
- These two files are the WebSocket baseline for success criterion 6.

What the captures also show: a transport that can drop late data does nothing
unless the sender drops it. See [Sender backlog](#sender-backlog).

## Build order (for /plan, once approved)

1. Library spike: each candidate sends 10 and 30 Mbps of 1100-byte unreliable
   messages to Chrome on the LAN. Measure send-to-receive delay per message
   (median, p95, max), then rate, loss and CPU. Pick the lowest p95 delay among
   candidates that sustain 30 Mbps; ties go to the one without native code.
2. Fragmenter and reassembler as pure modules with tests.
3. Signaling + data channel + switch-over at keyframe, behind the setting.
4. Fallback paths.
5. Diagnostics, docs, port publishing in Compose and the Proxmox installer.
6. Car validation against the baseline.

## Open Questions

1. ~~Should the Proxmox installer ask for the UDP port, or only document it?~~
   **Decided 2026-09-19: it asks**, with `WEBRTC_PORT`'s default offered.
2. ~~Should the default become "WebRTC with fallback" once criterion 6 holds, or
   stay opt-in?~~ **Decided 2026-09-19: it becomes the default** once the car
   session confirms criterion 6. Until then it is opt-in. MPEG-1 Canvas mode
   keeps WebSocket either way.
3. Audio: leave on the WebSocket for good, or move to a second unreliable
   channel later if audio underruns still track TCP stalls?
4. Should the WebSocket path get the same [sender backlog](#sender-backlog)
   skipping? It stays the fallback wherever UDP is blocked and showed the
   2.4 s excursion on 2026-09-19.
