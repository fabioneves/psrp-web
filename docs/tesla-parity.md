# Tesla compatibility audit

Reference: Argon2000/moonlight-web-stream-tsla at
`88a1e0d2a963e07aa53f8e2229567c60234f158d`, especially `web/stream/gamepad.ts`,
`input.ts`, `input_stream.ts`, `canvas.ts`, `freeze_watch.ts` and the README.

## Implemented behavior

- Optional standard gamepads: positional PlayStation buttons, analog sticks and
  triggers, dead zone, connection discovery by polling, disconnect resets.
- Tesla virtual-controller Nintendo swaps (045a:02d1), automatic/on/off override,
  physical/virtual device preference, one selected controller to suppress mirrors,
  selection by index rather than assuming device IDs are unique. No rumble calls.
- Same-account input-only clients: touch, keyboard and gamepads on another device;
  bounded connections, session-specific tickets, input ownership and cleanup.
- Bounded connection retries with new single-use tickets, cancellation on Stop,
  fresh controller state on reconnect, automatic main-thread renderer fallback.
- Browser capability diagnostics, connection/stall feedback, fullscreen fallback, optional
  screen wake lock, persisted controller preferences and URL launch overrides.
- Optional Docker HTTPS reverse proxy and domain/network setup guidance.

## Architecture-specific equivalents

Software MPEG-1 decode and Canvas2D remain mandatory. WebRTC ICE, STUN/TURN,
SDP/H264 profile fixes, native track scheduling, bitmaprenderer and video-element
fallbacks do not apply to this transport. Audio unlock and bounded buffering are implemented with Web Audio. Console Opus is
CPU-decoded on the server; a MessagePort connects the video worker directly to
AudioWorklet so main-thread stalls do not interrupt packet delivery. The fallback
uses scheduled Web Audio buffers. Audio does not depend on HTML media elements.
Windows setup, Sunshine mouse/desktop typing, multi-player controller slots and rumble are not
PlayStation Remote Play requirements; all input sources control one PS session.

Tests must cover mapping, duplicate selection, device replacement, input release,
attachment isolation/cleanup, retry cancellation, software rendering and layout.
Physical Tesla/console validation remains external; desktop tests cannot establish
sustained 720p60 on Tesla hardware or compatibility with every firmware version.

## Profiles and differences from the reference

The backend requests 360p, 540p, 720p or 1080p at 30/60 fps from Remote Play, and
CPU-transcodes to the same output profile. Bitrate is selectable up to 30 Mbps;
console input is capped at 15 Mbps, matching the upstream highest preset.
720p60 is the default. HEVC/HDR, arbitrary desktop resolutions, keyboard text
injection, mouse desktop control and multiple independent gamepad slots are not
part of this PlayStation controller protocol integration.

Instead of copying the reference's multi-controller mirror-deduplication machinery,
this app selects one local controller by index, preferring physical devices in
Auto mode. This avoids double input when Tesla exposes physical and virtual
copies. Switching/unplugging a device replaces its entire snapshot and releases
its old controls. The default standard button layout is positional; the
045a:02d1 wrapper swaps both face pairs, with manual overrides available.

No claims are made about vehicle drive-state behavior. The app uses ordinary
canvas/audio/browser APIs and does not alter vehicle browser restrictions.
