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

test('Share and Options together send PS, while either alone still works after the hold-off', () => {
  const sent = [];
  let clock = 0;
  const input = new InputState(message => sent.push(message), () => clock);
  const pad = (...names) => ({ buttons: names, left: { x: 0, y: 0 }, right: { x: 0, y: 0 }, l2: 0, r2: 0 });
  input.gamepad(pad('SHARE')); clock += 40; input.gamepad(pad('SHARE', 'OPTIONS'));
  assert.deepEqual(sent, [{ type: 'button', button: 'PS', pressed: true }], 'the chord sends PS and never leaks Share');
  clock += 200; input.gamepad(pad('OPTIONS'));
  assert.equal(sent.length, 1, 'PS stays held while one chord button is still down');
  input.gamepad(pad());
  assert.deepEqual(sent.at(-1), { type: 'button', button: 'PS', pressed: false });
  sent.length = 0;
  input.gamepad(pad('OPTIONS')); clock += 60; input.gamepad(pad('OPTIONS'));
  assert.equal(sent.length, 0, 'a single Options press waits for the hold-off');
  clock += 100; input.gamepad(pad('OPTIONS'));
  assert.deepEqual(sent, [{ type: 'button', button: 'OPTIONS', pressed: true }], 'then it is sent as itself');
  input.gamepad(pad());
  assert.deepEqual(sent.at(-1), { type: 'button', button: 'OPTIONS', pressed: false });
  sent.length = 0;
  input.gamepad(pad('SHARE')); clock += 50; input.gamepad(pad()); input.gamepad(pad());
  assert.deepEqual(sent, [{ type: 'button', button: 'SHARE', pressed: true }, { type: 'button', button: 'SHARE', pressed: false }], 'a quick tap is still delivered as a press and release');
});
