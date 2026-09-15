# Software stream architecture

## Session lifecycle

1. Browser signs into the upstream local-account service. Its bearer token stays
   in page memory; reloading the page requires signing in again.
2. `POST /api/software/tickets` authenticates the user, validates the bitrate and
   checks their active console association. Demo tickets require authentication
   but no console. A cryptographically random ticket expires after 30 seconds.
3. `GET /api/software/stream?ticket=…` consumes the ticket once and atomically
   reserves the server's one viewer slot before upgrading to WebSocket.
4. For console playback, the server checks ownership again, opens the upstream
   session with H.264 and the selected resolution/frame rate, attaches `SoftwareReceiver`, requests an IDR
   and enables controller input. Secrets are never returned in a session response.
5. `SoftwareReceiver` removes the upstream `0x02` video packet prefix, caches
   codec headers, waits for an IDR and feeds Annex B bytes to FFmpeg. Opus audio packets lose their `0x01` prefix and are CPU-decoded to PCM.
6. FFmpeg decodes on the CPU and encodes MPEG-1 without B frames at the selected profile. Its
   MPEG-TS output is sent as binary WebSocket messages. The browser demuxes,
   software-decodes and renders every available frame immediately.
7. Socket closure, an input error, encoder failure, idle timeout or cancellation
   stops workers and child processes, stops the stream/session and releases the slot.

## Wire messages

Browser → server JSON:

```json
{"type":"ping"}
{"type":"button","button":"CROSS","pressed":true}
{"type":"stick","stick":"left","x":-1,"y":0}
{"type":"triggers","l2":0.4,"r2":0.8}
{"type":"reset"}
```

The button names are the upstream `FeedbackEvent.ButtonType` names. `reset`
releases buttons, centers both sticks and releases both triggers. L2/R2 update
both the button event and analog trigger state. Directions are clamped to [-1,1].

Server → browser text messages contain `type` (`status` or `error`) and `message`.
Video binary messages contain consecutive MPEG-TS bytes, not necessarily a whole
frame or transport packet. JSMpeg handles arbitrary chunk boundaries. Audio
binary messages begin with ASCII `PCM1`, followed by little-endian uint32 sample
rate and channel count, then interleaved signed 16-bit little-endian PCM. Video
and audio sends share a semaphore: the WebSocket never has concurrent sends.
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
