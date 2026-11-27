import { magneticTarget, stepMagneticHandle, type MagneticPoint } from './magneticHandle';

function driveHandle(handle: HTMLElement, onRest: () => void) {
  const state = { x: 0, y: 0, vx: 0, vy: 0 };
  let target: MagneticPoint | null = null;
  let frame = 0;
  let last = 0;
  function reset() {
    cancelAnimationFrame(frame);
    frame = 0;
    handle.style.removeProperty('--magnetic-x');
    handle.style.removeProperty('--magnetic-y');
    delete handle.dataset.magneticActive;
    delete handle.dataset.magneticMoving;
    onRest();
  }
  function tick(now: number) {
    frame = 0;
    if (!handle.isConnected) { reset(); return; }
    const settled = stepMagneticHandle(state, target, now - last);
    last = now;
    if (settled && !target) { reset(); return; }
    handle.style.setProperty('--magnetic-x', state.x + 'px');
    handle.style.setProperty('--magnetic-y', state.y + 'px');
    if (!settled) frame = requestAnimationFrame(tick);
  }
  return {
    get captured() { return target !== null; },
    setTarget(next: MagneticPoint | null, reduced: boolean) {
      if (target?.x === next?.x && target?.y === next?.y) return;
      target = next;
      handle.toggleAttribute('data-magnetic-active', Boolean(next));
      if (reduced) { if (!next) reset(); return; }
      handle.dataset.magneticMoving = '';
      if (!frame) { last = performance.now(); frame = requestAnimationFrame(tick); }
    },
    reset,
  };
}

/** One native listener per canvas. Only the single selection, the hovered shell and
 * unfinished returns are visited. The zero-size anchor never receives a transform. */
export function bindCanvasMagneticHandles(root: HTMLElement, selectedId: string | null) {
  const handles = new Map<HTMLElement, ReturnType<typeof driveHandle>>();
  const motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const selectedSelector = selectedId && `.react-flow__node[data-id="${CSS.escape(selectedId)}"]`;
  let selected: Element | null = null;
  let hovered: Element | null = null;
  let hoverSide = 'right';
  const reset = () => { for (const driver of handles.values()) driver.reset(); hovered = null; };
  const release = () => {
    hovered = null;
    for (const driver of handles.values()) driver.setTarget(null, Boolean(motion?.matches));
  };
  const move = (event: PointerEvent) => {
    if (event.buttons || event.pointerType === 'touch') return;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest('.react-flow__renderer')) { release(); return; }
    if (selectedSelector && !selected?.isConnected) selected = root.querySelector(selectedSelector);
    const shell = target.closest('.canvas-node-shell');
    if (shell) {
      hovered = shell;
      if (!selected?.contains(shell)) {
        const box = shell.getBoundingClientRect();
        hoverSide = event.clientX < box.left + box.width / 2 ? 'left' : 'right';
      }
    }
    const candidates = new Set<HTMLElement>();
    const collect = (node: Element | null, selector: string) => node?.querySelectorAll<HTMLElement>(selector)
      .forEach(handle => candidates.add(handle));
    collect(selected, '[data-magnetic-side].connectable');
    if (!selected?.contains(hovered)) collect(hovered, `[data-magnetic-side="${hoverSide}"].connectable`);
    let keepHover = false;
    for (const handle of candidates) {
      if (handle.closest('.dragging')) { handles.get(handle)?.setTarget(null, Boolean(motion?.matches)); continue; }
      const anchor = handle.querySelector('.canvas-magnetic-anchor');
      if (!anchor) continue;
      const box = anchor.getBoundingClientRect();
      let driver = handles.get(handle);
      const next = magneticTarget(event.clientX - box.x, event.clientY - box.y, driver?.captured ?? false);
      if (!driver && next) {
        driver = driveHandle(handle, () => handles.delete(handle));
        handles.set(handle, driver);
      }
      driver?.setTarget(next, Boolean(motion?.matches));
      if (next && hovered?.contains(handle)) keepHover = true;
    }
    if (!shell && !keepHover) hovered = null;
    for (const [handle, driver] of handles) {
      if (!candidates.has(handle)) driver.setTarget(null, Boolean(motion?.matches));
    }
  };
  const down = (event: PointerEvent) => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-magnetic-side]')) release();
  };
  motion?.addEventListener('change', reset);
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerleave', release);
  root.addEventListener('pointerdown', down, true);
  window.addEventListener('blur', release);
  return () => {
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerleave', release);
    root.removeEventListener('pointerdown', down, true);
    motion?.removeEventListener('change', reset);
    window.removeEventListener('blur', release);
    reset();
  };
}
