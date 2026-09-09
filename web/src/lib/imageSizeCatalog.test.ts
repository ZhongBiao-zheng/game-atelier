import { describe, expect, it } from 'vitest';
import catalog from '../../../src/character_workflow/image_size_catalog.json';
import { imageControlCaps } from './imageControlCaps';
import { normalizeImageSizeParams, prepareImageSizeSubmission } from './imageSizeMode';
import { computeStudioPixelSize, normalizeStudioPixelSizeForModel } from './studioSize';

describe('channel-specific image size catalog', () => {
  for (const [model, entry] of Object.entries(catalog.openrouter)) {
    it(`preserves the full OpenRouter size descriptor for ${model}`, () => {
      const provider = 'openrouter', url = 'https://openrouter.ai/api/v1';
      const caps = imageControlCaps(model, provider, url);
      expect(caps.ratios).toEqual(entry.ratios.filter(r => r !== 'auto'));
      expect(caps.showAutoSize).toBe((entry.ratios as string[]).includes('auto'));
      expect(caps.resolutions).toEqual(entry.resolutions);
      expect(normalizeImageSizeParams(model, provider, url, {}).resolution).toBeUndefined();
      for (const ratio of caps.ratios) {
        const result = prepareImageSizeSubmission(model, provider, url, { size_mode: 'ratio', ratio });
        expect(result.params).toMatchObject({ ratio, size: ratio });
        expect(result.params?.resolution).toBeUndefined();
        for (const resolution of entry.resolutions) {
          expect(prepareImageSizeSubmission(model, provider, url, { size_mode: 'ratio', ratio, resolution }).params)
            .toMatchObject({ ratio, size: ratio, resolution });
        }
      }
    });
  }

  it.each(['nano-banana-pro', 'nano-banana-2', 'nano-banana-pro-4k', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image-preview'])('keeps Tuzi %s at all ten verified ratios', model => {
    const caps = imageControlCaps(model, 'custom', 'https://api.tu-zi.com');
    expect(caps.ratios).toEqual(catalog.common_ratios);
    expect(caps.showCustomSize).toBe(false);
    expect(caps.showResolution).toBe(false);
    for (const ratio of caps.ratios) expect(prepareImageSizeSubmission(model, 'custom', 'https://api.tu-zi.com', { size_mode: 'ratio', ratio }).params)
      .toMatchObject({ size: ratio, ratio });
  });

  it('does not infer Tuzi extensions for HK or unknown OpenRouter models', () => {
    expect(imageControlCaps('nano-banana-2', 'custom', 'https://api.openai-hk.com').ratios).toEqual(catalog.hk_nano_ratios);
    const unknown = imageControlCaps('unknown/new-model', 'openrouter', 'https://openrouter.ai');
    expect(unknown.ratios).toEqual(catalog.legacy_ratios);
    expect(unknown.resolutions).toEqual([]);
    expect(unknown.showAutoSize).toBe(false);
  });

  it.each(['seedream-5.0-lite', 'seedream-5.0-pro', 'doubao-seedream-4-5-251128'])('maps added portrait/landscape presets to non-square legal pixels for %s', model => {
    for (const ratio of ['4:5', '5:4']) {
      for (const resolution of imageControlCaps(model).resolutions) {
        const size = computeStudioPixelSize(ratio, resolution, model);
        expect(size.w / size.h).toBeCloseTo(ratio === '4:5' ? 0.8 : 1.25, 2);
        expect(normalizeStudioPixelSizeForModel(size, model)).toEqual(size);
      }
    }
  });
});
