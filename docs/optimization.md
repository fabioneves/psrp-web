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

Apply selected profile disables automatic mode and applies the manual choice.
CPU-pressure integration tests inject degraded metrics while using real encoding,
transport and reconnection; this does not model a particular Tesla CPU.

## Reproduce

From the repository root:

```sh
npm run build:pixels
npm run benchmark:pixels
npm run test:unit
docker build --target test -t canvas-remote-play-tests .
docker run --rm --entrypoint dotnet canvas-remote-play-tests /src/tests/backend/bin/Release/net10.0/BackendTests.dll --benchmark
docker compose up --build -d
TEST_URL=http://127.0.0.1:18080 npm test
```

Use the port configured in your `.env`. Run performance measurements without other
benchmarks competing for the CPU. Pixel compilation is optional for deployment;
the checked-in WASM artifact is included in the ordinary Docker build.

Implementation references: [WASM SIMD intrinsics](https://emscripten.org/docs/porting/simd.html)
and [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#Format-Options).
