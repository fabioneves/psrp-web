// macOS keeps a DualSense's PS button for itself, so Share and Options pressed together stand in for it.
// Either button alone waits this long before it is sent, so a chord never leaks a Share or Options press.
export const CHORD_HOLD_MS = 150;
export class InputState {
  constructor(send, now = () => performance.now()) {
    this.send = send;
    this.now = now;
    this.sources = new Map();
    this.buttons = new Set();
    this.pendingMenu = null; this.chordActive = false;
    this.pad = null;
    this.triggers = { l2: 0, r2: 0 };
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  }
  hold(source, command) { this.sources.set(source, command); this.update(); }
  release(source) { this.sources.delete(source); this.update(); }
  gamepad(snapshot) { this.pad = snapshot; this.update(); }
  resolveChord(buttons) {
    const held = ['SHARE', 'OPTIONS'].filter(name => buttons.has(name));
    buttons.delete('SHARE'); buttons.delete('OPTIONS');
    const now = this.now();
    if (held.length === 2 || (this.chordActive && held.length === 1)) { this.chordActive = true; this.pendingMenu = null; buttons.add('PS'); return; }
    this.chordActive = false;
    if (held.length === 1) {
      if (this.pendingMenu?.button !== held[0]) this.pendingMenu = { button: held[0], since: now, tapped: false };
      if (now - this.pendingMenu.since >= CHORD_HOLD_MS) buttons.add(held[0]);
      return;
    }
    if (this.pendingMenu && !this.pendingMenu.tapped && now - this.pendingMenu.since < CHORD_HOLD_MS) {
      // Released before the hold-off: send the press now; the next update releases it.
      this.pendingMenu.tapped = true; buttons.add(this.pendingMenu.button); return;
    }
    this.pendingMenu = null;
  }
  poll() { this.update(); }
  reset() {
    this.sources.clear(); this.buttons.clear();
    this.pad = null;
    this.triggers = { l2: 0, r2: 0 };
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    this.send({ type: 'reset' });
  }
  update() {
    const buttons = new Set(this.pad?.buttons);
    const sticks = { left: { ...this.pad?.left || { x: 0, y: 0 } }, right: { ...this.pad?.right || { x: 0, y: 0 } } };
    for (const command of this.sources.values()) {
      const [kind, name, value] = command.split(':');
      if (kind === 'button') buttons.add(name);
      else sticks[kind][name] += Number(value);
    }
    this.resolveChord(buttons);
    for (const button of buttons) if (!this.buttons.has(button)) this.send({ type: 'button', button, pressed: true });
    for (const button of this.buttons) if (!buttons.has(button)) this.send({ type: 'button', button, pressed: false });
    this.buttons = buttons;
    for (const stick of ['left', 'right']) {
      const x = Math.max(-1, Math.min(1, sticks[stick].x));
      const y = Math.max(-1, Math.min(1, sticks[stick].y));
      if (this.sticks[stick].x !== x || this.sticks[stick].y !== y) {
        this.send({ type: 'stick', stick, x, y });
        this.sticks[stick] = { x, y };
      }
    }
    const l2 = buttons.has('L2') ? 1 : this.pad?.l2 || 0;
    const r2 = buttons.has('R2') ? 1 : this.pad?.r2 || 0;
    if (l2 !== this.triggers.l2 || r2 !== this.triggers.r2) {
      this.triggers = { l2, r2 };
      this.send({ type: 'triggers', l2, r2 });
    }
  }
}

const keys = {
  ArrowUp: 'button:UP', ArrowDown: 'button:DOWN', ArrowLeft: 'button:LEFT', ArrowRight: 'button:RIGHT',
  KeyW: 'left:y:-1', KeyA: 'left:x:-1', KeyS: 'left:y:1', KeyD: 'left:x:1',
  KeyI: 'right:y:-1', KeyJ: 'right:x:-1', KeyK: 'right:y:1', KeyL: 'right:x:1',
  KeyX: 'button:CROSS', KeyC: 'button:CIRCLE', KeyZ: 'button:SQUARE', KeyV: 'button:TRIANGLE',
  KeyQ: 'button:L1', KeyE: 'button:R1', Digit1: 'button:L2', Digit3: 'button:R2',
  Enter: 'button:OPTIONS', Backspace: 'button:SHARE', Space: 'button:PS',
  Digit2: 'button:L3', Digit4: 'button:R3', KeyT: 'button:TOUCHPAD'
};

export function bindInputs(container, send, isPlaying) {
  const state = new InputState(send);
  const reset = () => {
    state.reset();
    container.querySelectorAll('.held').forEach(button => button.classList.remove('held'));
  };
  for (const button of container.querySelectorAll('[data-command]')) {
    button.addEventListener('pointerdown', event => {
      if (!isPlaying()) return;
      event.preventDefault();
      button.setPointerCapture(event.pointerId);
      button.classList.add('held');
      state.hold(`pointer:${event.pointerId}`, button.dataset.command);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(name, event => {
      state.release(`pointer:${event.pointerId}`);
      button.classList.remove('held');
    });
    button.addEventListener('keydown', event => {
      if (isPlaying() && ['Enter', 'Space'].includes(event.code)) {
        event.preventDefault();
        state.hold(`focus:${event.code}`, button.dataset.command);
        button.classList.add('held');
      }
    });
    button.addEventListener('keyup', event => {
      state.release(`focus:${event.code}`);
      button.classList.remove('held');
    });
    button.addEventListener('blur', reset);
    button.addEventListener('contextmenu', event => event.preventDefault());
  }
  window.addEventListener('keydown', event => {
    if (!isPlaying() || event.target.closest('input,select,textarea,button,summary') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (keys[event.code]) {
      event.preventDefault();
      state.hold(`key:${event.code}`, keys[event.code]);
    }
  });
  window.addEventListener('keyup', event => state.release(`key:${event.code}`));
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  reset.state = state;
  return reset;
}
