import { describe, expect, it } from 'vitest';

import { imageControlCaps } from './imageControlCaps';
import { gptImage26JobParams, normalizeImageSizeParams } from './imageSizeMode';
import { intersectImageCaps } from './modelRoutes';

describe('Seedream 5.5 透明背景跟着模型走', () => {
  it('只在 5.5 且非 OpenRouter 时给开关', () => {
    expect(imageControlCaps('seedream-5.5', 'tokendance').transparentBackground).toBe(true);
    expect(imageControlCaps('doubao-seedream-5-5-261028', 'seedream').transparentBackground).toBe(true);
    expect(imageControlCaps('bytedance-seed/seedream-5-5', 'openrouter').transparentBackground).toBe(false);
    expect(imageControlCaps('seedream-5.0-pro', 'tokendance').transparentBackground).toBe(false);
  });

  it('换到不支持的模型时丢掉 background，提交时只发 transparent', () => {
    const draft = { size_mode: 'ratio' as const, ratio: '1:1', background: 'transparent' as const };
    expect(normalizeImageSizeParams('seedream-5.5', 'tokendance', null, draft).background).toBe('transparent');
    expect(normalizeImageSizeParams('seedream-5.0-pro', 'tokendance', null, draft).background).toBeUndefined();
    const caps = imageControlCaps('seedream-5.5', 'tokendance');
    expect(gptImage26JobParams(caps, { background: 'transparent' }, true)).toEqual({ background: 'transparent' });
    expect(gptImage26JobParams(caps, { background: 'opaque' }, false)).toEqual({});
  });

  it('「自动」路由里有成员走 OpenRouter 就不给开关', () => {
    const direct = imageControlCaps('doubao-seedream-5-5-261028', 'seedream');
    const openrouter = imageControlCaps('bytedance-seed/seedream-5-5', 'openrouter');
    expect(intersectImageCaps([direct, imageControlCaps('seedream-5.5', 'tokendance')]).transparentBackground).toBe(true);
    expect(intersectImageCaps([direct, openrouter]).transparentBackground).toBe(false);
  });
});
