import { createNativeDecoder, h264Info, h265Info } from './native-decoder.js';
import { createVideoSource } from './video-source.js';
import { createDecoder } from './decoder.js';
import { now, StreamClock, unpackMedia } from './timing.js';

export async function startStream(canvas, url, report, videoCodec = 'mpeg1', hardwareAcceleration = 'prefer-hardware', presentation = {}) {
  const clock = new StreamClock();
  let videoAgeMs = null, transportMs = null, serverQueueMs = 0, lastArrival = null;
  let gaps = [], transports = [];
  const percentile = (values, share) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * share) - 1] : null;
  const decoder = canvas ? await (videoCodec !== 'mpeg1' ? createNativeDecoder : createDecoder)(canvas, message => {
    report({ ...message, videoAgeMs, transportMs, serverQueueMs, rttMs: clock.rttMs,
      arrivalP95Ms: percentile(gaps, 0.95), arrivalMaxMs: gaps.length ? Math.max(...gaps) : null, transportP95Ms: percentile(transports, 0.95), ...channelMetrics() });
    serverQueueMs = 0; gaps = []; transports = [];
  }, {
    ...presentation, videoCodec, hardwareAcceleration,
    onError(message) { fail(message, failureType()); },
    requestKeyframe() { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keyframe' })); },
    onPresent(timestamp) {
      videoAgeMs = clock.age(timestamp);
      report({ type: 'sync', timestamp });
    }
  }) : null;
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const frameInfo = videoCodec === 'h265' ? h265Info : h264Info;
  const video = decoder && videoCodec !== 'mpeg1' ? createVideoSource({
    frameIntervalMs: 1000 / (presentation.fps || 60),
    // The server opens a keyframe with a unit of parameter sets alone; the picture follows in the next unit.
    isKey(data) { const info = frameInfo(data.subarray(32)); return info.key || (!info.picture && info.parameters.length > 0); },
    requestKeyframe() { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'keyframe' })); },
    deliver(payload, transport) { playVideo(transport === 'websocket' ? payload : unpackMedia(payload)); }
  }) : null;
  function playVideo(media) {
    transportMs = clock.age(media.sent);
    if (transportMs != null) transports.push(transportMs);
    const arrival = performance.now();
    if (lastArrival != null) gaps.push(arrival - lastArrival);
    lastArrival = arrival;
    serverQueueMs = Math.max(serverQueueMs, media.sent - media.ready);
    lastVideo = performance.now();
    decoder?.write(media.bytes, media.timestamp);
  }
  // Running totals of what the data channel delivered and lost; the diagnostics log turns them into per-second figures.
  function channelMetrics() {
    if (!video) return {};
    const { transport, fragments, abandoned, discarded, keyframeRequests } = video.metrics();
    return { videoTransport: transport, rtcFragments: fragments, rtcAbandoned: abandoned, rtcDiscarded: discarded, rtcKeyframeRequests: keyframeRequests };
  }
  const fromChannel = message => { if (stopped) return; try { video?.fromChannel(message); } catch (error) { fail(error.message, failureType()); } };
  let stopped = false;
  let lastVideo = performance.now();
  const failureType = () => videoCodec !== 'mpeg1' && !decoder?.healthy ? 'renderer-error' : 'error';
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    decoder?.destroy();
    socket.close();
  };
  const fail = (message, type = 'error') => { if (!stopped) { close(); report({ type, message }); } };
  const heartbeat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping', clientTime: now() }));
    if (socket.bufferedAmount > 65536) fail('Input connection is falling behind. Reconnecting…');
    if (performance.now() - lastVideo > 30000) fail('No stream response for 30 seconds. Reconnecting…');
  }, 2000);
  socket.onopen = () => { if (!stopped) { socket.send(JSON.stringify({ type: 'ping', clientTime: now() })); report({ type: 'connected', inputOnly: !canvas }); } };
  socket.onmessage = event => {
    if (stopped) return;
    try {
      if (typeof event.data === 'string') {
        const message = JSON.parse(event.data);
        if (message.type === 'pong') { clock.sample(message); if (!canvas) lastVideo = performance.now(); return; }
        if (message.type === 'status') lastVideo = performance.now();
        if (message.type === 'transport') video?.announce(message);
        report(message);
        if (message.type === 'error') close();
      } else {
        const media = unpackMedia(event.data);
        if (media.kind !== 2 && (media.kind === 3) !== (videoCodec !== 'mpeg1')) throw new Error('The server sent an unexpected video format. Reload the page.');
        if (media.kind === 2) {
          serverQueueMs = Math.max(serverQueueMs, media.sent - media.ready);
          report({ type: 'audio', bytes: media.bytes, timestamp: media.timestamp });
        } else if (video) video.fromSocket(media);
        else playVideo(media);
      }
    } catch (error) { fail(error.message, failureType()); }
  };
  socket.onerror = () => fail('Could not open the streaming connection. Check your connection to the server.');
  socket.onclose = event => {
    if (!stopped) report(event.reason === 'Disconnected by user'
      ? { type: 'stopped', message: 'All sessions for this console were disconnected.' }
      : { type: 'closed', message: 'Stream disconnected.' });
    close();
  };
  return {
    input(message) { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 65536) socket.send(JSON.stringify(message)); },
    timeline: () => decoder?.timeline?.() ?? [],
    // The receiving end of the WebRTC video channel, handed over by the page; its events fire on this thread from now on.
    rtcChannel(channel) {
      channel.binaryType = 'arraybuffer';
      channel.onmessage = event => fromChannel(event.data);
      channel.onopen = () => report({ type: 'rtc-open' });
      channel.onclose = () => { if (!stopped) report({ type: 'rtc-closed' }); };
      if (channel.readyState === 'open') report({ type: 'rtc-open' });
    },
    // One message of that channel, forwarded by a page whose browser cannot hand the channel over.
    rtcData: fromChannel,
    close
  };
}
