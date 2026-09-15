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

The initial release passed 19 backend assertions, 3 input unit tests and 5 browser/API tests. NuGet's transitive vulnerability audit and npm's dependency audit reported
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

The application requests the selected profile and never silently switches to hardware decoding.
A browser CPU that cannot sustain the workload can select a lower resolution/frame
rate; no universal 720p60 or 1080p60 guarantee is made.

## Tesla controls, audio and Full HD update

The 1080p60 synthetic run measured **60.1 fps**, **6.9 ms per decoded/drawn frame**,
and **20.7 Mbps video** with GPU acceleration disabled. The audio worklet reported
about **109 ms queued** and **zero underruns** in the captured run. Stereo PCM adds
approximately 1.54 Mbps. Audio sample RMS exceeded 0.01; this establishes decoded
signal activity, not sound from physical Tesla speakers.

The test waits for more than 600 video frames and separately blocks the browser
main thread for 500 ms. Audio underruns did not increase, because PCM travels
from the WebSocket worker directly to the audio worklet. This does not guarantee
continuity through longer network interruptions or on different hardware.

Additional automated coverage:

- Real generated Opus packets through the console receiver to signed stereo PCM.
- Analog trigger pressure, clamping, and per-device input ownership on detach.
- Tesla Nintendo wrapper swaps, manual overrides, mirrored-device selection,
  duplicate IDs at distinct indexes, dead zone and disconnected-device reset.
- Same-account input-only attachment, video continuity, cross-account rejection,
  four-client cap, cancellation when the viewer ends, and stale-session tickets.
- Real 360p30, 540p60 and 1080p60 outputs, plus the existing 720p60 test.
- Connection retry with a fresh ticket, retry cancellation and worker fallback.
- Web Audio scheduling fallback, PCM validation and bounded jitter-buffer behavior.
- Mobile input-only layout, browser capability diagnostics and audio controls.
- Docker HTTPS overlay parses; Caddy validates its configuration. Public DNS,
  certificate issuance and the Tesla network route require deployment-specific testing.

The updated suite passed 29 backend assertions, 10 JavaScript unit tests and
12 browser/API tests. Tests use synthetic media and simulated gamepad snapshots;
physical controllers, PlayStation playback, speaker output and A/V alignment still
require target-device acceptance. No test authenticates to PSN or modifies a console.

![Software 1080p60 with audio](images/1080p60-audio.png)


## Performance and adaptive quality update (2026-09-15)

The final software-only 1080p60 run reported **60.0 fps**, **5.5 ms per displayed
frame** (3.1 ms decode/copy, 1.6 ms SIMD color conversion, 0.8 ms canvas draw), and
**20.6 Mbps video**. Audio queued about 59 ms and reported **zero underruns** in
this run, including the existing 500 ms main-thread stall check. A 20 ms reserve
trial reported one underrun; the final 40 ms reserve favors continuity. Neither
run measures physical sound or controller-to-screen latency.

Thirty backend assertions, twenty JavaScript unit tests and all fourteen browser/API
tests passed. After the final audio reserve adjustment, the 1080p60/audio and
scheduled-audio fallback checks were rerun and passed. The burst test separately
verified that its superseded-frame count increases after a 500 ms stall and
playback returns to the selected 30 fps profile.

New coverage includes timestamp envelopes and offset estimation, timestamped audio
trim/hold, byte-exact SIMD conversion, newest-frame ownership, adaptive hysteresis
and limits, manual 540p30 reconnect, and real reconnect under simulated sustained
CPU pressure. The automatic test restores 1080p through a manual override. Existing
software fallbacks, authorization, phone input, gamepad and cleanup tests still pass.

See [measurement methods and reproduction commands](optimization.md),
[final browser metrics](benchmarks/browser-1080p60.json),
[earlier low-reserve trial](benchmarks/browser-low-reserve.json),
[pixel timings](benchmarks/pixels.json) and [thread timings](benchmarks/threads.json).
These are desktop Chrome and synthetic input results; real console/Tesla validation
and A/V calibration are still required.

![Optimized software 1080p60 playback](images/optimized-1080p60.png)

## Discovery feedback and saved login

Discovery now reports searching, empty results, failures and selections beside
its button. A browser regression holds the response open to verify visible
progress, then covers empty, failed and successful searches with retry.

Login now survives refresh through a scoped HttpOnly session cookie. Browser tests
verify restoration, sign-out across refresh, clearing an invalid saved token and
rejecting cross-origin session requests. Backend checks cover the required request
header, cookie attributes, HTTPS proxy behavior and same-site cross-origin rejection.
The existing 24-hour token expiration remains in effect.

Validation passed: 34 backend assertions, 20 JavaScript unit tests and all 17
browser/API tests, including the existing software video/audio and input flows.
Docker was rebuilt and the health endpoint reports ready.

### Saved-session compatibility follow-up

A regression reproduced a successful login with no saved cookie when an older,
already-open client omitted the new session header. Same-origin legacy login
requests now receive the cookie; session restore/logout keep their stricter request
checks. The compatibility test gives the old script its own ETag and verifies that
reload fetches the updated client and restores the saved login. A separate test
covers visible feedback when saved-session readback fails.

Validation: 36 backend assertions and 20 unit tests passed. All 19 browser/API
scenarios passed across the full run and the focused session rerun. An additional
real Chrome check through a local HTTPS proxy confirmed Secure/HttpOnly/Strict
cookie creation, restoration after reload, and sign-out after reload. The user's
specific URL/browser path was not tested in that round.

### Public-domain cache fix

The refresh failure was reproduced in Chrome through `https://play.example.com/`.
Cloudflare returned an older `/app.js` with `CF-Cache-Status: HIT` and a four-hour
cache lifetime. Login saved its cookie, but that cached client never called the
session restore endpoint on reload. The origin's JavaScript `no-cache` header and
container restarts did not invalidate the public cached response.

Docker now builds a content-hashed asset directory and points the HTML at it.
Relative module imports stay within that directory; absolute references to local
workers, worklets and decoders use the same version. API URLs remain unchanged.
The build hash includes every source asset and the build script itself.

The original public-domain login/refresh/sign-out test now passes. Public checks
also passed for stale unversioned assets, older login clients, missing-cookie
feedback and invalid/cross-origin sessions. The older-client test fixture uses
its own ETag and cache policy so its deliberately modified script is not retained
as the current release. A build regression verifies deterministic versions,
dependency invalidation, worker references and unchanged API paths.

Validation: all 21 JavaScript/build tests and all 20 browser/API tests passed
against the rebuilt Docker deployment, including 720p60, 1080p60 stereo audio,
software fallbacks, adaptive profiles and controls. The five public-domain session
scenarios passed across the focused run and the corrected legacy-fixture rerun.
Docker reports healthy.

### Direct console discovery

On the rootless Docker deployment, broadcast discovery returned no consoles while
the direct-IP API found the user's online PS5. A host-side UDP broadcast also
received a reply, isolating the failure to Docker's broadcast path.

The pairing form now offers **Check IP address** through the existing authenticated
direct-discovery endpoint. An empty automatic scan points users to that action.
Both discovery buttons disable during a request; direct lookup reports progress,
missing input, no response, errors and selectable console results.

Five focused public-domain browser scenarios passed across the run and corrected
test-locator rerun: automatic discovery feedback, direct lookup with retry, saved
login, responsive software playback and socket retry cleanup. A separate real
Chrome check through the public site found the actual PS5, selected its IP and
focused the account ID field. Pairing and streaming from that console were not
attempted; they require the user's account ID and Link Device PIN. Docker was
rebuilt and reports healthy.

### Automatic discovery through rootless Docker

Directed LAN broadcasts also failed from the container. Automatic discovery now
uses bounded unicast probes when `DISCOVERY_SUBNETS` is configured. This deployment
uses its host LAN, `192.168.1.0/24`, without hardcoding a console IP. Normal broadcast
discovery remains the default for deployments without that setting.

Backend regression coverage includes range normalization, duplicate/invalid scope,
network/broadcast exclusions, concurrent UDP scans, malformed/duplicate replies,
actual sender addresses, cancellation, and PS4/PS5 protocol versions and ports.
The versions follow the [Chiaki-ng discovery definitions](https://github.com/streetpea/chiaki-ng/blob/main/lib/include/chiaki/discovery.h).
All 46 backend assertions passed. A real Chrome session through the public domain
left the IP field empty, clicked **Find consoles on this network**, and found the
online PS5. This verifies the automatic button itself, not the direct-IP fallback.

### Automatic account-ID encoding

The pairing form accepts numeric PSN account IDs and existing Base64 IDs. Numeric
values are converted in the browser using exact unsigned 64-bit arithmetic, then
eight little-endian bytes are Base64-encoded, matching the
[Chiaki-ng account-ID format](https://github.com/streetpea/chiaki-ng/blob/main/scripts/psn-account-id.py).
The form previews the encoded value. Online names, overflow and malformed Base64
are rejected before pairing; this feature does not look up accounts by online name.

Unit tests cover a value above JavaScript's safe integer range, the maximum
unsigned 64-bit value, byte order, existing Base64 and invalid inputs. Browser
coverage inspects the pairing request to confirm that numeric and encoded input
produce the same account ID, and that an online name makes no pairing request.

Validation after deploying both changes: all 46 backend assertions, 24 JavaScript
tests and 22 browser/API tests passed. Public-domain checks passed for encoding
and saved login, in addition to the real automatic-discovery check. The rebuilt
Docker deployment is healthy.

### Simplified setup and PSN account persistence

The console list is now the main screen, with automatic nearby discovery. PSN
sign-in, manual IP entry and PIN pairing live in a setup dialog; stream settings
are collapsed. Refresh loads the saved login silently. Local users remain in the
existing PostgreSQL database; no account migration was needed.

Validation on 2026-09-15:

- 65 backend assertions passed, including exact PSN account encoding, OAuth state
  ownership/expiry/replay, fake Sony responses and registered-console MAC checks.
- Seven PostgreSQL integration assertions passed: tokens are encrypted, users are
  isolated, metadata/tokens survive a new context/key provider, and console/user
  bindings persist without duplicate bindings. Test-owned rows are cleaned up.
- 24 JavaScript tests and 26 browser/API tests passed with GPU acceleration
  disabled. Existing software video, stereo audio, gamepads, phone input and
  1080p60 rendering checks passed. Setup tests cover the Sony callback UI,
  automatic-pairing success/error responses, public lookup and PIN fallback.
- The public HTTPS site automatically discovered the real PS5Pro at 192.0.2.20.
  Desktop and mobile setup screens were inspected in Chromium.
- The native helper compiled in Docker and rejected invalid input in the running
  application container without outputting credentials. Its source download
  returned HTTP 200. Both Compose services were healthy. npm audit reported zero
  vulnerabilities.

Sony sign-in and pinless pairing are tested with fake service responses, not a live
PSN account. The real console check covers discovery, not registration or gameplay.
The public lookup provider returned HTTP 500; the app offers Sony sign-in/manual
entry when it is unavailable. See [setup boundaries](psn-setup.md).

After a reported Sony “Something went wrong” error, the generated authorization
URL was opened in fresh Chromium contexts with Linux and Windows user agents.
Both reached Sony's email sign-in screen. No credentials were entered, so this
does not verify the later authentication step. The dialog now offers a copyable
sign-in URL and the browser workarounds reported upstream. All four setup tests
passed again through the public HTTPS deployment after that change.

### Console wake and packet latency

Keyboard input delay was reported on a computer browser. The console video reorder
queue had two related faults: a filled gap released only one waiting packet, and
subsequent packets could wait behind a 300 ms base timeout (up to 500 ms with
jitter). A regression test failed on the old code when packets arrived 0, 2, 3, 1:
packets 2 and 3 were retained after packet 1 arrived. The fixed queue immediately
releases consecutive packets, bounds gap waiting to 4–12 ms, and rejects stale
packets without rewinding the sequence. Tests also cover loss and 16-bit wrap.
This bounds a server-side source of delay; it does not measure physical
keyboard-to-screen latency or establish that every reported delay had this cause.

Wake requests previously ignored the saved console IP and used only broadcasts.
The new authenticated wake action resolves the signed-in user's paired device,
sends a direct PS4/PS5 wake packet and waits up to 25 seconds for a ready response.
Play uses the same wake/readiness check automatically. Registration-key parsing
handles null padding and unsigned credentials. Direct discovery uses independent
sockets, checks reply sources, and probes both console protocol ports. The browser
refreshes card status from live discovery instead of retaining the pairing snapshot.

UDP tests verify the destination, PS4/PS5 versions and credentials. Database/fake
console tests verify standby → ready, already-awake behavior, device identity and
user isolation. Browser tests exercise wake progress, timeout messages and ownership
rejection. The real PS5 at 192.0.2.20 responded HTTP 200 Ok during diagnosis.

A real console connection then reproduced `Connection refused` at the control TCP
connection immediately after the initial request. Session TCP connections now
retry only connection refusal, with an eight-second deadline and cancellation;
failed handshake sockets are disposed. A local TCP test starts its listener late
to verify retry and cancellation behavior.

With the updated handshake, two consecutive real PS5 connections through
`https://play.example.com/` reached playback. Short snapshots decoded about 60 fps
but presented 43–55 fps over that route, with 119–123 ms round trip and roughly
64–69 ms from server-ready media to canvas. A local connection presented about
59 fps with 0.4 ms round trip and 17 ms ready-to-canvas. These observations show
substantial public-route latency/bursting; they do not measure console capture,
keyboard-to-screen delay or the user's own browser/network. No gameplay controls
were sent. No real standby-to-awake transition was forced for testing.

The broader browser run passed 26 checks but its 1080p60 synthetic check sampled
54 fps against a >55 fps threshold. The isolated re-run passed, along with wake and live-status UI checks; no
assertion was relaxed. Final backend tests passed 75 assertions, and the database
integration run passed 11 assertions. The initial rate variation remains a
reminder that brief desktop measurements are not a sustained performance guarantee.

### Fullscreen and reconnect investigation

The reported freeze/reconnect failure exposed two console protocol faults. The
TCP heartbeat reply included an eight-byte payload instead of the empty reply
used by Chiaki. The control handshake also discarded bytes received after the
HTTP header terminator, potentially losing the first control message. Regression
tests reproduce both conditions with a local fake console; they now pass. Header
reads have a size limit and deadline, rejected handshakes release their sockets,
and busy/crashed/incomplete responses produce distinct browser messages.

The software renderer now falls back to a 60 Hz timer if an animation callback
has not arrived within 100 ms. Pending frames remain bounded to the latest frame;
this recovery does not open another console connection. Stream error cleanup
kills the transcoder before waiting for its pipe workers to exit.

Before the changes, a real public-URL PS5 session ran in fullscreen for a minute,
with mostly 44–60 presented fps and a brief zero-throughput interval near the end;
playback resumed. That test did not reproduce a permanent fullscreen freeze or
establish the cause of the user's original incident.

Updated regression results: 88 backend assertions, 26 JavaScript unit tests, and
31 browser tests passed. Browser coverage includes repeated native fullscreen
entry/exit in both worker and main-thread rendering, disconnecting from fullscreen
and starting again, and deliberately suppressing worker animation callbacks after
playback begins. The latter continued displaying frames using the same stream
ticket. The full run also passed the 720p60, 1080p60/audio, controller, authentication,
and setup checks with GPU/video/canvas acceleration disabled in Chrome.

A subsequent public-URL PS5 run showed 50–60 fps samples during most of a minute
in fullscreen, then stalled; the reconnect attempt reported the console occupied.
The user confirmed the console was being used at that time. This run is therefore
inconclusive for unattended session stability and cannot establish the cause of
the original fullscreen incident. Real-console tests were stopped. Unexpected
control-socket closure and console-supplied disconnect reasons are now logged for
future diagnosis; raw handshake headers are no longer logged.
