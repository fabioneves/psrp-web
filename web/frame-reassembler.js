// Wire format of one data-channel message: uint32 frameId, uint16 index, uint16 count (little-endian), then payload.
// A message is 64 KiB at most: a delta frame arrives as one event, and only keyframes are split.
export const HEADER_SIZE = 8, MAX_PAYLOAD = 64 * 1024 - HEADER_SIZE;
const MAX_FRAME_BYTES = 2 * 1024 * 1024 + 32, MAX_PENDING = 4, KEYFRAME_REQUEST_MS = 500;
const MAX_FRAGMENTS = Math.ceil(MAX_FRAME_BYTES / MAX_PAYLOAD);

export function createReassembler({ frameIntervalMs, isKey, requestKeyframe, now = () => performance.now() }) {
  const pending = new Map();
  const counts = { fragments: 0, delivered: 0, abandoned: 0, discarded: 0, keyframeRequests: 0 };
  // Nothing before the first keyframe can be decoded, and the server switches to the channel on one.
  let newest = null, waitingForKey = true, askedAt = null;

  const askKeyframe = () => {
    if (askedAt !== null && now() - askedAt < KEYFRAME_REQUEST_MS) return;
    askedAt = now(); counts.keyframeRequests++; requestKeyframe?.();
  };
  const abandon = ids => {
    for (const id of ids) { pending.delete(id); newest = Math.max(newest ?? id, id); }
    counts.abandoned += ids.length;
    if (ids.length) waitingForKey = true;
    return ids.length;
  };

  function push(message) {
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    if (bytes.length < HEADER_SIZE || bytes.length > HEADER_SIZE + MAX_PAYLOAD) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
    const frameId = view.getUint32(0, true), index = view.getUint16(4, true), count = view.getUint16(6, true);
    if (!count || count > MAX_FRAGMENTS || index >= count) return null;
    counts.fragments++;
    if (abandon([...pending].filter(([, entry]) => now() - entry.since > 2 * frameIntervalMs).map(([id]) => id))) askKeyframe();
    if (newest !== null && frameId <= newest) return null;

    let entry = pending.get(frameId);
    if (!entry) {
      pending.set(frameId, entry = { count, parts: new Array(count), received: 0, bytes: 0, since: now() });
      if (pending.size > MAX_PENDING && abandon([Math.min(...pending.keys())])) askKeyframe();
    }
    if (entry.count !== count || entry.parts[index]) return null;
    // A large keyframe takes many frame intervals to cross the link; only one that stopped arriving is given up.
    entry.since = now();
    entry.parts[index] = bytes.subarray(HEADER_SIZE);
    entry.bytes += bytes.length - HEADER_SIZE;
    if (++entry.received < count) return null;

    pending.delete(frameId);
    // Older frames lose their turn, and one that never showed up at all is as lost as one that arrived in part.
    const missing = newest === null ? 0 : frameId - newest - 1;
    const partial = abandon([...pending.keys()].filter(id => id < frameId));
    if (missing > partial) { counts.abandoned += missing - partial; waitingForKey = true; }
    newest = frameId;
    const data = new Uint8Array(entry.bytes);
    let position = 0;
    for (const part of entry.parts) { data.set(part, position); position += part.length; }
    if (waitingForKey && !isKey(data)) { counts.discarded++; askKeyframe(); return null; }
    waitingForKey = false; counts.delivered++;
    return data;
  }

  // The server fell back to the WebSocket after sending this frame: whatever of the channel is still in flight is stale.
  function skipThrough(frameId) {
    pending.clear();
    newest = Math.max(newest ?? frameId, frameId);
    waitingForKey = true;
  }

  return { push, skipThrough, metrics: () => ({ ...counts }), get pending() { return pending.size; } };
}
