# Software stream architecture

## Session lifecycle

1. Browser signs into the upstream local-account service. API requests use a bearer
   token in page memory. An HttpOnly session cookie restores a valid login after
   refresh, up to the token's existing 24-hour expiration.
2. `POST /api/software/tickets` authenticates the user, validates the bitrate and
   checks their active console association. Demo tickets require authentication
   but no console. A cryptographically random ticket expires after 30 seconds.
3. `GET /api/software/stream?ticket=…` consumes the ticket once and atomically
   reserves the server's one viewer slot before upgrading to WebSocket.
4. For console playback, the server checks ownership again, opens the upstream
   session with H.264 and the selected resolution/frame rate, attaches `SoftwareReceiver`, requests an IDR
   and enables controller input. Secrets are never returned in a session response.
5. `SoftwareReceiver` removes the upstream `0x02` video packet prefix, caches
   codec headers, waits for an IDR and queues Annex B units with their arrival time. Opus audio packets lose their `0x01` prefix and are CPU-decoded to PCM.
6. In Canvas mode FFmpeg decodes on the CPU and encodes MPEG-1 without B frames at the selected profile. Its
   MPEG-TS output is sent as binary WebSocket messages. The browser demuxes,
   software-decodes reference frames and queues decoded pictures for presentation according to the selected pacing mode.
   In H.264 and H.265 mode no FFmpeg process runs: each console access unit is sent as
   its own binary message (envelope kind 3) and handed straight to WebCodecs. The test
   stream splits the generator's raw Annex B output on access unit delimiters.
7. Socket closure, an input error, encoder failure, idle timeout or cancellation
   stops workers and child processes, stops the stream/session and releases the slot.

## Wire messages

Browser → server JSON:

```json
{"type":"ping","clientTime":1780000000000}
{"type":"button","button":"CROSS","pressed":true}
{"type":"stick","stick":"left","x":-1,"y":0}
{"type":"triggers","l2":0.4,"r2":0.8}
{"type":"reset"}
{"type":"keyframe"}
```

`keyframe` (viewer connection only) makes the receiver wait for the next IDR and
asks the console for one; the browser sends it after replacing a decoder that
failed on a corrupt frame.

The button names are the upstream `FeedbackEvent.ButtonType` names. `reset`
releases buttons, centers both sticks and releases both triggers. L2/R2 update
both the button event and analog trigger state. Directions are clamped to [-1,1].

Server → browser text messages contain `type` (`status` or `error`) and `message`,
a timestamped `pong`, a `rumble` message with the console's left and right motor
values (0–255) whenever they change, or a once-per-second `console-stats` message with cumulative
console→server counters (packets lost, frames dropped/frozen/recovered, keyframe
requests, FEC failures, pending packets) plus the console's frame rate and bitrate.
The browser keeps a per-session diagnostics log of those counters, its own
per-second metrics and every stall, superseded frame, audio underrun and reconnect,
downloadable as JSON from Stream diagnostics or the debug HUD. The server logs the
final counters when a console stream ends. Every binary message starts with the RPM1 timing envelope
described below. Canvas video payloads contain consecutive MPEG-TS bytes, not necessarily a whole
frame or transport packet; JSMpeg handles arbitrary chunk boundaries. H.264/H.265 video
payloads are one complete Annex B access unit per message. Audio
payloads begin with ASCII `PCM1`, followed by little-endian uint32 sample
rate and channel count, then interleaved signed 16-bit little-endian PCM. Video, audio and pong sends share a semaphore: the WebSocket never has concurrent sends.
The worker dispatches PCM directly through a MessagePort to AudioWorklet; main-thread
Web Audio scheduling is the fallback. Audio packets carry samples rather than
console presentation timestamps, so exact A/V synchronization is not guaranteed.

## Bounds and failure behavior

- Eight queued H.264 buffers, maximum 2 MiB per console frame. Overflow fails the
  connection instead of dropping arbitrary H.264 reference frames silently.
- One outstanding WebSocket send, with a one-second send timeout. FFmpeg stdout
  stalls fail after 15 seconds. OS/socket buffers can still add latency.
- FFmpeg diagnostics retain at most the latest 4 KiB.
- At most 64 outstanding tickets; expired entries are pruned when issuing tickets.
- Client control messages are limited to 2 KiB and must be complete text messages.
- The browser sends a heartbeat every two seconds; ten seconds without a receive
  or without a heartbeat ends the connection.
- Browser decode buffer is 2 MiB. A decode batch exceeding 250 ms stops playback;
  zero video bytes for 30 seconds also stops it. The browser never reconnects with
  a spent ticket; each of up to five automatic retries obtains a fresh one.

Upstream packet reassembly and congestion handling remain in use. The reorder
flush loop now uses a four-millisecond asynchronous timer; upstream used a busy
spin and a hard-coded Stopwatch tick frequency, which differed on Linux.

## Deployment surface

Only login/register, console discovery/pairing/listing, software tickets, active-session metadata and
software streaming are exposed as HTTP API routes. Legacy debug/session-export,
file receiver and transcoding endpoints return 404. Console and ticket endpoints
require authentication; stream upgrades use single-use tickets. HTTPS terminates
at a reverse proxy for remote deployments.

Legacy SignalR hubs are not mapped; internal upstream notifications have no
external subscribers. Browser input and video share the authenticated software
stream connection.

The default Docker bridge supports directed console discovery/registration.
Host networking is optional for LAN broadcasts on rootful Linux. The database
is not published by the default Compose file.

## Input attachment and ownership

`GET /api/software/active` returns only the signed-in user's current session ID,
host ID, demo flag and attached-client count, or JSON null. A ticket request with
`inputSession` must name that user's active session. The WebSocket upgrade rechecks
the session and reserves one of four input slots. Such a connection receives no
media and has no FFmpeg process; it exchanges input and ping/pong only.

The shared input router serializes changes and aggregates per-connection state.
A disconnect removes that source's held controls. It cannot release another
source's buttons. Sticks use the largest vector magnitude; triggers use maximum
pressure. The viewer lifetime cancels its attachments. Old-session tickets cannot
attach to a replacement stream.

## Audio bounds

Opus output reuses a PCM scratch buffer. Thirty-two audio packets may wait on the
server; oldest PCM is discarded on overload to avoid accumulating stale sound.
The worklet ring holds at most half a second, with a selectable 40/120/240 ms
startup buffer. Buffer overruns clear the backlog; underruns re-prime. Muting
changes the output gain while draining samples. Stop closes the AudioContext,
ports, sources and workers. No hardware audio/video codec is required.

## Media-ready timing and audio alignment

Every binary message has a 32-byte `RPM1` envelope: little-endian uint32 kind
(1 MPEG-TS, 2 PCM, 3 H.264/H.265 access unit), then float64 readiness, send and media timestamps in Unix
milliseconds at offsets 8, 16 and 24. The payload begins at offset 32; audio retains
its existing PCM1 payload. MPEG-TS video uses the time FFmpeg output became available and
access units use the time the console frame reached the receiver;
audio uses packet readiness minus its sample duration as the first-sample estimate.
Sending stamps the time after acquiring the shared video/audio/pong send semaphore.

Viewer and input-only ping replies echo clientTime and include server received/sent
times. The client chooses the least delayed offset estimate from the latest 20
samples; RTT excludes server processing/queue time. The browser reports media-ready
to canvas age, estimated transport age, peak send-gate wait, and presentation wait.
This envelope change requires reloading older clients when deploying the server.

A completed video PES carries the readiness of the transport chunk that completed
it through the decoder and newest-frame buffer. Each canvas presentation sends
that timestamp directly to the audio worklet. The worklet advances it with its
sample clock, keeps a 40 ms playout reserve, trims stale PCM and
holds early PCM with a 20 ms tolerance. Reported audio output delay is included
in the audio-lag estimate rather than used to demand playback before packets arrive. The sync anchor expires after 500 ms without
a presentation. PCM overruns clear the bounded queue; reconnect resets both clocks.
The scheduled Web Audio fallback uses the same timestamps to drop late packets and
reschedule when skew exceeds 80 ms, with less precise timing during UI stalls.

These clocks track server media availability, not console capture. Video timestamps
are assigned at completed transport chunks, so encoding and PES packetization also
limit A/V accuracy. Alignment skew is the worklet sample-head difference from the reserved
playout target. Audio lag also includes the reserve and reported output delay. No physical speaker, scanout, console-to-server or input latency is
measured. See optimization.md for the tradeoff and validation scope.

## Rendering and automatic quality

Frame pacing is selected independently of codec and output. Smooth uses an
adaptive one-to-three-frame presentation cushion. Balanced fixes the target at
one frame, holds at most two decoded pictures and skips a picture older than two
frame intervals when a newer one is available. Responsive retains only the latest
decoded picture. All modes decode required reference frames before dropping
presentation output, and release discarded pictures. Pacing is stored in account
preferences and per-console profiles; changing it during playback uses Apply and
the existing reconnect path.

Reference decoding and pixel presentation are separate. A burst still decodes its
references; decoded pictures enter the bounded presentation queue. The software
path reuses a YUV buffer pool and converts pixels only for the picture being drawn.
Presentation uses requestAnimationFrame where available (a 60 Hz timer otherwise).
Color conversion uses WASM SIMD with a 32 MiB fixed memory; failed capability/load
checks select the original JavaScript converter. No GPU path is introduced.

Automatic quality is opt-in. It requires three unhealthy samples after startup
and cooldown; network queue pressure lowers bitrate before resolution, while
browser processing cost or low presentation rate lowers resolution first. The
floor is 360p30. Recovery requires 30 seconds of healthy samples and at least 45
seconds since the previous change. Hidden pages reset the observation window.
Profiles never exceed the selected ceiling. Each change uses a fresh authorized
ticket and the existing session teardown/reconnect path; manual apply disables
automatic changes. Profile changes therefore briefly interrupt media.


## Browser login persistence

Same-origin browser login requests receive a host-only `remote-play-session` cookie scoped to
`/api/auth`, with HttpOnly, SameSite=Strict, and the JWT's 400-day expiration (the longest
browsers keep a cookie). HTTPS
logins set Secure, including the same-origin HTTPS request through the Caddy proxy.
Local HTTP deployment remains supported. The token is not saved to web storage.

On page load, `GET /api/auth/session` validates the cookie's JWT signature, issuer,
audience and expiration, checks the account is active, then issues a fresh 400-day JWT,
sets it as the cookie and returns it as the in-memory bearer token, so a login only ends
by signing out or after 400 days without a visit. Invalid saved sessions are cleared. The
account form stays hidden while this runs, and nothing is shown in its place.
`POST /api/auth/logout` clears the saved cookie before the page clears its token.
The page never sends it alongside a session request, because a renewal answered after
sign-out would re-create the cookie.
Both endpoints use no-store responses and require an explicit browser-session
header; cross-origin Origin and Fetch Metadata values are rejected independently
of CORS configuration. Login also recognizes same-origin browser requests from older open pages that
do not send the new session header. Restoration and sign-out still require that
header. After login, the client checks that the saved token can be read back and
reports a retention failure beside the page status. HTML and JavaScript responses
use no-cache so browsers revalidate application updates. Normal API authorization continues to require bearer tokens or stream
tickets; the cookie is not an alternative credential for console control APIs.

Sign-out ends this browser's saved login; it does not revoke separately issued
stateless API bearer tokens. Session restoration does not restart a video stream.
