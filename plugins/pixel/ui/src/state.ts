/** 像素化节点的数据（payload，版本 1）。读的时候逐项校验，坏值回落到默认值。 */
export type SizeMode = 'long_edge' | 'block';
export type Downsample = 'mode' | 'average';

export interface PixelState {
  size_mode: SizeMode;
  long_edge: number;
  block: number;
  downsample: Downsample;
  palette: { kind: 'auto'; colors: number };
  /** 结果组整组共用一个调色板。 */
  shared_palette: boolean;
  alpha_threshold: number;
  upscale: number;
  /** 放大时另外输出实际像素尺寸。 */
  keep_original_size: boolean;
}

export const LIMITS = {
  longEdge: [8, 512], block: [2, 64], colors: [2, 64], alpha: [1, 255], upscale: [1, 16],
} as const;

export const DEFAULT_STATE: PixelState = {
  size_mode: 'long_edge', long_edge: 64, block: 8, downsample: 'mode', palette: { kind: 'auto', colors: 16 },
  shared_palette: true, alpha_threshold: 128, upscale: 4, keep_original_size: true,
};

const intIn = (value: unknown, [min, max]: readonly [number, number], fallback: number) => (
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback);

export function parseState(payload: unknown): PixelState {
  const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const palette = raw.palette && typeof raw.palette === 'object' ? raw.palette as Record<string, unknown> : {};
  return {
    size_mode: raw.size_mode === 'block' ? 'block' : 'long_edge',
    long_edge: intIn(raw.long_edge, LIMITS.longEdge, DEFAULT_STATE.long_edge),
    block: intIn(raw.block, LIMITS.block, DEFAULT_STATE.block),
    downsample: raw.downsample === 'average' ? 'average' : 'mode',
    palette: { kind: 'auto', colors: intIn(palette.colors, LIMITS.colors, DEFAULT_STATE.palette.colors) },
    shared_palette: raw.shared_palette !== false,
    alpha_threshold: intIn(raw.alpha_threshold, LIMITS.alpha, DEFAULT_STATE.alpha_threshold),
    upscale: intIn(raw.upscale, LIMITS.upscale, DEFAULT_STATE.upscale),
    keep_original_size: raw.keep_original_size !== false,
  };
}

export function summary(state: PixelState): string {
  const size = state.size_mode === 'long_edge' ? `${state.long_edge} px` : `${state.block} 合 1`;
  return `${size} · ${state.palette.colors} 色${state.upscale > 1 ? ` · ×${state.upscale}` : ''}`;
}

/** 发给服务端的参数。 */
export function requestParams(state: PixelState): Record<string, unknown> {
  return { ...state };
}
