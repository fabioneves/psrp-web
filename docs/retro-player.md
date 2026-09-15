# Retro player refresh

## Scope and acceptance

- A PlayStation-inspired pixel art interface, original room illustration, reusable pixel console/controller art and responsive layouts. Keep readable body text and keyboard focus.
- Visible video settings with Tesla (Canvas 720p60), balanced (H.264 720p60), and detail (H.264 1080p60) shortcuts. Save all playback preferences locally.
- Fullscreen contains only video by default. Debug mode explicitly enables its overlay; optional touch controls remain available. Escape exits, with a gesture fallback for browsers without Fullscreen API.
- Debug overlay: actual codec, decoder, resolution, FPS history, frame interval p95, network RTT, delivery estimate, bitrate, decode/draw time and audio queue/underruns. No invented end-to-end latency.
- Smooth audio clock correction instead of repeated sample cuts and silence on small video timing changes. Bound queues and recover from large discontinuities. Verify jitter, drift and buffer behavior with deterministic tests.
- Restore animation-frame scheduling after fullscreen callbacks stall; measure frame pacing, not just a rounded FPS number. Preserve Canvas CPU rendering and all existing video profiles.
- Put a paired console into rest mode from the library or player; use authenticated Remote Play control, clean up sessions, never wake an already sleeping console merely to sleep it.
- Retain stable connection feedback, guided pairing, saved login, all existing inputs and renderer fallback.

## Validation and rollout

Use the isolated `psrp-ui-test` Compose project on port 18081 for all synthetic streams. Test desktop/mobile layouts, fullscreen, input opt-in, saved settings, debug metrics, sleep authorization and existing regressions. Run backend and JS tests, then deploy the tested image after checking for active streams. Real Tesla and PS5 audio quality still need device validation; synthetic performance is not a guarantee of console capture or Internet latency.

## Timing changes

Smooth pacing primes about 1.5 frame intervals (25 ms at 60 fps), retains at most three decoded frames, and releases superseded buffers immediately. Responsive pacing keeps just the newest frame. Canvas reuses four YUV buffers; native decoding closes every discarded VideoFrame. The HUD updates once per second; its FPS history is limited to 30 points and frame interval measurements to 120 samples.

Audio uses a continuous sample timeline with gradual clock correction (up to 1% for the worklet), instead of hard corrections for ordinary video jitter. Large discontinuities still realign, and output remains bounded to half a second. A deterministic 10-second ±32 ms video-jitter regression produced 1,521 silent blocks before the fix and zero afterward. Capture-to-display synchronization is approximate because the existing transport does not carry a shared console capture clock.

## Isolated browser comparison

Chrome with GPU, accelerated video decode, accelerated Canvas and WebGL disabled, 720p60 Canvas test stream on the same server. Two sequential 30-second runs, sampled every five seconds:

| Mode | Reported FPS samples | Dropped frames after first sample | Max frame interval samples | Audio underruns |
| --- | --- | --- | --- | --- |
| Responsive | 60.0, 60.0, 60.0, 59.0, 59.0, 60.1 | 10 | 16.9–33.7 ms | 0 |
| Smooth | 60.0, 60.1, 60.1, 60.0, 60.0, 60.1 | 0 | 17.0–17.5 ms | 0 |

Smooth's measured server-ready-to-canvas age was about 46 ms versus about 11 ms in Responsive. These are synthetic local-browser results, not Tesla or end-to-end input measurements. Startup burst drops are excluded from the post-warm-up drop count.

## Release checks

- 54 existing/updated browser tests passed; the additional theater/touch-exit test passed with eight targeted UI/connection rechecks after the final polish (55 unique browser cases).
- 37 JavaScript tests, 131 backend assertions and 14 isolated database/power assertions passed.
- Real protocol-socket tests verify the standby message is written before closing the control connection. No sleep command was sent to the live PS5 during automated testing.
- The actual H.264 browser decoder also held 60 fps across six five-second samples with zero audio underruns; hardware acceleration was disabled for the test.
- Desktop and 320/390/768 px layouts, native fullscreen, theater fallback, optional touch controls and the debug overlay were checked in Chrome. Tesla hardware and live-console A/V synchronization require device verification.
