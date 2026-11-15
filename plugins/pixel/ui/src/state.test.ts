import { describe, expect, it } from 'vitest';

import palettes from '../../server/palettes.json';
import { DEFAULT_STATE, PRESET_NAMES, parseState, summary } from './state';

describe('像素化节点数据', () => {
  it('坏值回落到默认值', () => {
    expect(parseState({
      size_mode: 'x', long_edge: 2, palette: { kind: 'magic', colors: 999, preset: 'zx' }, upscale: 0,
      alpha_threshold: 'a', dither: { kind: 'noise', strength: 200 }, cleanup: { isolated: 3, min_region: 99 },
      outline: { enabled: 'yes', connectivity: 6, color: 'red' },
    })).toEqual(DEFAULT_STATE);
  });
  it('摘要按尺寸方式、调色板与放大倍数显示', () => {
    expect(summary(DEFAULT_STATE)).toBe('64 px · 16 色 · ×4');
    expect(summary({ ...DEFAULT_STATE, size_mode: 'block', block: 6, upscale: 1 })).toBe('6 合 1 · 16 色');
    expect(summary({ ...DEFAULT_STATE, palette: { ...DEFAULT_STATE.palette, kind: 'preset', preset: 'gameboy' } }))
      .toBe('64 px · Game Boy · ×4');
  });
  it('预设名字与服务端的调色板文件一致', () => {
    expect(Object.fromEntries(palettes.palettes.map(item => [item.id, item.name]))).toEqual(PRESET_NAMES);
  });
});
