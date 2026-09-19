// Wire format of one data-channel message: uint32 frameId, uint16 index, uint16 count (little-endian), then payload.
// A message is 64 KiB at most: a delta frame arrives as one event, and only keyframes are split.
export const HEADER_SIZE = 8, MAX_PAYLOAD = 64 * 1024 - HEADER_SIZE;
const MAX_FRAME_BYTES = 2 * 1024 * 1024 + 32, MAX_FRAGMENTS = Math.ceil(MAX_FRAME_BYTES / MAX_PAYLOAD);
// The channel retransmits a lost datagram for 250 ms, so a frame may complete after its successors. They wait for it this
// long; after that the frame is lost for good and only a keyframe helps. One request a second, so that a lost keyframe
// cannot start a storm of ever more keyframes into the link that just dropped one.
const HOLD_MS = 300, MAX_HELD = 24, MAX_HELD_BYTES = 8 * 1024 * 1024, MAX_PENDING = 48, KEYFRAME_REQUEST_MS = 1000;

export function createReassembler({ isKey, requestKeyframe, now = () => performance.now() }) {
  const pending = new Map();
  const counts = { fragments: 0, delivered: 0, abandoned: 0, discarded: 0, keyframeRequests: 0 };
  // `floor` is the highest frame id already dealt with: delivered, discarded or given up. Nothing before the first keyframe
  // can be decoded, and the server switches to the channel on one.
  let floor = null, waitingForKey = true, askedAt = null;

  const askKeyframe = () => {
    if (askedAt !== null && now() - askedAt < KEYFRAME_REQUEST_MS) return;
    askedAt = now(); counts.keyframeRequests++; requestKeyframe?.();
  };
  const complete = () => [...pending].filter(([, entry]) => entry.data).sort(([a], [b]) => a - b);
  // Everything below `id` is past helping: frames that never completed are lost, complete ones cannot be decoded without them.
  function giveUpBelow(id) {
    if (floor !== null) counts.abandoned += Math.max(0, id - floor - 1);
    for (const [older, entry] of pending) if (older < id) {
      pending.delete(older);
      if (entry.data && floor !== null) { counts.abandoned--; counts.discarded++; }
    }
    floor = Math.max(floor ?? id - 1, id - 1);
  }
  function deliver(id, entry, out) { pending.delete(id); floor = id; waitingForKey = false; counts.delivered++; out.push(entry.data); }

  function drain(out) {
    for (;;) {
      if (!waitingForKey) {
        const next = pending.get(floor + 1);
        if (next?.data) { deliver(floor + 1, next, out); continue; }
      }
      const held = complete();
      if (!held.length) return;
      const key = held.find(([, entry]) => entry.key);
      if (key) { giveUpBelow(key[0]); deliver(key[0], key[1], out); continue; }
      if (waitingForKey) {
        for (const [id] of held) { pending.delete(id); counts.discarded++; floor = Math.max(floor ?? id, id); }
        askKeyframe();
        return;
      }
      const bytes = held.reduce((sum, [, entry]) => sum + entry.data.length, 0);
      if (now() - held[0][1].completedAt <= HOLD_MS && held.length <= MAX_HELD && bytes <= MAX_HELD_BYTES) return;
      giveUpBelow(held[0][0]);
      waitingForKey = true;
    }
  }

  function push(message) {
    const bytes = message instanceof Uint8Array ? message : new Uint8Array(message);
    if (bytes.length < HEADER_SIZE || bytes.length > HEADER_SIZE + MAX_PAYLOAD) return [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER_SIZE);
    const frameId = view.getUint32(0, true), index = view.getUint16(4, true), count = view.getUint16(6, true);
    if (!count || count > MAX_FRAGMENTS || index >= count) return [];
    counts.fragments++;
    if (floor !== null && frameId <= floor) return [];

    let entry = pending.get(frameId);
    if (!entry) pending.set(frameId, entry = { count, parts: new Array(count), received: 0, bytes: 0 });
    if (entry.data || entry.count !== count || entry.parts[index]) return [];
    entry.parts[index] = bytes.subarray(HEADER_SIZE);
    entry.bytes += bytes.length - HEADER_SIZE;
    if (++entry.received === count) {
      entry.data = new Uint8Array(entry.bytes);
      let position = 0;
      for (const part of entry.parts) { entry.data.set(part, position); position += part.length; }
      entry.parts = null; entry.completedAt = now(); entry.key = isKey(entry.data);
    }
    const out = [];
    drain(out);
    if (pending.size > MAX_PENDING) { giveUpBelow(Math.max(...pending.keys()) + 1); waitingForKey = true; askKeyframe(); }
    return out;
  }

  // The server fell back to the WebSocket after sending this frame: whatever of the channel is still in flight is stale.
  function skipThrough(frameId) {
    pending.clear();
    floor = Math.max(floor ?? frameId, frameId);
    waitingForKey = true;
  }

  return { push, skipThrough, metrics: () => ({ ...counts }), get pending() { return pending.size; } };
}
