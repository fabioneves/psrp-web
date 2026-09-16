export function bindFullscreenGestures(stage, { isFullscreen, exitFullscreen, touchControlsEnabled, debugEnabled, toggleTouchControls, toggleDebugHud, cycleHud, exitButton }) {
  let gesture = null, lastTap = 0, hideTimer;
  const reset = () => {
    gesture = null; lastTap = 0;
    clearTimeout(hideTimer); exitButton.hidden = true;
  };
  const leave = () => { reset(); if (isFullscreen()) void exitFullscreen(); };
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !isFullscreen()) return;
    if (event.target.closest('button,a,input,select,summary')) { gesture = null; lastTap = 0; return; }
    event.preventDefault();
    if (!gesture) {
      if (!event.isPrimary) return;
      gesture = { points: new Map(), active: new Set(), time: performance.now(), moved: false };
    }
    gesture.points.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.active.add(event.pointerId);
  });
  const recordMovement = event => {
    const start = gesture?.points.get(event.pointerId);
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 18) gesture.moved = true;
  };
  stage.addEventListener('pointermove', recordMovement);
  stage.addEventListener('pointercancel', reset);
  stage.addEventListener('pointerup', event => {
    if (event.pointerType !== 'touch' || !gesture?.active.has(event.pointerId)) return;
    recordMovement(event);
    gesture.active.delete(event.pointerId);
    if (gesture.active.size) return;
    const finished = gesture; gesture = null;
    if (!isFullscreen()) return;
    const now = performance.now(), duration = now - finished.time;
    if (finished.points.size > 1) {
      lastTap = 0;
      if (finished.moved || duration > 400) return;
      if (finished.points.size === 2) { event.preventDefault(); reset(); toggleDebugHud(); }
      if (finished.points.size === 3) { event.preventDefault(); reset(); toggleTouchControls(); }
      return;
    }
    const start = finished.points.get(event.pointerId);
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (dy >= 80 && Math.abs(dx) < dy / 2 && duration < 1000) {
      event.preventDefault(); leave(); return;
    }
    if (debugEnabled() && Math.abs(dx) >= 80 && Math.abs(dy) < Math.abs(dx) / 2 && duration < 1000) {
      event.preventDefault(); reset(); cycleHud(dx < 0 ? 1 : -1); return;
    }
    if (finished.moved || duration > 350) { lastTap = 0; return; }
    if (lastTap && now - lastTap < 350) { event.preventDefault(); leave(); return; }
    lastTap = now;
    if (!touchControlsEnabled()) {
      exitButton.hidden = false;
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { exitButton.hidden = true; }, 5000);
    }
  });
  stage.addEventListener('dblclick', event => {
    if (!event.target.closest('button,a,input,select,summary')) leave();
  });
  exitButton.onclick = leave;
  document.addEventListener('fullscreenchange', reset);
  window.addEventListener('blur', reset);
  return reset;
}
