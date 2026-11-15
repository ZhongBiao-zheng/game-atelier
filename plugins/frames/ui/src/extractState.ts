/** 视频抽帧节点的数据（payload，版本 1）。读的时候逐项校验，坏值回落到默认值。 */
import { LONG_EDGE_MAX, LONG_EDGE_MIN, MAX_FRAMES, type Mode, type PlanParams } from './plan';

export interface ExtractState {
  start: number;
  /** 结束帧（含）；null 表示到最后一帧。 */
  end: number | null;
  mode: Mode;
  count: number;
  step: number;
  rate: number;
  /** 按长边缩放到多少像素；null 表示原尺寸。 */
  long_edge: number | null;
  sheet: boolean;
  columns: number;
  frame_data: boolean;
}

export const DEFAULT_STATE: ExtractState = {
  start: 0, end: null, mode: 'count', count: 12, step: 2, rate: 12,
  long_edge: null, sheet: false, columns: 8, frame_data: true,
};
export const DEFAULT_LONG_EDGE = 512;

const intIn = (value: unknown, min: number, max: number, fallback: number) => (
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback);

export function parseState(payload: unknown): ExtractState {
  const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const mode = raw.mode === 'step' || raw.mode === 'rate' || raw.mode === 'count' ? raw.mode : DEFAULT_STATE.mode;
  return {
    start: intIn(raw.start, 0, 1_000_000, DEFAULT_STATE.start),
    end: raw.end === null || raw.end === undefined ? null : intIn(raw.end, 0, 1_000_000, 0),
    mode,
    count: intIn(raw.count, 1, MAX_FRAMES, DEFAULT_STATE.count),
    step: intIn(raw.step, 1, 10_000, DEFAULT_STATE.step),
    rate: intIn(raw.rate, 1, 60, DEFAULT_STATE.rate),
    long_edge: raw.long_edge === null || raw.long_edge === undefined
      ? null : intIn(raw.long_edge, LONG_EDGE_MIN, LONG_EDGE_MAX, DEFAULT_LONG_EDGE),
    sheet: raw.sheet === true,
    columns: intIn(raw.columns, 1, MAX_FRAMES, DEFAULT_STATE.columns),
    frame_data: raw.frame_data !== false,
  };
}

/** 发给服务端的抽帧参数（与 plan.ts 的 PlanParams 一致，外加尺寸与输出选项）。 */
export function requestParams(state: ExtractState): PlanParams & Record<string, unknown> {
  return {
    start: state.start, end: state.end, mode: state.mode, count: state.count, step: state.step, rate: state.rate,
    long_edge: state.long_edge, sheet: state.sheet, columns: state.columns, frame_data: state.frame_data,
  };
}

export function modeSummary(state: ExtractState): string {
  if (state.mode === 'count') return `均匀取 ${state.count} 帧`;
  if (state.mode === 'step') return `每隔 ${state.step} 帧`;
  return `每秒 ${state.rate} 帧`;
}
