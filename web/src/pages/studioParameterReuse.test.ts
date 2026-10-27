import { describe, expect, it } from 'vitest';
import type { KeyView } from '@/api/keys';
import type { RoundConfig } from '@/components/studio/RoundList';
import { reuseRoundParameter, type ParameterReuseContext, type RoundParameter } from './studioParameterReuse';

function context(model = 'gpt-image-2', provider = 'openai', kind: 'image' | 'video' = 'image'): ParameterReuseContext {
  const key: KeyView = { alias: 'key', provider, base_url: null, access_key: '', secret_key: null,
    capabilities: [], models: [{ id: model, name: model, modality: kind }], notes: '', created_at: '' };
  return { providers: [key], alias: 'key', model, kind,
    sizeParams: { size_mode: 'ratio', ratio: '1:1', size: '1024x1024' } };
}
const config: RoundConfig = { prompt: 'unchanged', alias: 'key', model: 'gpt-image-2', referenceImages: [] };

describe('history parameter reuse', () => {
  it('selects the recorded provider and model without copying other settings', () => {
    expect(reuseRoundParameter(config, 'model', context())).toEqual({ alias: 'key', model: 'gpt-image-2', kind: 'image' });
    const video = context('kling-v1', 'custom', 'video');
    expect(reuseRoundParameter({ ...config, model: 'kling-v1' }, 'model', video)?.kind).toBe('video');
    for (const providers of [[], [{ ...context().providers[0], enabled: false }], [{ ...context().providers[0], models: [] }]]) {
      expect(reuseRoundParameter(config, 'model', { ...context(), providers })).toBeNull();
    }
  });
  it('normalizes supported image sizes and rejects unsupported ratios and custom sizes', () => {
    expect(reuseRoundParameter({ ...config, ratio: '16:9', sizeMode: 'ratio' }, 'size', context())?.sizeParams)
      .toMatchObject({ size_mode: 'ratio', ratio: '16:9' });
    expect(reuseRoundParameter({ ...config, ratio: '100:1' }, 'size', context())).toBeNull();
    expect(reuseRoundParameter({ ...config, sizeMode: 'custom', size: '1024x1536' }, 'size', context())?.sizeParams)
      .toMatchObject({ size_mode: 'custom', size: '1024x1536' });
    expect(reuseRoundParameter({ ...config, sizeMode: 'custom', size: '1024x1536' }, 'size', context('nano-banana-2'))).toBeNull();
    expect(reuseRoundParameter({ ...config, sizeMode: 'auto' }, 'size', context())?.sizeParams?.size).toBe('auto');
    expect(reuseRoundParameter({ ...config, sizeMode: 'auto' }, 'size', context('seedream-4'))).toBeNull();
  });
  it('copies only supported resolution and quality values', () => {
    expect(reuseRoundParameter({ ...config, resolution: '4K' }, 'resolution', context('seedream-4'))?.sizeParams?.resolution).toBe('4K');
    expect(reuseRoundParameter({ ...config, resolution: '4K' }, 'resolution', context())).toBeNull();
    expect(reuseRoundParameter({ ...config, quality: 'high' }, 'quality', context())).toEqual({ quality: 'high' });
    expect(reuseRoundParameter({ ...config, quality: 'high' }, 'quality', context('seedream-4'))).toBeNull();
  });
  it('clamps image count to the current UI limit and leaves MJ unchanged', () => {
    expect(reuseRoundParameter({ ...config, n: 20 }, 'count', context())).toEqual({ count: 4 });
    expect(reuseRoundParameter({ ...config, n: 2 }, 'count', context('midjourney'))).toBeNull();
  });
  it.each([
    ['size', { ratio: '16:9' }, { ratio: '100:1' }, { videoRatio: '16:9' }],
    ['resolution', { videoResolution: '720p' }, { videoResolution: '8K' }, { videoResolution: '720p' }],
    ['duration', { duration: 10 }, { duration: 99 }, { duration: 10 }],
    ['audio', { generateAudio: false }, {}, { generateAudio: false }],
    ['count', { n: 20 }, {}, { videoCount: 4 }],
  ] as Array<[RoundParameter, Partial<RoundConfig>, Partial<RoundConfig>, object]>)('copies supported video %s and ignores missing/unsupported values', (parameter, supported, unsupported, expected) => {
    const current = context('seedance-2.0', 'seedream', 'video');
    expect(reuseRoundParameter({ ...config, kind: 'video', ...supported }, parameter, current)).toEqual(expected);
    expect(reuseRoundParameter({ ...config, kind: 'video', ...unsupported }, parameter, current)).toBeNull();
    expect(reuseRoundParameter({ ...config, kind: 'video', ...supported }, parameter, context())).toBeNull();
  });
  it('checks video quality and audio against the current video model', () => {
    expect(reuseRoundParameter({ ...config, kind: 'video', videoQuality: 'pro' }, 'quality', context('kling-v1', 'custom', 'video'))).toEqual({ videoQuality: 'pro' });
    expect(reuseRoundParameter({ ...config, kind: 'video', videoQuality: 'pro' }, 'quality', context('seedance-2.0', 'seedream', 'video'))).toBeNull();
    expect(reuseRoundParameter({ ...config, kind: 'video', generateAudio: true }, 'audio', context('kling-v1', 'custom', 'video'))).toBeNull();
  });
});
