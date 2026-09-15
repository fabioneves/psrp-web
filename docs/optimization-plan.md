# Software playback optimization

1. Measure decode, color conversion and canvas draw separately. Compare a compiled
   CPU converter against the existing JavaScript implementation with identical
   pixel output, including padded dimensions. Keep the JavaScript fallback.
2. Decode every reference frame, retain one owned pending image, and draw the newest
   image on a presentation tick. Bound memory and count superseded frames separately
   from decode failures. Verify 30/60 fps and burst delivery.
3. Add server media timestamps, clock-offset/RTT sampling and server/browser queue
   metrics. Use timestamped audio scheduling tied to presented video, with a small
   playout reserve to keep audio continuous when physical output delay cannot be met.
   Label inferred server-side timing honestly; console capture and physical display
   latency cannot be measured through the current receiver interface.
4. Add opt-in automatic quality adaptation with hysteresis and cooldown, plus a
   manual mode. Distinguish slow decoding from network congestion. Automatic changes
   stay below the user's selected maximum profile and reconnect using existing
   authorization/lifecycle controls. Expose the actual active profile.
5. Separate decoder/encoder thread settings and benchmark combinations on a real
   H.264 input. Record throughput and live startup timing before choosing defaults.

Preserve software-only rendering, gamepads, input-only clients, audio, Docker,
720p60 and selectable 1080p60. Run unit, backend and real Chrome checks, including
GPU-disabled performance, fallbacks, cancellation and overload behavior.
