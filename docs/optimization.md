# Playback optimization results

Measured on 2026-09-15, Intel Core Ultra 9 285HX (12 CPUs exposed), Linux,
Node 24.18 and Chrome with GPU, accelerated video decode, accelerated canvas and
WebGL disabled. These are synthetic local-server measurements, not Tesla results.

## Browser result

The final GPU-disabled Chrome run held **60 fps at 1080p**, with **5.5 ms** total
per displayed frame and **zero audio underruns** during the sampled run. The
breakdown was 3.1 ms decode/copy, 1.6 ms color conversion and 0.8 ms canvas draw.
Audio queued about 59 ms. A 20 ms reserve trial had one underrun; the final 40 ms
reserve trades a little latency for continuity. The audio-lag estimate was 100 ms,
but uses server-ready timestamps and reported output delay, not physical outputs.

[Final browser metrics](benchmarks/browser-1080p60.json) and
[complete validation scope](validation.md#performance-and-adaptive-quality-update-2026-09-15).

## Native video transport and presentation queue (2026-09-16)

Measured on the same machine as above with the isolated `psrp-ui-test`
instance, Chrome with GPU acceleration disabled and the test-only software
WebCodecs adapter. The pipeline previously copied console H.264/H.265 into
MPEG-TS through an FFmpeg process. Feeding real 60 fps H.264 access units into
the production remux arguments showed why that hurt: FFmpeg's raw H.264 parser
emitted a frame only after the next frame started (median 16.6 ms, p95 17.1 ms)
and the browser's TS demuxer completed a frame only at the next PES start
(median 32.6 ms, p95 33.6 ms). Access units now travel as one message each
and go straight to WebCodecs; no FFmpeg process runs in H.264/H.265 mode.

### Presentation cushion (2026-09-16)

With the keyframe requests gone, a 1080p60 H.265 capture still showed a
longest frame interval of about 33 ms in 139 of 249 seconds while 60 frames
were drawn per second: roughly one repeated picture every second, felt as a
regular jump during camera pans. The queue only primed a one-interval reserve
at startup and its stale rule skipped any frame that had waited 2.5 intervals,
which held the cushion at about one frame; any arrival more than a few
milliseconds late then left a refresh with nothing new. Smooth mode now keeps
a target of one to three frames queued behind the one being drawn, rebuilds
the cushion with a single held refresh when a whole second never reached it,
raises the target after a refresh with no new frame while the source is
keeping up, bounds latency at target + 2 frames, and does nothing extra for
sources below the refresh rate. Diagnostics samples record the target, the
refreshes with no new frame, rebuilds and the display refresh interval. The
simulated cost is about one extra refresh interval of latency in smooth mode;
responsive mode is unchanged.

### Video-element output and screen timing (2026-09-16)

Every capture so far measured when a frame was handed to the compositor,
not when the screen showed it. The Advanced "Video output" setting now
routes browser-decoded frames into a MediaStreamTrackGenerator feeding a
video element (Chromium). Its requestVideoFrameCallback metadata gives the
interval between actual screen presentations and frames the pipeline
skipped; diagnostics samples record them as display, displayMax and
displaySkipped. It runs on the main thread because the element is DOM.
A 1080p60 H.265 capture on a 120 Hz MacBook showed screen intervals of
17.4-17.8 ms (p95) and 18 ms longest in clean seconds, matching the hand-off
cadence, so the compositor was not distorting either path; the player
nevertheless reported the element as clearly smoother, so it is the default
where supported. The remaining 25 ms frames in that capture line up with
seconds where the console delivered 57-59 frames: frames the PS5 never sent,
which a 120 Hz display covers with one extra 8 ms refresh.

### Queue depth on a bursty link (2026-09-17)

On 5G the queue settles two frames above its target because arrivals come
in bursts of two or three after a gap. A recovery rule that skipped one
frame every five seconds while the queue stayed deep was tried and
removed: over a 335-second 1080p session it skipped 22 frames and the
queue wait stayed at 57 ms, because bursts refill the queue faster than
that cadence drains it. The depth is the price of the link's burstiness,
not something the client can trade away without visible skips.

### Video element on a 60 Hz Mac (2026-09-17)

Three cellular captures from a Mac with a 60 Hz external display, 720p60
H.265: through the video element on the main thread, the presenter missed
two or three refreshes a second (57-58 fps); with the worker decoding and
the page writing frames immediately, the queue was perfect (60 handed, no
drops) but only 49 frames a second reached the screen, at 33 ms intervals;
with the page writing inside its own refresh callback, 43 reached the
screen and 17 a second were replaced before their write, because the page's
callback itself ran at about 43 Hz. The element's write path costs
main-thread time per frame that this machine cannot sustain at 60. The
canvas worker path on the same link held 59-60 fps with 18 ms gaps and no
drops, so Automatic now picks it wherever a worker exists and uses the
element only without a worker (Safari) or when chosen explicitly.

### Worker decoding for the video element (2026-09-17)

A saved capture from a Mac on 5G with a 60 Hz external display, 720p60
H.265 through the video element, showed the console at 60 and the cushion
never empty, yet 57-58 presented frames per second with two or three
"superseded" drops and a 32 ms presenter interval almost every second.
Paired arrivals cannot reproduce that in simulation; missed animation-frame
callbacks can, and that path decoded on the main thread. Chrome exposes
the track generator only on the page, so the worker now decodes and paces
as it does for the canvas, transfers each frame to the page at
presentation time, and the page writes it to the element; screen timing is
merged into the worker's stats on the page. The presenter also reports its
longest callback gap (refreshMax in samples) so a missed refresh is visible.

### Cadence drift on 120 Hz displays (2026-09-16)

A LAN capture from a MacBook with a 120 Hz display (refresh interval 8.3 ms
in every sample) showed the console delivering 60 fps and the cushion never
running dry, yet about one second in ten still had a 30 ms frame, each one
coinciding with a cushion rebuild. Presenting every second refresh gives a
16.6 ms cadence against the console's 16.67 ms, so the queue drained one
frame every few seconds and the rebuild heuristic then held a whole frame.
The queue now counts consecutive decision refreshes at which the cushion is
low: a dip at one or two is jitter and the cushion frame is drawn; three in
a row is drift and the queue waits a single refresh, 8 ms on a 120 Hz
display and one frame on a 60 Hz one, so presentation re-aligns to
arrivals. Simulations cover both refresh rates; the per-second depth
window is gone.

### Worker presentation, audio priming and bitrate ceiling (2026-09-16)

The worker renderer is only used when the worker reports animation frames
(probed once at startup through the stream worker); a browser whose workers
lack them, such as Safari, renders on the main thread automatically instead
of pacing by timer. Audio priming (the "startup buffer" setting) now grows by
40 ms after each underrun, up to 240 ms, and relaxes back to the chosen value
after a calm minute, so a low setting recovers on its own. The bitrate sent
to the console is capped at 30 Mbps for a PS5 and 15 Mbps for a PS4, matching
the highest selectable profile; the previous 15 Mbps cap silently limited the
"30 Mbps" option.

### Periodic keyframe requests (2026-09-16)

A six-minute 1080p60 H.265 diagnostics capture from a Mac on the console
network showed the server's keyframe-request counter rising by exactly one
every 2,000 ms (177 requests) with zero console packet loss, and a stall of
50-110 ms plus an arrival gap of about 110 ms in the same rhythm, holding
presentation at 52-55 fps. The upstream stream core sends a maintenance
IDR request every 2 seconds for its HLS segmenter. The browser path now sets
`PeriodicIdrInterval` to null after the startup burst; loss recovery (reorder
timeout, health degradation and the browser's own request after a decoder
reset) still asks for keyframes when they are needed.

Smooth pacing also carried its startup depth as permanent latency, because the
presenter draws at most one frame per animation tick. It now releases a frame
that has waited 1.5 intervals when a newer one is queued.

| Stream | Server-ready → canvas before | after | Queue wait before → after | FPS after (p95 interval) |
|---|---:|---:|---:|---:|
| H.264 720p60 | 42.8 ms + hidden remux | 24.3 ms | 38.2 → 20.9 ms | 60.0 (16.8 ms) |
| H.264 1080p60 | 40.2 ms + hidden remux | 19.3 ms | 31.2 → 9.0 ms | 60.0 (16.9 ms) |
| Canvas 720p60 | 44.7 ms | 23.9 ms | 42.4 → 21.1 ms | 60.0 (16.8 ms) |

"Before" ages were stamped after FFmpeg output, so they exclude the remux
delay above; "after" ages are stamped when the console frame reaches the
receiver. Each figure is the mean of five one-second samples after 20 seconds
of playback of the synthetic test stream. These are local measurements, not
Tesla or console-capture latency.

A native decoder that stalls after producing frames now reconnects with the
same codec instead of switching the session to Canvas software video. The
stall check only counts while access units are still arriving: a gap in
console delivery (a real PS5 session logged 170 frames missing over about
2.8 seconds) must not tear the session down, because the console then reports
"still occupied" for several seconds and the retries fail. Retries after a
busy-console message wait at least three seconds. The smooth queue's stale
threshold moved from 1.5 to 2.5 intervals after real-console playback showed
paired frame arrivals; presenting both costs one interval of latency until the
queue drains naturally, dropping one is visible during fast camera motion.

## Pixel conversion

| Frame size | Original JavaScript median | WASM SIMD median | Reduction |
|---|---:|---:|---:|
| 1280 × 720 | 1.45 ms | 0.56 ms | 61% |
| 1920 × 1080 | 3.31 ms | 1.36 ms | 59% |

The benchmark includes copying the three decoded planes into WASM memory. It
warms each converter for 30 frames and measures 120 frames. The output matches
the original converter byte-for-byte, including padded dimensions and clipping.
A scalar WASM implementation was slower than JavaScript and was not retained.
The SIMD version processes four pixels together using CPU vector instructions.
Unsupported SIMD, missing WASM, or a failed converter download selects JavaScript.

The renderer still decodes all required references, but copies only the newest
image from a decode batch and presents only the newest pending frame. It skips
color conversion and canvas writes for superseded images. One pending image bounds
presentation memory; it does not queue images behind a stalled display.

[Pixel measurements](benchmarks/pixels.json).

## Server threads and startup

The benchmark encodes four seconds of 1080p60 H.264, then feeds those real access
units through the production argument builder. It tests decoder threads 1/2/4
against encoder threads 1/2/4/8. Offline throughput counts actual output pictures;
startup is measured separately with the input paced at 60 fps.

The defaults are one decoder thread and four encoder threads: **328 fps offline**,
**69 ms to the first encoded picture** in this run. One encoder thread produced
230 fps and started at 53 ms; eight encoder threads with four decoder threads
produced 415 fps and started at 69 ms. Defaults keep ample 1080p60 headroom without
maximizing thread use. A different server may favor other settings.

The prior `+nobuffer` input flag discarded the probed keyframe in this raw H.264
pipeline. Startup was approximately 1,050 ms with the one-second test GOP.
Removing that flag preserves the first keyframe. Small probing limits, low-delay
codec settings, no B frames and immediate MPEG-TS flushing remain. The new test
produced all 240 input pictures. Startup here excludes console connection and
browser initialization; it is not controller-to-screen latency.

[All thread measurements](benchmarks/threads.json).

## Timing and synchronization

Versioned media envelopes record server readiness, send time and a media-time
estimate. Ping/pong samples estimate clock offset and round-trip delay. The player
shows delivery age, server send queue, ready-to-canvas age, browser presentation
wait and separate decode/color/draw costs. These help distinguish processing and
network bottlenecks. One-way estimates assume roughly symmetric network delay.

Audio follows the server-ready timestamp of each presented image, with a 20 ms
playout reserve and tolerance to avoid chasing every packet's jitter. The worklet
trims old PCM, holds early PCM and fades corrections. It has a bounded half-second
ring and a configurable startup buffer. The fallback schedules Web Audio buffers
from the same timeline, discards packets over 80 ms late and resets excessive
queued skew. It favors continuity when a requested playback time is already past.

This provides approximate A/V alignment, not capture-clock synchronization. Video
uses the server output chunk that completed a PES; audio uses its packet-ready
time minus duration. Upstream capture timestamps are not exposed by the current
receiver. Transcoding, packetization, network asymmetry, actual speaker delay and
screen scanout limit accuracy. The displayed audio-lag estimate includes reported
audio output latency; it is not a microphone measurement. Physical-console/Tesla
calibration remains necessary.

## Adaptive quality

Manual mode is the default. Automatic mode uses the selected profile as its
ceiling. After six seconds of startup observation, three unhealthy samples trigger
a change. Network queues lower bitrate first; browser processing overload or low
presentation rate lowers resolution first. The floor is 360p30. Decreases have a
15-second cooldown; recovery needs 30 healthy seconds and 45 seconds since the
last change. Hidden tabs reset observation. A decode batch exceeding its hard time
limit can trigger an immediate lower profile. Changes reconnect the session with
a fresh ticket, which briefly interrupts video/audio and attached input clients.

During playback, Apply copies the selected settings onto the session: it reconnects when the profile, codec or pacing changed and keeps automatic mode as chosen, with the selected profile as the new ceiling. The automatic-quality checkbox is a saved preference.
CPU-pressure integration tests inject degraded metrics while using real encoding,
transport and reconnection; this does not model a particular Tesla CPU.

## Reproduce

From the repository root:

```sh
npm run build:pixels
npm run benchmark:pixels
npm run test:unit
docker build --target test -t player-one-tests .
docker run --rm --entrypoint dotnet player-one-tests /src/tests/backend/bin/Release/net10.0/BackendTests.dll --benchmark
ALLOW_REGISTRATION=true docker compose up --build -d
TEST_URL=http://127.0.0.1:18080 npm test
```

Use the port configured in your `.env`. Run performance measurements without other
benchmarks competing for the CPU. Pixel compilation is optional for deployment;
the checked-in WASM artifact is included in the ordinary Docker build.

Implementation references: [WASM SIMD intrinsics](https://emscripten.org/docs/porting/simd.html)
and [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
