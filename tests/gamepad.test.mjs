import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGamepad, selectGamepad, pollGamepads, describeSnapshot } from '../web/gamepad.js';
import { InputState } from '../web/input.js';

const pad = (id = 'DualSense', index = 0) => ({ id, index, connected: true, mapping: 'standard',
  buttons: Array.from({ length: 18 }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0] });

test('standard positions map to PlayStation buttons with analog triggers and dead zone', () => {
  const device = pad();
  device.buttons[0].pressed = true;
  device.buttons[17].pressed = true;
  device.buttons[6].value = 0.4;
  device.axes = [0.05, -1, 0.6, NaN];
  const state = readGamepad(device);
  assert.deepEqual(state.buttons, ['CROSS', 'TOUCHPAD']);
  assert.equal(state.l2, 0.4);
  assert.deepEqual(state.left, { x: 0, y: -1 });
  assert.ok(state.right.x > 0.4);
  assert.equal(state.right.y, 0);
});

test('Tesla Nintendo wrapper swaps both face pairs, with manual override', () => {
  const device = pad('TESLA VIRTUAL GAMEPAD (Vendor: 045a Product: 02d1)');
  device.buttons[0].pressed = device.buttons[2].pressed = true;
  assert.deepEqual(readGamepad(device).buttons, ['CIRCLE', 'TRIANGLE']);
  assert.deepEqual(readGamepad(device, { swap: 'off' }).buttons, ['CROSS', 'SQUARE']);
  const xbox = pad('Xbox (Vendor: 045e Product: 02d1)');
  xbox.buttons[0].pressed = true;
  assert.deepEqual(readGamepad(xbox).buttons, ['CROSS']);
  assert.deepEqual(readGamepad(xbox, { swap: 'on' }).buttons, ['CIRCLE']);
});

test('one physical controller suppresses mirrored virtual input; device modes and index selection work', () => {
  const virtual = pad('TESLA VIRTUAL GAMEPAD', 0), physical = pad('DualSense', 1);
  physical.buttons[0].pressed = true;
  virtual.buttons[0].pressed = true;
  assert.equal(selectGamepad([virtual, physical]).index, 1);
  assert.equal(selectGamepad([virtual, physical], { mode: 'virtual' }).index, 0);
  assert.equal(selectGamepad([virtual], { mode: 'physical' }), null);
  assert.equal(selectGamepad([pad('same', 0), pad('same', 3)], { index: '3' }).index, 3);
  assert.equal(selectGamepad([null, { ...physical, connected: false }]), null);
});

test('gamepad snapshots preserve keyboard ownership and release analog input on disconnect', () => {
  const sent = [], input = new InputState(m => sent.push(m));
  input.hold('key', 'button:CROSS');
  input.gamepad({ buttons: ['CROSS'], left: { x: 0.5, y: 0 }, right: { x: 0, y: 0 }, l2: 0.4, r2: 0 });
  assert.ok(sent.some(m => m.type === 'triggers' && m.l2 === 0.4));
  input.gamepad(null);
  assert.ok(!sent.some(m => m.button === 'CROSS' && !m.pressed));
  assert.deepEqual(sent.at(-1), { type: 'triggers', l2: 0, r2: 0 });
  input.release('key');
  assert.deepEqual(sent.at(-1), { type: 'button', button: 'CROSS', pressed: false });
});

test('polling reports the controller and a live preview before playback, and only sends input while enabled', () => {
  const device = pad('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)');
  let tick, enabled = false, focused = false;
  const reports = [], snapshots = [];
  const environment = { navigator: { getGamepads: () => [device] }, document: { hasFocus: () => focused },
    setInterval(fn) { tick = fn; return 1; }, clearInterval() {} };
  const state = { pad: null, gamepad(snapshot) { this.pad = snapshot; snapshots.push(snapshot); } };
  pollGamepads(state, () => enabled, () => ({}), (status, preview) => reports.push([status, preview]), environment);
  tick();
  assert.match(reports.at(-1)[0], /Controller 0: DualSense.*click the page to send input/);
  assert.equal(reports.at(-1)[1], 'Controller idle. Press a button or move a stick to test it.');
  device.buttons[0].pressed = true; device.axes = [0.5, 0, 0, 0];
  tick();
  assert.equal(reports.at(-1)[1], 'Pressed: CROSS · L 0.43, 0.00');
  assert.deepEqual(snapshots.filter(Boolean), [], 'nothing is sent to the console before playback');
  focused = true; enabled = true;
  tick();
  assert.deepEqual(snapshots.at(-1).buttons, ['CROSS']);
  assert.doesNotMatch(reports.at(-1)[0], /click the page/);
  assert.equal(describeSnapshot(null), '');
});
