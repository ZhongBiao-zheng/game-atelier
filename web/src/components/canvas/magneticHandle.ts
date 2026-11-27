// Distances and velocities are in screen pixels and pixels/second, independent of canvas zoom.
export const MAGNETIC_CAPTURE = 48;
const RELEASE = MAGNETIC_CAPTURE + 8;
const MAX_PULL = 16;
export type MagneticPoint = { x: number; y: number };
export type MagneticState = MagneticPoint & { vx: number; vy: number };

export function magneticTarget(dx: number, dy: number, captured: boolean): MagneticPoint | null {
  const distance = Math.hypot(dx, dy);
  if (distance > (captured ? RELEASE : MAGNETIC_CAPTURE)) return null;
  const ratio = distance ? MAX_PULL * Math.tanh(.72 * distance / MAX_PULL) / distance : 0;
  return { x: dx * ratio, y: dy * ratio };
}

// Keep velocity when the pointer leaves or re-enters. Small semi-implicit Euler steps also
// keep the same damping on 60/120 Hz displays and after a suspended frame.
export function stepMagneticHandle(state: MagneticState, target: MagneticPoint | null, elapsedMs: number) {
  const dt = Math.min(32, Math.max(0, elapsedMs));
  const steps = Math.max(1, Math.ceil(dt));
  const h = dt / steps / 1000;
  const w = target ? 65 : 31;
  const damping = 2 * w * (target ? 1 : .58);
  const x = target?.x ?? 0, y = target?.y ?? 0;
  for (let i = 0; i < steps; i++) {
    state.vx += (w * w * (x - state.x) - damping * state.vx) * h;
    state.vy += (w * w * (y - state.y) - damping * state.vy) * h;
    state.x += state.vx * h;
    state.y += state.vy * h;
  }
  if (Math.hypot(state.x - x, state.y - y) >= .1 || Math.hypot(state.vx, state.vy) >= 1) return false;
  Object.assign(state, { x, y, vx: 0, vy: 0 });
  return true;
}
