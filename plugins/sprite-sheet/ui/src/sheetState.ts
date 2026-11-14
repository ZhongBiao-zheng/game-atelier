/** 节点里保存的精灵表设置。读到不认识的版本或坏数据时回落到默认值，不覆盖原数据直到用户改动。 */
/** `ox` / `oy`：逐帧偏移（像素）。`ax` / `ay`：这一帧单独的锚点（0–1 比例），省略时用整表锚点。 */
export interface Frame { x: number; y: number; w: number; h: number; ox?: number; oy?: number; ax?: number; ay?: number }
export type Align = 'bottom-center' | 'center' | 'top-left';
export interface Grid { columns: number; rows: number; margin: number; spacing: number }
export interface SheetState {
  version: 1;
  frames: Frame[];
  grid: Grid | null;
  columns: number;
  spacing: number;
  margin: number;
  align: Align;
  trim: boolean;
  /** 0–1 的比例，(0.5, 1) 是格子底边中点。 */
  anchor: { x: number; y: number };
  fps: number;
  onion: boolean;
}

export const MAX_OFFSET = 512;
export const DEFAULT_GRID: Grid = { columns: 4, rows: 1, margin: 0, spacing: 0 };
export const DEFAULT_STATE: SheetState = {
  version: 1, frames: [], grid: null, columns: 4, spacing: 0, margin: 0, align: 'bottom-center',
  trim: true, anchor: { x: 0.5, y: 1 }, fps: 8, onion: true,
};
const ALIGNS: Align[] = ['bottom-center', 'center', 'top-left'];
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const int = (value: unknown, fallback: number, min: number, max: number) => (
  isNumber(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback
);
const ratio = (value: unknown, fallback: number) => (isNumber(value) ? Math.min(1, Math.max(0, value)) : fallback);

function parseFrame(item: unknown): Frame[] {
  const frame = item as Partial<Frame> | null;
  if (!frame || ![frame.x, frame.y, frame.w, frame.h].every(isNumber) || frame.w! <= 0 || frame.h! <= 0) return [];
  const parsed: Frame = { x: frame.x!, y: frame.y!, w: frame.w!, h: frame.h! };
  const ox = int(frame.ox, 0, -MAX_OFFSET, MAX_OFFSET);
  const oy = int(frame.oy, 0, -MAX_OFFSET, MAX_OFFSET);
  const withOffset = ox || oy ? { ...parsed, ox, oy } : parsed;
  // 单独锚点要两个分量都在：只剩一个时当作没有覆盖，避免和整表锚点拼出不想要的点。
  return [isNumber(frame.ax) && isNumber(frame.ay)
    ? { ...withOffset, ax: ratio(frame.ax, 0.5), ay: ratio(frame.ay, 1) } : withOffset];
}

export function parseState(payload: unknown): SheetState {
  const raw = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const grid = raw.grid && typeof raw.grid === 'object' ? raw.grid as Record<string, unknown> : null;
  const anchor = raw.anchor && typeof raw.anchor === 'object' ? raw.anchor as Record<string, unknown> : {};
  return {
    version: 1,
    frames: Array.isArray(raw.frames) ? raw.frames.flatMap(parseFrame).slice(0, 1024) : [],
    grid: grid ? {
      columns: int(grid.columns, 1, 1, 64), rows: int(grid.rows, 1, 1, 64),
      margin: int(grid.margin, 0, 0, 512), spacing: int(grid.spacing, 0, 0, 512),
    } : null,
    columns: int(raw.columns, DEFAULT_STATE.columns, 1, 64),
    spacing: int(raw.spacing, 0, 0, 256),
    margin: int(raw.margin, 0, 0, 256),
    align: ALIGNS.includes(raw.align as Align) ? raw.align as Align : 'bottom-center',
    trim: typeof raw.trim === 'boolean' ? raw.trim : true,
    anchor: { x: ratio(anchor.x, 0.5), y: ratio(anchor.y, 1) },
    fps: int(raw.fps, DEFAULT_STATE.fps, 1, 60),
    onion: typeof raw.onion === 'boolean' ? raw.onion : true,
  };
}

/** 手动网格：与服务端 sheet.grid_frames 同一算法（行优先，余数丢在右下）。 */
export function gridFrames(width: number, height: number, grid: Grid): Frame[] {
  const { columns, rows, margin, spacing } = grid;
  const w = Math.floor((width - 2 * margin - (columns - 1) * spacing) / columns);
  const h = Math.floor((height - 2 * margin - (rows - 1) * spacing) / rows);
  if (w < 1 || h < 1) return [];
  const frames: Frame[] = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      frames.push({ x: margin + column * (w + spacing), y: margin + row * (h + spacing), w, h });
    }
  }
  return frames;
}

export function moveFrame(frames: readonly Frame[], from: number, to: number): Frame[] {
  const next = [...frames];
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved);
  return next;
}

/** 这一帧实际用的锚点：有单独锚点用它的，否则用整表的。 */
export function frameAnchor(frame: Frame | undefined, fallback: { x: number; y: number }): { x: number; y: number } {
  return frame?.ax !== undefined && frame.ay !== undefined ? { x: frame.ax, y: frame.ay } : fallback;
}

/** 设置或去掉某一帧的单独锚点。 */
export function setFrameAnchor(frames: readonly Frame[], index: number, anchor: { x: number; y: number } | null): Frame[] {
  return frames.map((frame, at) => {
    if (at !== index) return frame;
    const { ax: _ax, ay: _ay, ...rest } = frame;
    return anchor ? { ...rest, ax: anchor.x, ay: anchor.y } : rest;
  });
}

export function nudgeFrame(frames: readonly Frame[], index: number, dx: number, dy: number): Frame[] {
  return frames.map((frame, at) => {
    if (at !== index) return frame;
    const ox = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, (frame.ox ?? 0) + dx));
    const oy = Math.max(-MAX_OFFSET, Math.min(MAX_OFFSET, (frame.oy ?? 0) + dy));
    return { ...frame, ox, oy };
  });
}
