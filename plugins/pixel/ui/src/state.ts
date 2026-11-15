/** 像素化节点的数据（payload，版本 1）。读的时候逐项校验，坏值回落到默认值。 */
export type SizeMode = 'long_edge' | 'block';
export type Downsample = 'mode' | 'average';
export type PaletteKind = 'auto' | 'preset' | 'custom';
export type DitherKind = 'none' | 'bayer2' | 'bayer4' | 'bayer8' | 'floyd';

export interface PixelState {
  size_mode: SizeMode;
  long_edge: number;
  block: number;
  downsample: Downsample;
  palette: { kind: PaletteKind; colors: number; preset: string; custom: string };
  /** 结果组整组共用一个调色板。 */
  shared_palette: boolean;
  alpha_threshold: number;
  dither: { kind: DitherKind; strength: number };
  /** isolated：0 不处理，4 / 8 按邻域去孤立像素；min_region：0 不合并，否则合并面积小于它的色块。 */
  cleanup: { isolated: 0 | 4 | 8; min_region: number };
  /** color：'darkest' 为调色板最深色，否则 #RRGGBB。 */
  outline: { enabled: boolean; connectivity: 4 | 8; color: string };
  upscale: number;
  /** 放大时另外输出实际像素尺寸。 */
  keep_original_size: boolean;
}

export const LIMITS = {
  longEdge: [8, 512], block: [2, 64], colors: [2, 64], alpha: [1, 255], upscale: [1, 16], strength: [0, 100],
  minRegion: [0, 16],
} as const;

/** 预设调色板的名字，与 server/palettes.json 一致（state.test.ts 校验）。色值只在服务端。 */
export const PRESET_NAMES: Record<string, string> = {
  'pico-8': 'PICO-8', gameboy: 'Game Boy', db16: 'DawnBringer 16', db32: 'DawnBringer 32',
  'endesga-32': 'Endesga 32', nes: 'NES',
};

/** 描边颜色的可选值：这是写进节点数据的色值，不是界面样式。 */
export const OUTLINE_COLOR_OPTIONS = [
  { value: 'darkest', label: '调色板最深色' }, { value: '#000000', label: '黑' }, { value: '#ffffff', label: '白' },
] as const;

export const DEFAULT_STATE: PixelState = {
  size_mode: 'long_edge', long_edge: 64, block: 8, downsample: 'mode',
  palette: { kind: 'auto', colors: 16, preset: 'pico-8', custom: '' },
  shared_palette: true, alpha_threshold: 128,
  dither: { kind: 'none', strength: 50 },
  cleanup: { isolated: 0, min_region: 0 },
  outline: { enabled: false, connectivity: 4, color: 'darkest' },
  upscale: 4, keep_original_size: true,
};

const intIn = (value: unknown, [min, max]: readonly [number, number], fallback: number) => (
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback);
const objectOf = (value: unknown) => (value && typeof value === 'object' ? value as Record<string, unknown> : {});
const oneOf = <T extends string | number>(value: unknown, options: readonly T[], fallback: T): T => (
  options.includes(value as T) ? value as T : fallback);

export function parseState(payload: unknown): PixelState {
  const raw = objectOf(payload);
  const palette = objectOf(raw.palette);
  const dither = objectOf(raw.dither);
  const cleanup = objectOf(raw.cleanup);
  const outline = objectOf(raw.outline);
  return {
    size_mode: raw.size_mode === 'block' ? 'block' : 'long_edge',
    long_edge: intIn(raw.long_edge, LIMITS.longEdge, DEFAULT_STATE.long_edge),
    block: intIn(raw.block, LIMITS.block, DEFAULT_STATE.block),
    downsample: raw.downsample === 'average' ? 'average' : 'mode',
    palette: {
      kind: oneOf(palette.kind, ['auto', 'preset', 'custom'] as const, 'auto'),
      colors: intIn(palette.colors, LIMITS.colors, DEFAULT_STATE.palette.colors),
      preset: typeof palette.preset === 'string' && palette.preset in PRESET_NAMES ? palette.preset : DEFAULT_STATE.palette.preset,
      custom: typeof palette.custom === 'string' ? palette.custom.slice(0, 4000) : '',
    },
    shared_palette: raw.shared_palette !== false,
    alpha_threshold: intIn(raw.alpha_threshold, LIMITS.alpha, DEFAULT_STATE.alpha_threshold),
    dither: {
      kind: oneOf(dither.kind, ['none', 'bayer2', 'bayer4', 'bayer8', 'floyd'] as const, 'none'),
      strength: intIn(dither.strength, LIMITS.strength, DEFAULT_STATE.dither.strength),
    },
    cleanup: {
      isolated: oneOf(cleanup.isolated, [0, 4, 8] as const, 0),
      min_region: intIn(cleanup.min_region, LIMITS.minRegion, 0),
    },
    outline: {
      enabled: outline.enabled === true,
      connectivity: oneOf(outline.connectivity, [4, 8] as const, 4),
      color: typeof outline.color === 'string' && /^(darkest|#[0-9a-fA-F]{6})$/.test(outline.color) ? outline.color : 'darkest',
    },
    upscale: intIn(raw.upscale, LIMITS.upscale, DEFAULT_STATE.upscale),
    keep_original_size: raw.keep_original_size !== false,
  };
}

export function summary(state: PixelState): string {
  const size = state.size_mode === 'long_edge' ? `${state.long_edge} px` : `${state.block} 合 1`;
  const palette = state.palette.kind === 'preset' ? PRESET_NAMES[state.palette.preset]
    : state.palette.kind === 'custom' ? '自定义调色板' : `${state.palette.colors} 色`;
  return `${size} · ${palette}${state.upscale > 1 ? ` · ×${state.upscale}` : ''}`;
}

/** 发给服务端的参数。 */
export function requestParams(state: PixelState): Record<string, unknown> {
  return { ...state };
}
