# Source attribution

## Remote Play protocol and backend

- Source: https://github.com/o1298098/remote-play
- Imported revision: `bc29dbc2f43bd7cf4675d0142349a78c6e8f2b63`
- License: MIT, retained in the root `LICENSE`.
- Retained: console discovery, registration, cryptography, UDP packet processing,
  frame reassembly, controller protocol, account/device model and migrations.
- Changes: software stream service and receiver, narrower public HTTP surface,
  real HTTP error status codes, stronger password hashing, CPU-friendly reorder
  timer and removal of unused WebRTC implementation/dependencies.
- Original project documentation: `upstream-README.md` (reference only; use the
  root README for this fork's deployment instructions).

## Canvas reference

- Source: https://github.com/Argon2000/moonlight-web-stream-tsla
- Inspected revision: `88a1e0d2a963e07aa53f8e2229567c60234f158d`
- Relevant source: `moonlight-web/web-server/web/stream/canvas.ts`.
- Inspected for its MediaStreamTrackProcessor, Canvas2D, worker and immediate
  drawing approaches. No source code from that repository was copied.

## JSMpeg

- Source: https://github.com/phoboslab/jsmpeg
- Vendored revision: `924acfbd96fdf15e6748d1368a36d79d8f4cecf6`
- License: MIT; copies in `web/vendor/JSMpeg-LICENSE` and `third_party/jsmpeg/LICENSE`.
- Selected original JavaScript modules and C decoder sources are retained under
  `third_party/jsmpeg/`. `scripts/build-decoder.mjs` combines the software modules
  with a small DOM-independent namespace for browser/worker loading.
- `web/vendor/jsmpeg.wasm` is decoded from `JSMpeg.WASM_BINARY_INLINED` in that
  revision's `jsmpeg.min.js`. Rebuilding WASM requires the upstream build toolchain;
  see the pinned repository's `build.sh` (Emscripten 1.38.47).
- The bundle includes no WebGL renderer, audio output, audio JS decoder or native
  media player. The upstream WASM artifact also contains unused MP2 functions.

## FFmpeg and .NET

- FFmpeg: https://ffmpeg.org/ffmpeg.html and https://ffmpeg.org/legal.html
- Runtime uses the Ubuntu FFmpeg package supplied by the .NET container base.
  Package licensing/copyright information is in `/usr/share/doc/ffmpeg/` in the
  image; corresponding package sources are available from Ubuntu's source archive:
  https://launchpad.net/ubuntu/+source/ffmpeg . Preserve the package notices and
  satisfy its source-distribution terms if distributing a derived image.
- .NET container images: https://github.com/dotnet/dotnet-docker
- Password work factor follows the PBKDF2-HMAC-SHA512 guidance at
  https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html .

This is an independent project, not affiliated with Sony, PlayStation or Tesla.
