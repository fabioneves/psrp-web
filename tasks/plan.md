# Implementation plan

1. Establish the software pipeline and Docker build; prove FFmpeg → MPEG-TS →
   JSMpeg → Canvas2D against a synthetic 720p60 source.
2. Add bounded receiver queues and authenticated socket tickets, then wire
   upstream console registration and session lifecycle into the stream.
3. Add responsive pairing/stream UI, keyboard and touch controls, and metrics.
4. Test startup, authorization, disconnect cleanup and software-only playback;
   document measured performance and hardware validation still needed.
