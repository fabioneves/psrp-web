# Retro player refresh

## Scope and acceptance

- A PlayStation-inspired pixel art interface, original room illustration, reusable pixel console/controller art and responsive layouts. Keep readable body text and keyboard focus.
- Visible video settings with Tesla (Canvas 720p60), balanced (H.264 720p60), and detail (H.264 1080p60) shortcuts. Save all playback preferences locally.
- Fullscreen contains only video by default. Debug mode explicitly enables its overlay; the on-screen controller under the video is always available in the normal layout and appears over fullscreen video only when the touch overlay switch is on. Escape exits, with a gesture fallback for browsers without Fullscreen API.
- Debug overlay: actual codec, decoder, resolution, FPS history, frame interval p95, network RTT, delivery estimate, bitrate, decode/draw time and audio queue/underruns. No invented end-to-end latency.
- Smooth audio clock correction instead of repeated sample cuts and silence on small video timing changes. Bound queues and recover from large discontinuities. Verify jitter, drift and buffer behavior with deterministic tests.
- Restore animation-frame scheduling after fullscreen callbacks stall; measure frame pacing, not just a rounded FPS number. Preserve Canvas CPU rendering and all existing video profiles.
- Put a paired console into rest mode from the library or player; use authenticated Remote Play control, clean up sessions, never wake an already sleeping console merely to sleep it.
- Retain stable connection feedback, guided pairing, saved login, all existing inputs and renderer fallback.

## Validation and rollout

Use the isolated `psrp-ui-test` Compose project on port 18081 for all synthetic streams. Test desktop/mobile layouts, fullscreen, input opt-in, saved settings, debug metrics, sleep authorization and existing regressions. Run backend and JS tests, then deploy the tested image after checking for active streams. Real Tesla and PS5 audio quality still need device validation; synthetic performance is not a guarantee of console capture or Internet latency.

## Timing changes

Smooth pacing primes one frame interval, retains at most three decoded frames, releases a frame that has waited 2.5 intervals whenever a newer one is queued, and releases superseded buffers immediately. Responsive pacing keeps just the newest frame. Canvas reuses four YUV buffers; native decoding closes every discarded VideoFrame. The HUD updates once per second; its FPS history is limited to 30 points and frame interval measurements to 120 samples.

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

## Touch control deck refinement

- Keep H.264 as the fresh-browser default and preserve existing codec preferences. Canvas/H.264/H.265 use illustrated radio tiles. Resolution, FPS, pacing, bitrate, audio buffer and short controller choices use keyboard-accessible radio buttons.
- Move branding and sign-out into the library banner. Keep the player toolbar to one row with fullscreen and disconnect; show icon buttons at narrow widths.
- Place the smaller normal player beside a Picture/Sound/Controls deck on desktop and stack the deck below on narrow screens. Touch and debug switches stay outside the tabs. Fullscreen hides the entire deck and toolbar.
- Save an optional Start in fullscreen checkbox, default off. Request fullscreen directly from the paired console's Play gesture before asynchronous connection work; use theater fallback when unavailable. Do not auto-fullscreen synthetic streams or input-only attachments.
- Keep native select values as the internal settings source while exposing radio buttons to users. Preserve reconnect behavior and the existing audio/video pipelines.

## HUD layouts

Detailed preserves the original graph, timing grid, health readout and actions with a 78% opaque navy background. Minimal shows FPS, codec and resolution in a 180 px wide panel. Horizontal spans the top edge without borders, with all six timing/audio readings, audio underruns, and a small FPS graph. It uses 9 px metric text, 12 px FPS and a 56% opaque background, wrapping on narrow screens while hiding only the graph and timing footnote. Minimal uses 64% opacity and let pointer events through to the video. Text remains fully opaque; no backdrop blur or extra video processing is used.

HUD layout buttons are revealed when debug is enabled and saved with the other browser preferences. Shift+H cycles layouts in fullscreen; Shift+D still toggles the overlay. All three layouts reuse the same live metrics and DOM, so switching does not start a second sampler or reconnect playback.

### Refinement validation

The 59-case browser suite passed after the control deck changes, including H.264/Canvas playback, audio, profile changes, connection recovery, saved login and input-only sessions. After adding HUD layouts and final mobile spacing, all 14 targeted UI/connection cases passed, bringing coverage to 60 unique browser cases. The HUD test checks live metrics, transparent backgrounds, compact bounds at 320 px, persistence, fullscreen switching and no extra stream tickets. All 37 JavaScript tests passed. Screenshots were inspected for all three HUDs and desktop/mobile layouts. All synthetic streams used the isolated Compose project.

## Touch fullscreen exits

A single-finger downward swipe of at least 80 CSS pixels exits fullscreen when vertical travel is more than twice horizontal travel and the gesture finishes within one second. Short, upward and multi-finger gestures do not exit. A horizontal swipe changes the HUD layout only while debug is enabled. Fullscreen video disables browser panning so pointer events remain available; gestures starting on controller buttons or HUD actions are excluded. Normal page scrolling is unchanged.

When touch controls are off, tapping fullscreen video reveals a 48 px minimum-height Exit fullscreen button for five seconds. Double-tap and Escape still exit. Leaving fullscreen, disconnecting, losing focus or changing touch controls clears the temporary button. Native and theater modes share the gesture handler.

Two-finger taps toggle the debug overlay; three-finger taps toggle touch controls. These gestures require all fingers to lift within 400 ms with no finger moving more than 18 CSS pixels. Four or more fingers, canceled touches and moving multi-finger gestures do nothing. Left/right single-finger swipes cycle HUD layouts while debug is on. All settings changes use the same saved preferences as the buttons and do not reconnect playback. The gesture handler suppresses synthetic mouse clicks from touch so a multi-finger tap cannot accidentally trigger double-click fullscreen exit.

Final gesture validation: 20 UI/connection browser tests and 37 JavaScript tests passed. Six browser touch cases cover native fullscreen and theater mode, swipe direction/distance, multi-finger and canceled gestures, controller buttons, the timed exit button, two/three-finger toggles, HUD cycling, persistence and no extra connection tickets. Browser touch events were injected through Chrome DevTools; physical iPhone/Tesla validation remains a device check.

## Compact console actions

Each Play button has a Start in fullscreen toggle and icon immediately to its left. Its native checkbox is visually hidden, stays keyboard-accessible, and highlights the whole label when selected. The default-off browser preference is shared across cards and survives refresh. The manual Try again button is removed; automatic reconnect still runs, and exhausted attempts leave readable feedback with guidance to disconnect and press Play.

Horizontal HUD refinement: all metric groups and audio underruns remain visible, including at 320 px. The borderless full-width strip uses smaller FPS text and a lighter background. Three live HUD/gesture cases and 37 JavaScript tests passed; screenshots were checked at desktop and mobile widths. For this frontend-only release, the tested versioned asset bundle and then the HTML entry point can be published into the running container without restarting active streams. The Compose image tag also points to the tested build for the next recreation; existing asset bundles stay available to open clients.

Horizontal HUD groups use mint video readings, blue NET, amber TIME and pink SND sections, with pixel-font headings, square dividers and lightly tinted readings. The repeated decoder/codec hardware-preference text is removed from the HUD; only the audio underrun count remains in that status slot. Four live browser cases (including native H.264 duplication checks and touch HUD switching) and 37 JavaScript tests passed. Desktop and 320 px screenshots were checked.

## Classic UI and larger controls

The UI review found undersized console/codec artwork, text-only actions, an uneven three-plus-one preset grid, and competing console actions. The classic refresh uses a gray console frame, larger pixel headings with readable body text, 144 px console artwork on desktop, 28–48 px action/codec icons, and a prominent 68 px Play control. Secondary actions sit side by side where space permits. Presets form a two-by-two menu on desktop and readable rows on the smallest phones. Selected options have an inset underline; keyboard focus stays distinct. Sign-in and the empty console library reuse the existing artwork.

The theme is isolated in `web/classic.css`. Decorative action icons use CSS masks so existing loading-label updates cannot remove them. Pairing, playback, authentication and preference behavior stay on their existing handlers. No new dependencies or remote asset requests are introduced.

Validation: 61 JavaScript tests passed. Three isolated Chrome browser cases cover signed-in/empty libraries, sign-in, setup and console dialogs, profile keyboard selection, Picture/Sound/Controls tabs, error feedback, and fullscreen entry/exit at widths from 320 to 1440 px. Browser API responses were mocked; this validates frontend interactions and layout, not live-console streaming or Tesla hardware. The versioned web build resolves the theme and all twelve artwork references in it.

To repeat the frontend checks, serve `web/` locally and run `TEST_URL=http://127.0.0.1:18181 npx playwright test tests/browser/classic-ui.spec.js`. These cases intercept every API request and do not require a console or database.
