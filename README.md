# Canvas Remote Play

A Docker-hosted PlayStation Remote Play client with **optional browser hardware decoding and a software Canvas 2D fallback**. Based on [o1298098/remote-play](https://github.com/o1298098/remote-play), with a canvas playback approach inspired by [Moonlight Web Tesla](https://github.com/Argon2000/moonlight-web-stream-tsla).

**Default: 1280×720 at 60 fps, 10 Mbps, with stereo audio. Select up to 1080p60.** No GPU, hardware video decoder, WebGL, WebCodecs, physical gamepad or joystick is required. Tesla is the primary browser target, using touch buttons and keyboard input. Optional gamepads and second-device input are also included.

The synthetic video pipeline has been tested at 60 fps in desktop Chromium with GPU acceleration disabled. **Brief real PS5 streaming checks passed; a Tesla browser has not been tested here.** See [validation and performance](docs/validation.md).

![Software-decoded 1080p60 stream with audio](docs/images/1080p60-audio.png)

## Run

Install Docker with Compose, then run from this directory:

```sh
docker compose up --build -d
```

Open **http://localhost:8080** (or your server's IP and port).

1. Create a local account or sign in. Accounts are saved in PostgreSQL. Refresh restores login silently for up to 24 hours; **Sign out** clears it.
2. Select a nearby console, or choose **Add console** to enter its IP address.
3. Choose **Sign in to PSN**, sign in on Sony's page, then paste its final redirect URL back into setup. The app saves and encodes your account ID. Choose **Pair automatically**; if it fails, use **Pair with a PIN** and enter the console's Link Device PIN.
4. Click **Play**; a console in rest mode is woken automatically before connecting. **Wake up** wakes it without starting playback. **Stream settings** offers resolutions through 1080p60. **Start test stream** checks browser playback. **Disconnect** ends the session.

Manual account-ID entry and public online-name lookup are also available under PIN pairing. The public lookup provider may be unavailable; Sony sign-in does not depend on it. See [setup details and verification limits](docs/psn-setup.md).

The first build downloads the .NET SDK, FFmpeg and a pinned Chiaki-ng library for PSN pairing. PostgreSQL migrations run automatically. Accounts and console registrations persist in `postgres-data`; the signing secret and PSN token-encryption keys persist in `app-data`. Keep both volumes when upgrading. There are no GPU device mounts or privileged containers.

After updating the code, run `docker compose up --build -d` and refresh the page.
Docker builds content-versioned asset URLs so browser/CDN caches fetch the updated
client, including its workers and decoders. Restarting an existing container alone
does not rebuild the application.

### Change the port

```sh
cp .env.example .env
```

Set `PORT=18080` in `.env`, then run `docker compose up -d`. Browse to http://localhost:18080. This workspace uses port **18080** because 8080 was occupied.

### Operations

```sh
docker compose ps
docker compose logs --tail 100 remote-play
docker compose down
```

`/healthz` returns `{"status":"ready"}` when the application can reach PostgreSQL. `docker compose down` preserves the named data volumes.

## Pairing and network setup

The Docker server must be able to reach the console on your home network. The browser reaches only this web server. Set a DHCP reservation for the console to keep its IP stable.

- **PS5:** enable Remote Play in Settings → System → Remote Play; use Link Device for the PIN.
- **PS4:** enable Remote Play in Settings → Remote Play Connection Settings; use Add Device for the PIN.
- The console list refreshes its status from network discovery. Wake waits for the console to report ready and only operates on your paired consoles.
- For wake from rest mode, enable the console's network connection and network wake options. Sony documents these in its [Remote Play setup guide](https://www.playstation.com/en-us/support/games/playstation-remote-play-on-pc-and-mac/).
- **Sign in to PSN** fills and saves your account ID and enables automatic pairing. Your PSN password stays on Sony's page. Access/refresh tokens are encrypted on the server for pairing.
- Alternatively, use public online-name lookup or paste a **numeric PSN account ID**; it is encoded automatically. Existing Base64 IDs from Chiaki also work.
- Automatic pairing requires the PSN account on the console and working PSN connectivity. PIN pairing requires a fresh console PIN. Each local user must pair their own console; stream access is checked against their device bindings.

Default Compose uses bridge networking. To enable **automatic network discovery**
when Docker cannot forward LAN broadcasts, set your LAN subnet in `.env` and
recreate the service:

```dotenv
DISCOVERY_SUBNETS=192.168.1.0/24
```

```sh
docker compose up --build -d
```

**Find consoles on this network** then probes the configured LAN directly; no
console IP needs to be entered. Use your actual LAN subnet. The setting accepts
up to four comma-separated private IPv4 CIDRs, `/24` through `/30`, with at most
1,016 addresses total. Searches send PS4 and PS5 discovery requests only, share a
bounded timeout and deduplicate replies. Container interfaces cannot reliably
reveal the host's LAN, so this setting must be supplied for rootless Docker.

With no subnet configured, discovery uses broadcasts. On rootful Linux Docker,
enable LAN broadcast discovery with:

```sh
docker compose -f compose.yaml -f compose.host.yaml up --build -d
```

The host-network override requires Compose 2.24.4+ and is intended for rootful
Linux. With rootless Docker or Docker Desktop, use the default Compose file with
`DISCOVERY_SUBNETS`. **Check IP address** remains available for a single known
console. If direct discovery fails, check routing/firewalls between Docker and
the console; this project does not implement PSN internet traversal between the
server and console.

### Access from a Tesla browser

Use a domain and HTTPS reverse proxy reachable by the vehicle. The Moonlight reference reports restrictions on raw IP/local-network access in Tesla browsers. That behavior varies by vehicle/browser version; this implementation still needs testing on the target Tesla.

A Docker HTTPS overlay is included (Compose 2.24.4+). Set
`REMOTE_PLAY_DOMAIN=play.example.com` in `.env`, point that DNS name at your server,
and make TCP ports 80/443 reachable. Start it with:

```sh
docker compose -f compose.yaml -f compose.https.yaml up --build -d
```

Caddy obtains/renews the certificate and proxies WebSockets. This overlay binds
the direct HTTP app port to loopback for local checks or an existing proxy. Set
`HTTP_BIND` to a LAN address if you also need direct HTTP access from your LAN.
Use it with the default
bridge configuration; the separate host-network override is for LAN discovery.
No browser-facing UDP media ports, STUN or TURN are required. DNS, routing and
certificate issuance need your real domain; local validation does not prove the
vehicle can reach it.

To keep HTTPS enabled with ordinary `docker compose up -d` commands, add
`COMPOSE_FILE=compose.yaml:compose.https.yaml` to `.env`.

For rootless Docker, use unprivileged host ports, for example `HTTP_PORT=18090`
and `HTTPS_PORT=18443`. Forward public TCP port **80 to server port 18090** and
public TCP port **443 to server port 18443**, then open `https://play.example.com/`
without a port suffix. The DNS record must point directly to the router's public
IP. Forwarding plain HTTP port 18080 alone does not provide HTTPS or enable
WebCodecs. If only a nonstandard public port is available, certificate issuance
and renewal require a separate validation route, such as DNS-provider integration.
See [Caddy's certificate validation requirements](https://caddyserver.com/docs/automatic-https#acme-challenges).

Check `docker compose ps` and `curl -f https://play.example.com/healthz` after
forwarding the ports. A healthy proxy container confirms Caddy is running; the
HTTPS health request also verifies certificate issuance and public routing.
Certificates persist in the `caddy-data` volume. To disable the HTTPS overlay,
stop the proxy and remove `COMPOSE_FILE` from `.env`, then run
`docker compose -f compose.yaml up -d`; app accounts and pairing data are preserved.

If you already run Caddy on the host, a minimal configuration is:

```caddyfile
play.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Use your actual port if changed. Keep the server on a trusted network or behind controlled access, and use HTTPS whenever credentials cross an untrusted network. The app uses the existing local-account model; account creation is open to anyone who can reach it. Database and signing-secret volumes contain sensitive registration material.

### Sharing HTTPS with DDEV

For the deployment at `play.example.com`, `deploy/ddev-ps5rp.yaml` adds a
hostname-specific route to the existing DDEV Traefik router. DDEV passes this
hostname's TLS connection to Caddy at `192.0.2.10:18443`; Caddy manages its
public certificate and proxies the app. Other DDEV sites retain their routes and
certificates. Keep `COMPOSE_FILE=compose.yaml:compose.https.yaml`,
`REMOTE_PLAY_DOMAIN=play.example.com`, `HTTP_PORT=18090`, `HTTPS_PORT=18443`,
`PORT=18080`, and `HTTP_BIND=0.0.0.0` in this deployment's `.env`.

Install the DDEV configuration:

```sh
cp deploy/ddev-ps5rp.yaml ~/.ddev/traefik/custom-global-config/ps5rp.yaml
cp deploy/ddev-static-ps5rp.yaml ~/.ddev/traefik/static_config.ps5rp.yaml
```

The dynamic route passes HTTPS to Caddy and HTTP to its redirect/challenge
listener at port 18090. The static setting allows TLS certificate validation to
reach Caddy through DDEV. Apply static changes during a DDEV router restart;
DDEV merges these files during startup. For an existing router, the dynamic file
can also be copied to `/mnt/ddev-global-cache/traefik/config/ps5rp.yaml` inside
`ddev-router` without restarting other projects.
See [DDEV's routing configuration](https://docs.ddev.com/en/stable/users/extend/traefik-router/)
and [Traefik's ACME passthrough setting](https://doc.traefik.io/traefik/routing/entrypoints/#allowacmebypass).

Public TCP **443 must reach `192.0.2.10:8443`**, the existing DDEV HTTPS
listener. All hostnames share this forwarding rule. Optional public TCP 80 can
reach DDEV's port 8080. Open `https://play.example.com/` without `:18080`.
Forwarding public port 443 directly to Caddy would bypass DDEV's other sites.

This server also has standard-port listeners installed from `deploy/systemd/`:
server TCP 80 forwards to DDEV on 8080, and server TCP 443 forwards to DDEV on
8443. Router rules may therefore use **80 → `192.0.2.10:80`** and
**443 → `192.0.2.10:443`**. These must be port-forwarding rules, not just
firewall allow rules. The systemd listeners start at boot and run their forwarding
processes as unprivileged dynamic users; DDEV continues running in rootless Docker.
To install these listeners on a systemd host where ports 80/443 are free:

```sh
sudo install -m 644 deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ddev-public-http.socket ddev-public-https.socket
```

Check them with `systemctl status ddev-public-http.socket ddev-public-https.socket`.
To remove the listeners, disable both socket units with `systemctl disable --now`,
then stop `ddev-port@8080.service` and `ddev-port@8443.service`. DDEV still accepts
direct connections on its original ports 8080/8443.

DDEV's existing wildcard development certificates suppress its own ACME issuance
for covered hostnames, so this integration uses Caddy for certificate management.
Verify the public certificate with `curl -f https://play.example.com/healthz` from
a device that does not trust DDEV's development CA. Until public 443 reaches
DDEV, certificate issuance remains pending. If public 443 is unavailable, use
DNS-based certificate validation instead.

To remove just this integration, delete `ps5rp.yaml` from the user-managed
configuration directory and the router's config volume. Remove
`static_config.ps5rp.yaml` and restart the DDEV router to remove the passthrough
setting. Other DDEV routes and the app's LAN HTTP address remain available.

## How software playback works

```mermaid
flowchart LR
    PS[PS4 / PS5] -->|Encrypted Remote Play| RP[Upstream protocol client]
    RP -->|H.264| CPU[FFmpeg CPU decode and MPEG-1 encode]
    CPU -->|MPEG-TS over WebSocket| DEC[JSMpeg WASM / JS decoder]
    DEC --> CANVAS[Canvas 2D putImageData]
    RP -->|Opus| PCM[Server CPU audio decoder]
    PCM -->|Stereo PCM over WebSocket| AUDIO[Web Audio output]
    UI[Touch / keyboard / gamepads] -->|WebSocket input| RP
```

Canvas rendering by itself does not force software video decoding. The Moonlight fork receives already-decoded WebRTC frames. Here, FFmpeg explicitly uses `-hwaccel none`, and the browser decodes MPEG-1 in WebAssembly (or JavaScript), then converts pixels using CPU WASM SIMD (JavaScript fallback) and writes them with `putImageData`. No HTML video element, browser media decoder, WebRTC session, WebGL renderer is created. Audio is decoded on the server and played through Web Audio.

The browser uses an OffscreenCanvas worker where supported. A main-thread Canvas 2D fallback supports browsers without that capability; `?mainThread=1` forces it for diagnosis. Assets, including the decoder, are served locally with no runtime CDN dependency.

**Tradeoffs:** MPEG-1 requires more bandwidth than H.264 and adds a lossy encode step and CPU processing on the server. 720p60 is a requested stream format and performance target, not a guarantee on every CPU. Resolution (360p/540p/720p/1080p), frame rate (30/60) and video bitrate (3–30 Mbps in the UI) are selectable independently. A lower resolution reduces browser CPU work more directly than a lower bitrate.

The test pattern travels through a real H.264 encoder, the production CPU transcoder, WebSocket transport and browser decoder. Its metrics include decoded/displayed fps, separate decode/color/draw costs, superseded frames, received bitrate and server-to-browser timing estimates. They do not measure display scanout or end-to-end controller latency.

## Controls and limits

- Touch: D-pad, move/look direction buttons, face buttons, shoulders, triggers, stick clicks, PS, Share, Options and touchpad click.
- Keyboard: arrows = D-pad; WASD = left stick; IJKL = right stick; X/C/Z/V = cross/circle/square/triangle; Q/E = L1/R1; 1/3 = L2/R2; 2/4 = L3/R3; Enter = Options; Backspace = Share; Space = PS; T = touchpad click.
- Input resets on focus loss, hidden tabs and disconnect. Opposing directions cancel; simultaneous touch and keyboard holds work together.
- One active viewer/session per server, including browser test streams. Run diagnostics in a separate Compose project while a console viewer is active. An abandoned connection expires after missed heartbeats.
- Optional gamepads supply analog sticks/triggers and positional PlayStation buttons. Tesla virtual-controller face swaps, source preference, manual index selection and dead zones are configurable. Polling detects devices even without browser connection events; only one local gamepad is selected to suppress mirrored input.
- No microphone, rumble, motion sensing or touchpad gestures. Touch direction buttons provide full stick deflection. Some games require features beyond these controls.
- PSN sign-in and pinless registration use a server-side Chiaki helper. Media playback connects directly from the server to the LAN console; internet media relay is not implemented.

### Reducing input delay

When your browser and server are on the same LAN, use the server's local address
and configured port to avoid routing the stream through a public proxy. For this
workspace that is `http://192.0.2.10:18080`. Use your own server address elsewhere.
The same database accounts and paired consoles are available, but a different
origin needs its own sign-in. Compare **Stream diagnostics → Round trip**.
A powerful encoder cannot remove internet routing delay. Keep 720p60 as a starting
profile; use lower resolution if browser decoding cannot sustain the frame rate.

## Profiles and server performance

| Profile | Resolution | Default video bitrate | Frame rates |
|---|---|---|---|
| Low bandwidth | 640 × 360 | 3 Mbps | 30 / 60 |
| Balanced on slower browsers | 960 × 540 | 6 Mbps | 30 / 60 |
| Default | 1280 × 720 | 10 Mbps | 30 / 60 |
| Full HD | 1920 × 1080 | 20 Mbps | 30 / 60 |

The selected resolution and frame rate are requested from the console and used
by the server encoder. Actual console output depends on its model/firmware and
network. The browser displays the transcoded output dimensions. This does not
prove the console supplied that native resolution. HDR/HEVC output is not exposed
by this software MPEG-1 path.

`DECODER_THREADS=1` and `ENCODER_THREADS=4` independently control FFmpeg's CPU threads (each 1–16). Run the [thread benchmark](docs/optimization.md) before increasing them; extra threads can increase latency. The server
handles H.264 decode, scaling, MPEG-1 encode, Opus decode and audio conversion.
The browser still has to decode MPEG-1 and draw pixels; a powerful server cannot
remove that client CPU cost. Video runs in a worker where available, and audio
can flow directly from that worker to the audio thread without main-thread
scheduling. No one-second TV buffer is added to game video.

Bookmarks accept `?resolution=1080p&fps=60&bitrate=20000`, `controllerMode=auto`,
`controllerIndex=0`, `teslaSwap=on` and `mainThread=1`. Launch overrides do not
change saved controller preferences. Settings apply on the next Play/test launch, or through **Apply selected profile** during playback.

## Adaptive quality and performance

Enable **Automatically adjust quality** to let playback reduce bitrate for network queues, or resolution for browser overload. The chosen profile is the ceiling. It keeps 60 fps where possible, uses 30 fps at the minimum resolution if necessary, and restores quality slowly after sustained healthy playback. Changes reconnect the Remote Play session briefly; attached controllers reconnect through their existing retry flow.

During playback, expand **Stream diagnostics** below the player for separate processing costs and queue delays; use the **Picture** tab for the selected profile. **Apply selected profile** disables adaptation and applies your manual choice. Manual mode is the default.

Smooth frame pacing retains up to three decoded images and primes a small buffer to absorb uneven delivery. Responsive pacing draws only the newest pending image for the lowest delay. Both modes reuse pixel storage and skip color conversion for discarded frames. If browser animation callbacks stall during fullscreen or a display change, presentation uses a timer and resumes animation callbacks when they return, without reconnecting the console. See [measured results, timing limits and benchmark commands](docs/optimization.md).

## Video modes

**Video mode** in Stream settings offers three choices, saved per browser:

| Mode | Server work | Browser work |
| --- | --- | --- |
| Canvas · software | Decode H.264, encode MPEG-1 | Software WASM decoding and Canvas 2D |
| H.264 · browser decoding (default) | Copy H.264 into MPEG-TS | WebCodecs decoding and Canvas 2D |
| H.265 · PS5, browser decoding | Request PS5 HEVC SDR, copy into MPEG-TS | WebCodecs HEVC decoding and Canvas 2D |

H.264 and H.265 first request `prefer-hardware`. If that is unsupported, the app
tries browser decoding with `no-preference` before changing codecs or using Canvas.
The playback label reports which request was accepted. The browser decides which decoder it
uses; this is a [WebCodecs preference](https://www.w3.org/TR/webcodecs/#hardware-acceleration),
not a guarantee. Neither native mode decodes or re-encodes video on the server.
Audio and input work in all three modes. No server GPU is required.

Unsupported H.265 falls back to H.264, then Canvas. PS4 skips H.265. Native decoder
failures also fall back, while retaining the saved selection for the next Play.
The status beneath Video mode retains the decoder error when a failure caused the fallback.
Use HTTPS or localhost for WebCodecs; ordinary LAN HTTP uses Canvas. Changing modes
while playing reconnects. An older disabled hardware-acceleration preference
migrates to Canvas automatically.

The console receives the selected resolution, frame rate and bitrate, capped at
15 Mbps. Higher bitrate settings only affect the Canvas MPEG-1 output. Playback
statistics report actual output. H.265 requires browser HEVC support, which varies
by device. Its Annex B stream includes VPS/SPS/PPS on keyframes as required by the
[WebCodecs HEVC registration](https://www.w3.org/TR/webcodecs-hevc-codec-registration/).

## Disconnecting sessions

**Disconnect all sessions** on a paired console card or in the player stops this
server's viewer and attached controllers for that console, including a connection
still starting. It revokes pending tickets and waits for server cleanup. Browsers
receive an explicit stop signal so they do not automatically reclaim the console.
The action requires a signed-in account paired with that console. It cannot kick
sessions opened by other Remote Play applications.

Browser heartbeats start during connection setup. An abandoned connection without
a heartbeat expires after 10 seconds; normal disconnects release its video stream
and console control socket. Console control-socket closure also cleans up the
server session. A responsive browser watching without pressing buttons stays
connected.

## Audio

Console Opus packets are decoded on the server to signed 16-bit PCM. The browser
uses Web Audio's gain/compressor output pattern, informed by the sibling IPTV
player, with an AudioWorklet jitter buffer where available. This audio path uses
no browser codec decoder. Stereo at 48 kHz adds about **1.54 Mbps** before overhead,
separate from the displayed video bitrate.

Audio starts with Play. If autoplay is blocked, open the **Sound** tab and tap **Enable sound**, or tap the player.
Use **Mute**, **Volume**, and the **40/120/240 ms audio startup buffer** selector. The default is 120 ms. After priming, gradual sample-clock correction follows the displayed video. Only large timing discontinuities trim stale samples or hold early audio; the selected startup buffer is not a fixed playback delay. HTTPS enables
AudioWorklet in browsers requiring a secure context; a scheduled Web Audio
fallback handles browsers without it. Browser UI stalls can interrupt that fallback.
No HTML audio/video element is needed.

The worklet aligns timestamped PCM to each displayed frame using the server's media-ready clock and a small playout reserve. This is approximate A/V synchronization: upstream capture timestamps are unavailable, and the console, decoder and physical outputs add unmeasured delay. It has not been calibrated on real hardware. The demo
includes a low-volume 440 Hz tone, and audio statistics report decoded sample
activity, queued time and underruns. They do not measure the physical speakers.

## Use a phone as the controller

1. Start the stream on the Tesla/viewer.
2. Open the same server on a second device and sign into the **same account**.
3. Choose **Attach input only** in the console library.
4. Use touch, keyboard or a connected gamepad. Video and sound stay on the viewer.

Up to four input clients can attach. They share one PlayStation controller, with
button ownership preserved across clients; the strongest stick displacement and
highest trigger pressure win. Detaching resets only that client's controls.
Connections and tickets are tied to the active session and account. The viewer
shows the attached-device count. A viewer disconnect closes its input clients;
clients retry while the same console stream reconnects.

Connection failures retry up to five times with a fresh ticket and exponential
backoff. The player, fullscreen state, settings and scroll position stay in place
during retries. Connection messages remain visible, and **Try again** becomes
available when retries stop. Authentication, pairing and active-viewer conflicts
show their error without repeatedly reconnecting. New connections wait up to eight
seconds for the previous viewer to release its slot; a still-active stream gets
an explicit conflict message. Disconnect cancels retries. A failed video worker switches automatically
to main-thread rendering. Fullscreen has a viewport fallback; screen wake lock is
optional and depends on browser support.

See the [Tesla feature audit](docs/tesla-parity.md) for the complete mapping to the
Moonlight fork and the architecture-specific exclusions.

## Development and verification

The frontend is static JavaScript. Docker uses Node in a build stage to version
the web assets; Node is not included in the running server. Local Node is needed
for tests and rebuilding the vendored decoder bundle.

```sh
docker build --target test -t canvas-remote-play-tests .
npm ci
npm test
```

Browser tests expect Chrome at `/usr/bin/google-chrome`; override `CHROME_PATH` if needed. If you changed the server port:

```sh
TEST_URL=http://127.0.0.1:18080 npm test
```

Tests create local accounts with `@example.test` addresses and exercise the synthetic stream. They do not pair a real console. Screenshots and traces go into ignored `test-results/`.

```sh
npm run build:decoder
```

This assembles the checked-in JSMpeg modules. The checked-in WASM binary is extracted unchanged from the pinned upstream distribution; the original C decoder sources are included under `third_party/jsmpeg/wasm/`.

See [source attribution](docs/sources.md), [architecture and protocol](docs/architecture.md), and [validation](docs/validation.md).


## Player One interface

The retro interface uses custom pixel art and self-hosted fonts. Video settings are always visible in the console library. Custom Canvas, H.264 (default), and H.265 tiles replace the codec dropdown. During a session, a smaller player sits beside the Control deck on wide screens; the deck stacks below on phones. Picture, Sound, and Controls tabs keep settings easy to reach, with touch buttons for short option lists. Quick presets select Tesla/Canvas 720p60, balanced H.264 720p60, or H.264 1080p60. Resolution, bitrate, frame pacing, sound, touch controls, and debug preferences persist in this browser.

- **Full screen** hides app controls and statistics. Exit with Escape or double-click/double-tap on the picture. Browsers without the Fullscreen API use a viewport-filling theater view; browser chrome cannot be hidden by the app in that fallback.
- **Start in fullscreen** in the console list is off by default and saved per browser. When checked, Play enters fullscreen immediately while connecting. Test streams and input-only attachments keep their normal view.
- **Touch fullscreen exit:** swipe down on the picture to return to the Control deck. With touch controls off, a tap also reveals a large **Exit fullscreen** button for five seconds. Double-tap and Escape remain available. In fullscreen, **two-finger tap** toggles debug, **three-finger tap** toggles touch controls, and **swipe left/right** cycles HUD layouts while debug is on. These gestures work with native fullscreen and the iPhone-style theater fallback.
- **Touch controls** are off by default and can be enabled before fullscreen. They remain available over the video when enabled.
- **Debug HUD** (or **Shift+D**) has three saved layouts, selected with illustrated buttons: **Detailed** keeps all metrics and the FPS graph; **Minimal** shows FPS, codec, and resolution; **Horizontal** uses a slim strip, adding network RTT and bitrate when space allows. All have translucent backgrounds. **Shift+H** cycles layouts while debug is on, including in fullscreen. Compact layouts let taps pass through to the picture. Detailed includes frame interval p95, estimated video age, decode/draw times, audio queue/underruns and Copy diagnostics; copied data contains no account credentials or stream tickets.
- **Smooth** pacing trades a small video buffer for fewer dropped frames. **Responsive** minimizes delay. See [comparison and timing limits](docs/retro-player.md).
- **Put console to sleep** requests rest mode from a paired console, then releases this server's session. It works from the library or player. An idle console uses a short authenticated control connection; an already sleeping console is left asleep. Enable network wake in the console's rest-mode settings to wake it again remotely.

[Artwork provenance and generation prompt](docs/artwork.md).
