/** 抽帧计划与输出尺寸，与服务端 server/plan.py 同一套算法，两边跑 tests/plan_cases.json。
 *  取整一律用 floor(x + 0.5)，与 Python 端逐帧一致。 */
export const MAX_FRAMES = 65;
export const LONG_EDGE_MIN = 16;
export const LONG_EDGE_MAX = 4096;

export type Mode = 'count' | 'step' | 'rate';
export interface PlanParams { start: number; end: number | null; mode: Mode; count?: number; step?: number; rate?: number }

const halfUp = (value: number) => Math.floor(value + 0.5);

export class PlanError extends Error {}

export function planFrames(frameCount: number, fps: number, params: PlanParams): number[] {
  if (!(fps > 0) || !Number.isFinite(fps)) throw new PlanError('读不出视频的帧率');
  if (frameCount < 1) throw new PlanError('视频里没有可读的帧');
  const start = Math.trunc(params.start);
  const end = params.end === null ? frameCount - 1 : Math.min(Math.trunc(params.end), frameCount - 1);
  if (start < 0 || start >= frameCount) throw new PlanError('起始帧超出了视频');
  if (end < start) throw new PlanError('结束帧要在起始帧之后');
  let raw: number[];
  if (params.mode === 'count') {
    const count = Math.trunc(params.count ?? 12);
    if (count < 1 || count > MAX_FRAMES) throw new PlanError(`帧数要在 1 到 ${MAX_FRAMES} 之间`);
    raw = count === 1 ? [start] : Array.from({ length: count }, (_, index) => halfUp(start + index * (end - start) / (count - 1)));
  } else if (params.mode === 'step') {
    const step = Math.trunc(params.step ?? 1);
    if (step < 1) throw new PlanError('间隔至少 1 帧');
    raw = [];
    for (let frame = start; frame <= end; frame += step) raw.push(frame);
  } else {
    const rate = Math.trunc(params.rate ?? 12);
    if (rate < 1) throw new PlanError('每秒至少 1 帧');
    const interval = Math.max(1, fps / rate);
    raw = [];
    for (let index = 0, frame = start; frame <= end; index += 1, frame = halfUp(start + index * interval)) raw.push(frame);
  }
  const frames = [...new Set(raw)];
  if (frames.length > MAX_FRAMES) throw new PlanError(`最多 ${MAX_FRAMES} 帧，现在是 ${frames.length} 帧`);
  return frames;
}

export function outputSize(width: number, height: number, longEdge: number | null): [number, number] {
  if (longEdge === null) return [width, height];
  const scale = longEdge / Math.max(width, height);
  return [Math.max(1, halfUp(width * scale)), Math.max(1, halfUp(height * scale))];
}
