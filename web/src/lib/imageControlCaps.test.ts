import { describe, it, expect } from 'vitest';

import { imageControlCaps } from './imageControlCaps';
import { normalizeGptImagePixelSize, normalizeStudioPixelSizeForModel } from './studioSize';

describe('imageControlCaps', () => {
  it('nano-banana: 仅比例 + 质量，无分辨率/自定义尺寸，size 传比例', () => {
    const c = imageControlCaps('nano-banana');
    expect(c.family).toBe('nano-banana');
    expect(c.showResolution).toBe(false);
    expect(c.showCustomSize).toBe(false);
    expect(c.qualities).toEqual(['low', 'medium', 'high']);
    expect(c.sizeKind).toBe('ratio');
  });

  it('gpt-image: 比例 + 自定义尺寸 + 质量(含 auto)，无分辨率，size 传像素', () => {
    const c = imageControlCaps('gpt-image-2');
    expect(c.family).toBe('gpt-image');
    expect(c.showResolution).toBe(false);
    expect(c.showCustomSize).toBe(true);
    expect(c.qualities).toContain('auto');
    expect(c.sizeKind).toBe('pixels');
  });

  it('seedream/默认: 分辨率 + 自定义尺寸，无质量', () => {
    const c = imageControlCaps('doubao-seedream-5-0-260128');
    expect(c.family).toBe('standard');
    expect(c.showResolution).toBe(true);
    expect(c.showCustomSize).toBe(true);
    expect(c.qualities).toBeNull();
  });
});

describe('normalizeGptImagePixelSize', () => {
  it('双边取 16 的倍数', () => {
    expect(normalizeGptImagePixelSize({ w: 1000, h: 1000 })).toEqual({ w: 1008, h: 1008 });
  });

  it('最大边超 3840 按比例钳制', () => {
    const { w, h } = normalizeGptImagePixelSize({ w: 5000, h: 2000 });
    expect(Math.max(w, h)).toBeLessThanOrEqual(3840);
    expect(w % 16).toBe(0);
    expect(h % 16).toBe(0);
  });

  it('normalizeStudioPixelSizeForModel 对 gpt-image 走 /16 归一', () => {
    expect(normalizeStudioPixelSizeForModel({ w: 1000, h: 1000 }, 'custom', 'gpt-image-2'))
      .toEqual({ w: 1008, h: 1008 });
    // 非 gpt 模型不强制 /16
    expect(normalizeStudioPixelSizeForModel({ w: 1000, h: 1000 }, 'openai', 'some-model'))
      .toEqual({ w: 1000, h: 1000 });
  });
});
