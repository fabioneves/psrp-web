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
   session with H.264 / 720p / 60 fps, attaches `SoftwareReceiver`, requests an IDR
   and enables controller input. Secrets are never returned in a session response.
5. `SoftwareReceiver` removes the upstream `0x02` video packet prefix, caches
   codec headers, waits for an IDR and feeds Annex B bytes to FFmpeg. Audio is ignored.
6. FFmpeg decodes on the CPU and encodes MPEG-1 without B frames at 720p60. Its
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
{"type":"reset"}
```

The button names are the upstream `FeedbackEvent.ButtonType` names. `reset`
releases buttons, centers both sticks and releases both triggers. L2/R2 update
both the button event and analog trigger state. Directions are clamped to [-1,1].

Server → browser text messages contain `type` (`status` or `error`) and `message`.
Binary messages contain consecutive MPEG-TS bytes, not necessarily a whole frame
or transport packet. JSMpeg handles arbitrary chunk boundaries.

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
  a spent ticket; a fresh Play action obtains a new one.

Upstream packet reassembly and congestion handling remain in use. The reorder
flush loop now uses a four-millisecond asynchronous timer; upstream used a busy
spin and a hard-coded Stopwatch tick frequency, which differed on Linux.

## Deployment surface

Only login/register, console discovery/pairing/listing, software tickets and
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
