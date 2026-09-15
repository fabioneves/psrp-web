# Implementation plan

1. Establish the software pipeline and Docker build; prove FFmpeg → MPEG-TS →
   JSMpeg → Canvas2D against a synthetic 720p60 source.
2. Add bounded receiver queues and authenticated socket tickets, then wire
   upstream console registration and session lifecycle into the stream.
3. Add responsive pairing/stream UI, keyboard and touch controls, and metrics.
4. Test startup, authorization, disconnect cleanup and software-only playback;
   document measured performance and hardware validation still needed.


## Tesla compatibility, audio and selectable profiles

- Implement optional analog gamepads, Tesla swaps/device selection and poll discovery.
- Add same-account input-only attachments and per-client input release.
- Add bounded fresh-ticket retries and automatic rendering fallback.
- Add server Opus decoding and Web Audio output based on the IPTV audio approach.
- Keep game latency bounded with a small jitter buffer and direct worker/audio port.
- Add Remote Play 360p/540p/720p/1080p, 30/60 fps, and configurable CPU encoder threads.
- Verify synthetic 1080p60 with software rendering, real audio samples and UI stalls.
- Include a Docker HTTPS overlay and document differences from Moonlight.

Target hardware acceptance remains open: actual console pairing/gameplay, Tesla
controller mappings, sustained FPS, speaker routing and audiovisual latency.
