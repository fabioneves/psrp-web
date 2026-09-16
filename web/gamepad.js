const buttons = ['CROSS', 'CIRCLE', 'SQUARE', 'TRIANGLE', 'L1', 'R1', null, null,
  'SHARE', 'OPTIONS', 'L3', 'R3', 'UP', 'DOWN', 'LEFT', 'RIGHT', 'PS', 'TOUCHPAD'];
const virtual = id => /TESLA\s+VIRTUAL\s+GAMEPAD|vendor\s*[: ]*045[ae]\s*.*product\s*[: ]*02d1/i.test(id);
const clamp = (value, min = 0) => Number.isFinite(value) ? Math.max(min, Math.min(1, value)) : 0;

export function readGamepad(pad, options = {}) {
  const swap = virtual(pad.id) && (options.swap === 'on' || options.swap !== 'off' &&
    /vendor\s*[: ]*045a\s*.*product\s*[: ]*02d1/i.test(pad.id));
  const deadZone = Math.max(0, Math.min(0.4, Number(options.deadZone) || 0.12));
  const axis = index => {
    const value = clamp(pad.axes[index], -1);
    return Math.abs(value) <= deadZone ? 0 : Math.round(Math.sign(value) * (Math.abs(value) - deadZone) / (1 - deadZone) * 1000) / 1000;
  };
  return {
    buttons: buttons.flatMap((name, index) => {
      let mapped = swap && index < 4 ? index ^ 1 : index;
      if (options.invertAB && mapped < 2) mapped ^= 1;
      if (options.invertXY && mapped >= 2 && mapped < 4) mapped ^= 1;
      return pad.buttons[index]?.pressed && buttons[mapped] ? [buttons[mapped]] : [];
    }),
    left: { x: axis(0), y: axis(1) }, right: { x: axis(2), y: axis(3) },
    l2: clamp(pad.buttons[6]?.value), r2: clamp(pad.buttons[7]?.value)
  };
}

export function selectGamepad(pads, options = {}) {
  const available = Array.from(pads).filter(pad => pad?.connected &&
    (options.mode !== 'physical' || !virtual(pad.id)) &&
    (options.mode !== 'virtual' || virtual(pad.id)));
  if (options.index && options.index !== 'auto') return available.find(pad => pad.index === Number(options.index)) ?? null;
  return available.find(pad => !virtual(pad.id)) ?? available[0] ?? null;
}

export function describeSnapshot(snapshot) {
  if (!snapshot) return '';
  const sticks = [['L', snapshot.left], ['R', snapshot.right]].filter(([, stick]) => stick.x || stick.y).map(([name, stick]) => `${name} ${stick.x.toFixed(2)}, ${stick.y.toFixed(2)}`);
  const triggers = [['L2', snapshot.l2], ['R2', snapshot.r2]].filter(([, value]) => value > 0).map(([name, value]) => `${name} ${value.toFixed(2)}`);
  const parts = [...snapshot.buttons, ...sticks, ...triggers];
  return parts.length ? `Pressed: ${parts.join(' · ')}` : 'Controller idle. Press a button or move a stick to test it.';
}

export function pollGamepads(state, enabled, settings, report, environment = globalThis) {
  let signature = '', status = '', preview = '', timer;
  const tick = () => {
    let next = '', snapshot = null, seen = null;
    const active = enabled();
    try {
      if (typeof environment.navigator.getGamepads !== 'function') next = 'Gamepad API unavailable. Try HTTPS or attach another device.';
      else {
        const pads = environment.navigator.getGamepads();
        const pad = selectGamepad(pads, settings());
        seen = pad ? readGamepad(pad, settings()) : null;
        if (active) snapshot = seen;
        next = pad ? `Controller ${pad.index}: ${pad.id}${pad.mapping !== 'standard' ? ' · nonstandard mapping' : ''}${active ? '' : environment.document?.hasFocus?.() === false ? ' · click the page to send input' : ' · input starts with playback'}`
          : 'No controller detected. Press a controller button to activate it.';
      }
    } catch { next = 'Controller access blocked. Try HTTPS or attach another device.'; }
    const value = JSON.stringify(snapshot);
    if (signature !== value || JSON.stringify(state.pad) !== value) { signature = value; state.gamepad(snapshot); }
    if (status !== next) { status = next; report(next); }
    const shown = describeSnapshot(seen);
    if (preview !== shown) { preview = shown; report(next, shown); }
  };
  timer = environment.setInterval(tick, 1000 / 60);
  return {
    reset() { signature = ''; state.gamepad(null); },
    close() { environment.clearInterval(timer); state.gamepad(null); }
  };
}
