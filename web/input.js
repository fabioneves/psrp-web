export class InputState {
  constructor(send) {
    this.send = send;
    this.sources = new Map();
    this.buttons = new Set();
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  }
  hold(source, command) { this.sources.set(source, command); this.update(); }
  release(source) { this.sources.delete(source); this.update(); }
  reset() {
    this.sources.clear(); this.buttons.clear();
    this.sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    this.send({ type: 'reset' });
  }
  update() {
    const buttons = new Set();
    const sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
    for (const command of this.sources.values()) {
      const [kind, name, value] = command.split(':');
      if (kind === 'button') buttons.add(name);
      else sticks[kind][name] += Number(value);
    }
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
  return reset;
}
