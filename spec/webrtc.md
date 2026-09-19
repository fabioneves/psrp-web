# Spec: WebRTC video transport

Status: **approved 2026-09-19, in build.** The car-session captures the
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
  New dependency: a WebRTC stack with DTLS + SCTP data channels. Candidates
  were SIPSorcery (managed) and libdatachannel (C API, usrsctp + libjuice).
  **libdatachannel v0.24.5, chosen by the user on 2026-09-19** after the spike
  left it as the only candidate; bound by P/Invoke on its C API and built in
  the `psn-build` image stage. See [Spike result](#spike-result-2026-09-19).
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
Isolated instance for browser tests (its WebRTC port is published on loopback, away from a dev stack's 8443):
  COMPOSE_FILE=compose.yaml COMPOSE_PROJECT_NAME=psrp-ui-test PORT=18081 WEBRTC_PORT=18444 WEBRTC_PUBLIC_ADDRESS=127.0.0.1 \
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
   the peer connection and data channel, waits up to a second for its own
   candidates, and sends one `{"type":"rtc-offer","sdp":…}`; the server
   answers with one `rtc-answer` holding every candidate it has. Nothing is
   trickled: the server's candidates are known up front and it learns the
   browser's address from the first connectivity check (spike, 2026-09-19).
   An offer the server cannot use is answered with
   `{"type":"transport","transport":"websocket","reason":…}`. Signaling
   inherits the ticket's authentication and travels over WSS, which also
   protects the DTLS fingerprints.
3. The server offers host candidates on one fixed UDP port (`WEBRTC_PORT`,
   default 8443): its LAN address, plus the public address when
   `WEBRTC_PUBLIC_ADDRESS` is set or `REMOTE_PLAY_DOMAIN` resolves. No STUN or
   TURN server is contacted.
4. Video starts on the WebSocket immediately, as today. When the data channel
   opens, the server switches to it at the next keyframe and tells the browser
   with `{"type":"transport","transport":"webrtc","frame":N}`, N being the
   first frame id on the channel. The first picture is never delayed by
   negotiation. Frame ids count up for the whole session; a later
   `"transport":"websocket"` message names the last id sent on the channel, so
   the browser can ignore channel frames that arrive after a fallback.

### Fallback

- Data channel not open within 5 s, or closed or failed mid-session: video
  continues or resumes on the WebSocket at the next keyframe. The console
  session is not restarted.
- The playback label and diagnostics show the transport actually in use and,
  after a fallback, why.

### Fragmentation and loss

- Each access unit (already wrapped in its `RPM1` envelope) travels as
  data-channel messages of at most 64 KiB: `uint32 frameId, uint16 index,
  uint16 count`, little-endian, then payload. A delta frame is one message and
  only keyframes are split; SCTP cuts a message into datagrams itself. Smaller
  fragments would save nothing, because a frame missing any part is abandoned
  whole, and each message costs the browser an event (decided 2026-09-19 on
  the spike's numbers; the first draft said 1100 bytes).
- The reassembler delivers a frame when all fragments arrived. It abandons a
  frame when a newer frame completes first or when no fragment of it has
  arrived for two frame intervals. The clock restarts with every fragment: a
  150 KB keyframe needs more than two intervals to cross even a fast link, and
  timing from its first fragment would drop every keyframe and ask for another
  without end. After abandoning a frame the browser discards everything until
  the next keyframe and sends the existing `{"type":"keyframe"}` message, at
  most once per 500 ms. The server side already handles it
  (`SoftwareSession.cs:113`).
- No retransmission in this version. If the spike shows keyframe recovery is
  too expensive on a 1–2 % loss link, `maxPacketLifeTime` of about one round
  trip is the first thing to try; this spec is updated before that is built.
- Bounds: at most 4 frames in reassembly, 2 MiB per frame plus its envelope
  (same limit as the receiver, 33 messages), enforced by the sender too;
  fragments for unknown or abandoned frames are dropped.

### Loss recovery (proposed 2026-09-19, task 16, not approved)

Field result that prompts it: at 1080p over mobile data the stream froze for
70 of 124 seconds while keyframe requests went from 2 to 55; at 720p the same
phone had one frozen second. Today every lost datagram costs a whole frame,
every lost frame costs a keyframe, and a 1080p keyframe is a burst of several
hundred datagrams that is itself likely to lose one and to congest the link.
Task 11's counters are there to confirm this on the next 1080p capture before
anything below is built.

1. **Retransmit, but only briefly.** The browser opens the channel with
   `maxPacketLifeTime: 250` instead of `maxRetransmits: 0`. SCTP then repairs a
   lost datagram in about one round trip and gives the message up after
   250 ms. A loss costs one late frame, not a keyframe. This replaces "no
   retransmission in this version"; nothing is ever held longer than the
   lifetime, so delay still cannot build the way it does on TCP.
2. **The browser waits for the late frame.** Frames are delivered in frame-id
   order. A complete frame whose predecessor is still missing is held for up
   to 300 ms (at most 24 frames, 8 MiB); only when that runs out is the
   missing frame abandoned and a keyframe asked for. "Abandon when a newer
   frame completes first" goes away: with retransmission a newer frame
   completing first is normal.
3. **No keyframe storms.** The browser asks at most once a second instead of
   every 500 ms, and the server ignores a request while the keyframe it
   already asked the console for has not yet gone out.
4. **Sender backlog** stays as it is: it is what handles a link that cannot
   carry the stream, which retransmission cannot help.
5. **Tests.** Rehearsed loss moves below SCTP, where retransmission can see
   it: the browser test runs a small lossy UDP relay and the server advertises
   the relay's port (new `WEBRTC_PUBLIC_PORT`, also useful where the same port
   number cannot be forwarded). Accept: at 1 % datagram loss the 720p test
   stream holds over 55 fps with no keyframe requests; at 1080p on the phone,
   fewer than one frozen second a minute.

Cost: up to 250 ms of extra delay for the few frames behind a loss, caught up
by the frame queue's existing drop policy. Risk: usrsctp's fast retransmit
under real cellular loss patterns is unmeasured; the relay test and one phone
session decide whether 250 ms is the right lifetime.

### Sender backlog

A data channel is still congestion-controlled and buffers what the link cannot
take, so an unreliable channel alone would reproduce the 2.4 s excursion in the
[2026-09-19 captures](#result-2026-09-19) as queued fragments instead of queued
TCP bytes.

- Before fragmenting an access unit the server reads the channel's buffered
  amount. Above a limit of a quarter second of the ticket's bitrate, and never
  less than 192 KiB, it skips the unit and keeps skipping until a keyframe
  arrives that finds the buffer down to a quarter of the limit, asking the
  console for one through the existing keyframe path at most once per 500 ms.
  Frame ids are not used up by skipped units, so the browser sees no gap.
- The limit must let one keyframe through. A 150 KB keyframe legitimately sits
  in the buffer for 100–200 ms on a 6–10 Mbps link; "skip on anything
  buffered", as this section first said, would have skipped the frames behind
  every keyframe, asked for another, and looped.
- The buffered amount does not count what already sits in the SCTP stack's own
  send buffer, 1 MiB by default, which at 10 Mbps is 0.8 s of video: in the
  spike the number first moved 1.1 s into a rate dip. The server sets that
  buffer to 128 KiB (first movement after 0.36 s in the same dip, no cost at
  30 Mbps on a clean link). Both numbers are constants; task 13's rate-dip run
  is what confirms or corrects them.
- Skipped units and the keyframe requests they cause are counted in telemetry
  separately from receiver-side abandonment.

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
2. On an emulated link with 80 ms round trip, both at 10 Mbps:
   (a) through a 30 s dip to 4 Mbit/s, WebRTC video age is back under 150 ms
   within 1 s of the dip ending while WebSocket in the same run is not;
   (b) at 0.1 % loss for 5 minutes, WebRTC keeps `transportP95` below
   RTT/2 + 40 ms and input-to-picture delay does not drift upward.
   (Replaced 2026-09-19: the first draft asked for 10 Mbps at 2 % loss, which
   no loss-based transport delivers; see Spike result.)
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

## Spike result, 2026-09-19

Branch `spike/webrtc` (`3b88d52`, not merged), 79 result files under
`spikes/webrtc/results/`. Senders in Docker with host networking, receiver
headless Chrome 150 on the same host, delay from a same-host clock comparison.
1100-byte unreliable unordered messages unless stated.

| | libdatachannel v0.24.5 | SIPSorcery 10.0.16 |
|---|---|---|
| 10 Mbps offered | 10.0 received, delay 0.1 / 0.4–0.7 / 7–14 ms (median / p95 / max), 6–7 % of a core, 15 MB | 1.4–2.7 received, delay p95 14–17 s, memory growing past 350 MB |
| 30 Mbps offered | 30.0 received, 0.04–0.08 / 0.4–0.7 / 8–10 ms, 12–13 % | 1.4–2.2 received |
| 60 Mbps offered | 60.0 received, 18 % | not run |
| Gives up lost messages (`maxRetransmits: 0`) | Yes: under 2 % loss 1.9–2.0 % of messages missing and delay flat | **No**: no partial reliability in its SCTP; under the same loss nothing missing and delay p95 2.0 s |
| Buffered amount | `rtcGetBufferedAmount`, follows a backlog up and down | present, but each read walks the whole queue (up to 5 ms) |
| Fixed UDP port | `portRangeBegin = portRangeEnd`; extra public address only by adding a candidate line to the answer SDP | constructor argument, even ports only, so 8443 fails; public address through its API |
| Cost | P/Invoke on its C API, no shim; one build stage in the existing `psn-build` image; 2.6 MB added to the runtime image | one package, about 11 MB |

SIPSorcery fails criterion 3 and cannot give up late data at all, so the
tie-break for managed code never applies.

Other findings the design now depends on:

- **Rate dip, the 2026-09-19 failure shape.** 10 Mbps with 5 s at 4 Mbit/s:
  without sender skipping, delay reached 4.1 s during the dip, and was back
  under 1 ms within 0.28 s of the dip ending, 1.7 % of messages abandoned.
  The WebSocket in the car took 27 s to recover from the same shape.
- **Loss caps the rate, in any library.** With 2 % loss and 40 ms round trip
  the channel delivers about 4 Mbps whatever is offered, with all four of
  usrsctp's congestion-control modules (1.7–3.9 Mbps). That is the loss-based
  throughput limit and TCP obeys it too. **Success criterion 2 as written
  (10 Mbps at 2 % loss and 80 ms) cannot be met by either transport.** The car
  sustained 7.5 Mbps over TCP at about 100 ms, which puts its real loss rate
  well under 0.1 %. See Open Question 5.
- **Message size.** At 10 Mbps the receiving renderer used 9–10 % of a core
  with 1100-byte messages (1136 a second), 4 % at 16 KiB, 3 % at 64 KiB, for
  1–2 ms more delay on a clean link. Both sides advertise a 256 KiB maximum.
  See Open Question 6.
- **Worker.** Chrome 150 accepts a transferred `RTCDataChannel`; 68,182 of
  68,182 messages arrived in the worker. With the main thread busy half the
  time, a transferred channel kept p95 at 0.15 ms where forwarding through
  the page rose to 7.3 ms. Transfer is the mode to build; forwarding stays
  as the fallback the probe decides.
- **Signaling.** Both libraries give a complete non-trickle answer on a fixed
  port, and Chrome connected from a single offer holding one mDNS host
  candidate, in 57 ms to libdatachannel. No candidate messages are needed.

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
5. ~~Success criterion 2 cannot be met as written.~~ **Decided 2026-09-19:**
   replaced by the rate-dip and 0.1 % loss scenarios now in criterion 2.
6. ~~Fragment size.~~ **Decided 2026-09-19:** messages of up to 64 KiB; see
   Fragmentation and loss.
