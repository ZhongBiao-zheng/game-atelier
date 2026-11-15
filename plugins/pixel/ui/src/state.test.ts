import { describe, expect, it } from 'vitest';

import { DEFAULT_STATE, parseState, summary } from './state';

describe('像素化节点数据', () => {
  it('坏值回落到默认值', () => {
    expect(parseState({ size_mode: 'x', long_edge: 2, palette: { colors: 999 }, upscale: 0, alpha_threshold: 'a' }))
      .toEqual(DEFAULT_STATE);
  });
  it('摘要按尺寸方式与放大倍数显示', () => {
    expect(summary(DEFAULT_STATE)).toBe('64 px · 16 色 · ×4');
    expect(summary({ ...DEFAULT_STATE, size_mode: 'block', block: 6, upscale: 1 })).toBe('6 合 1 · 16 色');
  });
});
