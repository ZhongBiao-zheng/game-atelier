/** 节点里保存的精灵表设置。读到不认识的版本或坏数据时回落到默认值，不覆盖原数据直到用户改动。 */
export interface Frame { x: number; y: number; w: number; h: number }
export type Align = 'bottom-center' | 'center' | 'top-left';
export interface SheetState {
  version: 1;
  frames: Frame[];
  grid: { columns: number; rows: number } | null;
  columns: number;
  spacing: number;
  align: Align;
  fps: number;
}

export const DEFAULT_STATE: SheetState = { version: 1, frames: [], grid: null, columns: 4, spacing: 0, align: 'bottom-center', fps: 8 };
const ALIGNS: Align[] = ['bottom-center', 'center', 'top-left'];
const int = (value: unknown, fallback: number, min: number, max: number) => (
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
);

export function parseState(payload: unknown): SheetState {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const frames = Array.isArray(raw.frames) ? raw.frames.flatMap(item => {
    const frame = item as Partial<Frame> | null;
    return frame && [frame.x, frame.y, frame.w, frame.h].every(value => typeof value === 'number' && Number.isFinite(value))
      && frame.w! > 0 && frame.h! > 0 ? [{ x: frame.x!, y: frame.y!, w: frame.w!, h: frame.h! }] : [];
  }).slice(0, 1024) : [];
  const grid = raw.grid && typeof raw.grid === 'object'
    ? { columns: int((raw.grid as Record<string, unknown>).columns, 1, 1, 64), rows: int((raw.grid as Record<string, unknown>).rows, 1, 1, 64) }
    : null;
  return {
    version: 1, frames, grid,
    columns: int(raw.columns, DEFAULT_STATE.columns, 1, 64),
    spacing: int(raw.spacing, 0, 0, 256),
    align: ALIGNS.includes(raw.align as Align) ? raw.align as Align : 'bottom-center',
    fps: int(raw.fps, DEFAULT_STATE.fps, 1, 60),
  };
}

/** 手动网格：与服务端 sheet.grid_frames（无边距、无间距）同一算法。 */
export function gridFrames(width: number, height: number, columns: number, rows: number): Frame[] {
  const w = Math.floor(width / columns);
  const h = Math.floor(height / rows);
  if (w < 1 || h < 1) return [];
  const frames: Frame[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) frames.push({ x: column * w, y: row * h, w, h });
  return frames;
}
