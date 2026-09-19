// Page side of the WebRTC video transport. The stream usually decodes in a worker, where a peer connection cannot be
// created, so the page negotiates and hands the receiving channel over before anything else touches it.
export function startRtcVideo({ sendOffer, handOver, onState, openTimeoutMs = 5000, gatherMs = 1000, Peer = globalThis.RTCPeerConnection }) {
  if (typeof Peer !== 'function') { onState({ state: 'failed', reason: 'This browser has no WebRTC data channels.' }); return null; }
  // No STUN or TURN: the server's address is in its answer, and it learns ours from the first connectivity check.
  const peer = new Peer({ iceServers: [] });
  let finished = false, open = false, poll;
  const close = () => { finished = true; clearTimeout(timer); clearInterval(poll); peer.close(); };
  const fail = reason => { if (finished) return; close(); onState({ state: 'failed', reason }); };
  const timer = setTimeout(() => { if (!open) fail(`The WebRTC channel did not open within ${Math.round(openTimeoutMs / 1000)} seconds.`); }, openTimeoutMs);
  peer.onconnectionstatechange = () => { if (peer.connectionState === 'failed') fail('The WebRTC connection failed.'); };
  try {
    // A lost datagram is repaired for a quarter second, about two round trips, and then given up: a loss costs one late
    // frame instead of a keyframe, and nothing can queue for longer than that.
    const channel = peer.createDataChannel('video', { ordered: false, maxPacketLifeTime: 250 });
    channel.binaryType = 'arraybuffer';
    handOver(channel);
  } catch (error) { fail(error.message); return null; }
  (async () => {
    await peer.setLocalDescription(await peer.createOffer());
    // One complete offer instead of trickled candidates; a second is plenty for host candidates.
    if (peer.iceGatheringState !== 'complete') await new Promise(resolve => {
      const done = () => { if (peer.iceGatheringState === 'complete') resolve(); };
      peer.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, gatherMs);
    });
    if (!finished) sendOffer(peer.localDescription.sdp);
  })().catch(error => fail(error.message));
  // The selected candidate pair's round trip is the one delay figure that does not travel on the stream's own socket.
  let pair = {};
  poll = setInterval(async () => {
    try {
      const reports = [...(await peer.getStats()).values()];
      const selected = reports.find(report => report.type === 'candidate-pair' && report.nominated && report.state === 'succeeded');
      const remote = selected && reports.find(report => report.id === selected.remoteCandidateId);
      pair = selected ? { pairRttMs: selected.currentRoundTripTime == null ? null : selected.currentRoundTripTime * 1000, pairType: remote?.candidateType ?? null } : {};
    } catch { pair = {}; }
  }, 1000);
  return {
    stats: () => pair,
    answer(sdp) { if (!finished) peer.setRemoteDescription({ type: 'answer', sdp }).catch(error => fail(error.message)); },
    opened() { if (finished || open) return; open = true; clearTimeout(timer); onState({ state: 'open' }); },
    closed(reason = 'The WebRTC channel closed.') { fail(reason); },
    close
  };
}
