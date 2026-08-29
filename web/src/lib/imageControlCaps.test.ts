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

  it('固定 2K/4K 型号由模型名控制清晰度，不显示或提交 quality', () => {
    expect(imageControlCaps('nano-banana-pro-4k').qualities).toBeNull();
    expect(imageControlCaps('nano-banana-2-2k').qualities).toBeNull();
    expect(imageControlCaps('vendor/nano_banana_pro_4k').qualities).toBeNull();
    expect(imageControlCaps('nano-banana-pro-4k-vip').qualities).toBeNull();
    expect(imageControlCaps('nano-banana-pro').qualities).toEqual(['low', 'medium', 'high']);
  });

  it('gpt-image: 比例 + 自定义尺寸 + 质量(含 auto)，无分辨率，size 传像素', () => {
    const c = imageControlCaps('gpt-image-2');
    expect(c.family).toBe('gpt-image');
    expect(c.showResolution).toBe(false);
    expect(c.showCustomSize).toBe(true);
    expect(c.qualities).toContain('auto');
    expect(c.supportsTransparentBackground).toBe(true);
    expect(c.sizeKind).toBe('pixels');
  });

  it('OpenRouter 不暴露未验证的透明背景能力', () => {
    expect(imageControlCaps('openai/gpt-image-1', 'openrouter').supportsTransparentBackground)
      .toBe(false);
  });

  it('Ark 协议不暴露仅直连 OpenAI 协议验证过的透明背景能力', () => {
    expect(imageControlCaps('gpt-image-2', 'custom', 'ark').supportsTransparentBackground)
      .toBe(false);
    expect(imageControlCaps('gpt-image-2', 'custom', 'openai').supportsTransparentBackground)
      .toBe(true);
  });

  it('seedream: 分辨率 + 自定义尺寸，无质量', () => {
    const c = imageControlCaps('doubao-seedream-5-0-260128');
    expect(c.family).toBe('seedream');
    expect(c.showResolution).toBe(true);
    expect(c.showCustomSize).toBe(true);
    expect(c.qualities).toBeNull();
  });

  it('未知模型回落 standard: 与 seedream 同控件，但不做最小像素归一', () => {
    const c = imageControlCaps('black-forest-labs/flux.2-pro');
    expect(c.family).toBe('standard');
    expect(c.showResolution).toBe(true);
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
    expect(normalizeStudioPixelSizeForModel({ w: 1000, h: 1000 }, 'gpt-image-2'))
      .toEqual({ w: 1008, h: 1008 });
    // standard 族不归一（既不 /16 也无像素下限）
    expect(normalizeStudioPixelSizeForModel({ w: 1000, h: 1000 }, 'some-model'))
      .toEqual({ w: 1000, h: 1000 });
  });

  it('seedream 按模型分档抬到像素下限：pro 921600、其余 3686400', () => {
    // 2048×1152（16:9 通用算法）低于默认下限 → 抬到 ≥3686400，避免后端静默改写
    const lite = normalizeStudioPixelSizeForModel({ w: 2048, h: 1152 }, 'seedream-5.0-lite');
    expect(lite.w * lite.h).toBeGreaterThanOrEqual(3686400);
    // pro 下限只有 921600，2048×1152 已经够 → 原样，不白付 4 倍像素
    expect(normalizeStudioPixelSizeForModel({ w: 2048, h: 1152 }, 'seedream-5.0-pro'))
      .toEqual({ w: 2048, h: 1152 });
  });
});
