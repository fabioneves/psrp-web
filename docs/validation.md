# Validation

## Environment

- Tested on 2026-09-15 in a Linux x86-64 workspace.
- CPU reported by the environment: Intel Core Ultra 9 285HX, 12 exposed vCPUs.
- Docker Engine 29.6.2, rootless; .NET 10, PostgreSQL 17, FFmpeg 6.1.1.
- Desktop Google Chrome, launched by Playwright with:

```text
--disable-gpu
--disable-accelerated-video-decode
--disable-accelerated-2d-canvas
--disable-webgl
```

## Observed playback

The real H.264 test generator → CPU FFmpeg transcoder → WebSocket → JSMpeg WASM
→ Canvas2D worker path rendered 1280×720 video at **60.0 fps**, around **3.5 ms
per decoded/rendered frame** and **10.3 Mbps** in the initial captured run.
The browser test waits for more than 300 new frames after warmup, checks measured
fps, captures the screen and reconnects. The main-thread software fallback also
renders successfully with GPU acceleration disabled.

![Captured software stream](images/software-stream.png)

These are short synthetic-stream measurements on this workstation. They do not
establish Tesla performance, sustained thermally limited performance, actual
display refresh rate, game image quality or controller-to-photon latency.

## Automated coverage

- Backend compilation and PostgreSQL migration/startup in Docker.
- Ticket owner retention, expiry, single use and unknown-token rejection.
- Authenticated device ownership, bitrate validation and blocked legacy endpoints.
- Concurrent-viewer rejection and cleanup after malformed socket input.
- Annex B IDR gating, codec headers and removal of the upstream packet type byte.
- Queue overflow fails explicitly; no silent reference-frame dropping.
- Real generated H.264 through the receiver/transcoder; FFprobe checks 720p60,
  MPEG-1 and the absence of audio tracks.
- Password hash work factor and correct/incorrect password verification.
- Simultaneous touch/keyboard ownership, opposing directions, and focus-loss reset.
- Browser signup, library, real video rendering, metrics, disconnect/reconnect.
- Library layout overflow checks at 320, 768, 1024 and 1440 pixels.
- Worker and main-thread renderers, with no HTML audio/video elements.
- JavaScript fallback with WebAssembly unavailable and native media constructors
  made to throw if called.

Final checks: 19 backend assertions, 3 input unit tests and 5 browser/API tests
passed. NuGet's transitive vulnerability audit and npm's dependency audit reported
no known vulnerable packages at validation time. Existing upstream compiler
warnings remain; no warning suppressions were added.

## Hardware acceptance still required

No PlayStation or Tesla was available in this environment. Before calling console
support validated, test both the target PS4/PS5 firmware and actual Tesla browser:

1. Pair using a real PIN and account ID; verify waking from rest mode.
2. Run a game at 720p60 for at least ten minutes and observe fps, bitrate and CPU.
3. Verify buttons, movement, camera, triggers, simultaneous touch, and input reset.
4. Disconnect, reconnect, close the browser, and interrupt the network; confirm
   the console session and FFmpeg processes terminate cleanly.
5. Test the real remote network/domain/HTTPS path and check input latency.

The application requests 720p60 and never silently switches to hardware decoding.
A browser CPU that cannot sustain this workload will need a lower bitrate or a
future alternative software codec path; no universal 720p60 guarantee is made.
