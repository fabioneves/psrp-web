import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startStream } from '../web/stream-runtime.js';

test('socket failure reports once and ignores late events from the old connection', async () => {
  const Original = globalThis.WebSocket;
  let socket;
  globalThis.WebSocket = class {
    constructor() { socket = this; }
    close() { this.onclose?.({ reason: '' }); }
  };
  try {
    const messages = [];
    await startStream(null, 'ws://example.test/stream', message => messages.push(message));
    socket.onerror();
    socket.onerror();
    socket.onmessage({ data: JSON.stringify({ type: 'error', message: 'Late failure' }) });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, 'error');
    assert.doesNotMatch(messages[0].message, /ticket|another viewer/i);
  } finally { globalThis.WebSocket = Original; }
});
