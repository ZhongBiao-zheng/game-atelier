import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { bindCanvasMagneticHandles } from './canvasMagneticInteraction';
import { magneticTarget, stepMagneticHandle } from './magneticHandle';

describe('canvas magnetic handle', () => {
  it('pulls along the pointer vector with increasing resistance up to 16 screen pixels', () => {
    let previous = -1;
    for (let r = 0; r <= 48; r++) {
      const point = magneticTarget(.6 * r, -.8 * r, false)!;
      const distance = Math.hypot(point.x, point.y);
      expect(distance).toBeGreaterThan(previous);
      expect(distance).toBeLessThan(16);
      expect(point.x * .8 + point.y * .6).toBeCloseTo(0);
      previous = distance;
    }
  });

  it('captures at 48, holds across one-pixel oscillations, and releases beyond 56', () => {
    let grabbed = false;
    const changes = [];
    for (const r of [49, 48, 49, 48, 49, 55, 56, 55, 56, 57, 56, 55, 49, 48]) {
      const next: boolean = magneticTarget(r, 0, grabbed) !== null;
      if (next !== grabbed) changes.push(r);
      grabbed = next;
    }
    expect(changes).toEqual([48, 57, 48]);
  });

  it.each([8, 16, 32])('overshoots once visibly and settles in under 400ms at %dms/frame', dt => {
    const state = { x: 16, y: 0, vx: 0, vy: 0 };
    let minimum = 0, duration = 0;
    while (duration < 400) {
      duration += dt;
      const settled = stepMagneticHandle(state, null, dt);
      minimum = Math.min(minimum, state.x);
      if (settled) break;
    }
    expect(-minimum / 16).toBeGreaterThan(.08);
    expect(-minimum / 16).toBeLessThan(.12);
    expect(duration).toBeLessThan(400);
    expect(state).toEqual({ x: 0, y: 0, vx: 0, vy: 0 });
  });

  it('carries position and velocity into recapture and caps a suspended frame', () => {
    const state = { x: 15, y: 6, vx: 0, vy: 0 };
    stepMagneticHandle(state, null, 24);
    const before = { ...state };
    const next = magneticTarget(12, -3, false);
    stepMagneticHandle(state, next, 0);
    expect(state).toEqual(before);
    stepMagneticHandle(state, next, 1);
    expect(state.x).toBeLessThan(before.x); // Still travelling in the return direction.
    expect(state.x).toBeGreaterThan(before.x - 1);
    const resumed = { ...state }, bounded = { ...state };
    stepMagneticHandle(resumed, null, 1000);
    stepMagneticHandle(bounded, null, 32);
    expect(resumed).toEqual(bounded);
  });

  it.each([[.5, false], [1, false], [2, false], [1, true]] as const)(
    'keeps offsets in screen pixels at zoom %s, reduced=%s, with no idle frames', (zoom, reduced) => {
    vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const root = document.createElement('div');
    root.innerHTML = '<div class="react-flow__renderer"><div class="react-flow__node" data-id="n"><div class="connectable" data-magnetic-side="left"><span class="canvas-magnetic-anchor"></span></div></div></div>';
    document.body.append(root);
    const stop = bindCanvasMagneticHandles(root, 'n');
    onTestFinished(() => { stop(); root.remove(); raf.mockRestore(); vi.unstubAllGlobals(); vi.useRealTimers(); });
    const handle = root.querySelector<HTMLElement>('[data-magnetic-side]')!;
    root.style.setProperty('--canvas-zoom', String(zoom));
    vi.spyOn(handle.firstElementChild!, 'getBoundingClientRect').mockReturnValue(new DOMRect(120 * zoom, 0, 0, 0));
    const move = (x: number) => root.firstElementChild!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 120 * zoom + x }));
    move(25);
    vi.advanceTimersByTime(500);
    expect(handle.hasAttribute('data-magnetic-active')).toBe(true);
    if (reduced) expect(raf).not.toHaveBeenCalled();
    else expect(parseFloat(handle.style.getPropertyValue('--magnetic-x'))).toBeCloseTo(magneticTarget(25, 0, false)!.x);
    move(90);
    vi.advanceTimersByTime(480);
    expect(handle.hasAttribute('data-magnetic-active')).toBe(false);
    expect(handle.style.getPropertyValue('--magnetic-x')).toBe('');
    expect(handle.style.getPropertyValue('--magnetic-y')).toBe('');
    const calls = raf.mock.calls.length;
    vi.advanceTimersByTime(1000);
    expect(raf).toHaveBeenCalledTimes(calls);
  });
});
