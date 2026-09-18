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
- Relevant source: `moonlight-web/web-server/web/stream/canvas.ts`, `gamepad.ts`,
  `input.ts`, `input_stream.ts`, `freeze_watch.ts` and the README.
- Independent implementation of the relevant behavior: canvas software output,
  Tesla controller fingerprints/swaps, device selection, polling, input attachment
  and retry semantics. Standard button positions follow the
  [W3C Gamepad specification](https://w3c.github.io/gamepad/).
- A feature-by-feature mapping is in `tesla-parity.md`; the WebRTC implementation
  itself is not included here.

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

## IPTV audio reference

The user's sibling `iptv-player` workspace was inspected at revision
`e6e2fbf599d7d70be795b05d6c4256db2862395a`, specifically
`packages/player/src/web-audio-output.ts`, `autoplay.ts`, `software-player.ts`,
`canvas-player.ts`, and `docs/web-software-player.md`. The gain/compressor output
pattern and user-gesture audio recovery inform this implementation. Its one-second
TV audio lead and browser WebCodecs decode are not copied into the game pipeline.
The sibling project was not modified.

Audio packets use the already-included Concentus 2.2.2 CPU Opus decoder. Browser
output is Web Audio/AudioWorklet, with no additional npm dependency.

HTTPS overlay configuration follows Caddy's
[reverse proxy documentation](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
and [automatic HTTPS documentation](https://caddyserver.com/docs/automatic-https).

## Pixel conversion and timing update

`native/pixels/pixels.c` ports the arithmetic of the MIT-licensed JSMpeg Canvas2D
converter to WASM SIMD. Preserve `third_party/jsmpeg/LICENSE` when distributing it.
The artifact builds with the included Debian/Clang Docker toolchain; the JavaScript
converter remains available when SIMD cannot load. Intrinsics and compiler flags
follow [Emscripten's SIMD documentation](https://emscripten.org/docs/porting/simd.html).
FFmpeg probing/flush controls follow its
[format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options); startup and
throughput behavior are measured with the project's actual pinned image contents.


Browser login persistence follows the cookie attribute and lifetime guidance in
[ASP.NET Core cookie authentication](https://learn.microsoft.com/en-us/aspnet/core/security/authentication/cookie?view=aspnetcore-10.0)
and the request-isolation guidance in
[ASP.NET Core antiforgery documentation](https://learn.microsoft.com/en-us/aspnet/core/security/anti-request-forgery?view=aspnetcore-10.0).
The session cookie exchanges a saved JWT for a renewed one; protected console APIs retain their
bearer-token authorization rather than accepting cookies directly.
