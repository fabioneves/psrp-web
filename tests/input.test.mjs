import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputState } from '../web/input.js';

test('releasing touch does not release the same button held by keyboard', () => {
  const sent = [];
  const input = new InputState(message => sent.push(message));
  input.hold('key', 'button:CROSS');
  input.hold('touch', 'button:CROSS');
  input.release('touch');
  assert.deepEqual(sent, [{ type: 'button', button: 'CROSS', pressed: true }]);
  input.release('key');
  assert.deepEqual(sent[1], { type: 'button', button: 'CROSS', pressed: false });
});

test('opposed directions cancel and releasing one restores the held direction', () => {
  const sent = [];
  const input = new InputState(message => sent.push(message));
  input.hold('a', 'left:x:-1');
  input.hold('d', 'left:x:1');
  input.release('d');
  assert.deepEqual(sent, [
    { type: 'stick', stick: 'left', x: -1, y: 0 },
    { type: 'stick', stick: 'left', x: 0, y: 0 },
    { type: 'stick', stick: 'left', x: -1, y: 0 }
  ]);
});

test('focus loss resets all input and allows a fresh press', () => {
  const sent = [];
  const input = new InputState(message => sent.push(message));
  input.hold('key', 'button:CROSS');
  input.reset();
  input.hold('key', 'button:CROSS');
  assert.deepEqual(sent.map(m => m.type), ['button', 'reset', 'button']);
});
