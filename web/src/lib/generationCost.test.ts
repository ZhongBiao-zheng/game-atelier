import { describe, expect, it } from 'vitest';

import { estimateGenerationCost, formatGenerationCost } from './generationCost';

describe('estimateGenerationCost', () => {
  it('calculates fixed OpenAI-HK GPT Image 2 pricing regardless of quality', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'custom', baseUrl: 'https://api.openai-hk.com' },
      model: { id: 'gpt-image-2' },
      kind: 'image',
      count: 3,
      quality: 'low',
    });

    expect(result).toBe(0.24);
    expect(formatGenerationCost(result!)).toBe('¥ 0.24');
  });

  it.each([
    ['low', 0.48],
    ['medium', 0.72],
    ['high', 1],
  ] as const)('maps OpenAI-HK Nano Banana 2 %s to the verified tier', (quality, price) => {
    expect(estimateGenerationCost({
      provider: { provider: 'custom', baseUrl: 'https://api.openai-hk.com' },
      model: { id: 'nano-banana-2' }, kind: 'image', count: 1, quality,
    })).toBe(price);
  });

  it('prices Tuzi default Gemini 3 Pro at a flat ¥0.3 across quality tiers', () => {
    const provider = {
      provider: 'custom', baseUrl: 'https://api.tu-zi.com', billingGroup: 'default',
    };
    for (const quality of ['low', 'medium', 'high'] as const) {
      expect(estimateGenerationCost({
        provider, model: { id: 'nano-banana-pro' }, kind: 'image', count: 1, quality,
      })).toBe(0.3);
    }
    for (const model of [
      'gemini-3-pro-image-preview',
      'nano-banana-pro-2k',
      'nano-banana-pro-4k',
    ]) {
      expect(estimateGenerationCost({
        provider, model: { id: model }, kind: 'image', count: 2,
      })).toBe(0.6);
    }
    expect(estimateGenerationCost({
      provider: {
        provider: 'custom', baseUrl: 'https://api.tu-zi.com', billingGroup: '绘画',
      },
      model: { id: 'gpt-image-2' }, kind: 'image', count: 2,
    })).toBe(0.42);
  });

  it('does not guess Tuzi pricing without a verified billing group', () => {
    expect(estimateGenerationCost({
      provider: { provider: 'custom', baseUrl: 'https://api.tu-zi.com' },
      model: { id: 'gpt-image-2' }, kind: 'image', count: 1,
    })).toBeNull();
  });

  it('charges one Tuzi Midjourney task even though it yields four images', () => {
    expect(estimateGenerationCost({
      provider: {
        provider: 'custom', baseUrl: 'https://api.tu-zi.com', billingGroup: 'default',
      },
      model: { id: 'mj_imagine' }, kind: 'image', count: 4,
    })).toBe(0.1505);
  });

  it('prices verified TokenDance Seedream image models', () => {
    expect(estimateGenerationCost({
      provider: { provider: 'tokendance', baseUrl: 'https://tokendance.space/gateway/v1' },
      model: { id: 'seedream-5.0-lite', protocol: 'openai' }, kind: 'image', count: 2,
    })).toBe(0.44);
    expect(estimateGenerationCost({
      provider: { provider: 'tokendance', baseUrl: 'https://tokendance.space/gateway/v1' },
      model: { id: 'seedream-5.0-pro', protocol: 'ark' }, kind: 'image', count: 2,
    })).toBe(0.6);
  });

  it('calculates Ark Seedream per-image pricing', () => {
    const result = estimateGenerationCost({
      provider: {
        provider: 'seedream',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
      },
      model: { id: 'doubao-seedream-5-0-260128', protocol: 'ark' },
      kind: 'image',
      count: 2,
    });

    expect(result).toBe(0.44);
  });

  it('does not reuse Ark pricing for an unknown model through TokenDance', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'tokendance', baseUrl: 'https://tokendance.space/gateway/v1' },
      model: { id: 'seedream-unknown', protocol: 'ark' },
      kind: 'image',
      count: 1,
    });

    expect(result).toBeNull();
  });

  it('estimates Ark Seedance output-token pricing from resolution and duration', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'volcengine_video', baseUrl: null },
      model: { id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' },
      kind: 'video',
      count: 2,
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
      generateAudio: true,
      hasReferenceVideo: false,
    });

    expect(result).toBe(7.992);
    expect(formatGenerationCost(result!)).toBe('¥ 7.99');
  });

  it('费用展示最多保留两位小数，不补无意义的零', () => {
    expect(formatGenerationCost(10.1)).toBe('¥ 10.1');
    expect(formatGenerationCost(10.119)).toBe('¥ 10.12');
  });

  it('refuses a misleading Seedance estimate when reference-video duration is unknown', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'seedance', baseUrl: null },
      model: { id: 'seedance-2.0', protocol: 'seedance' },
      kind: 'video',
      count: 1,
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
      hasReferenceVideo: true,
    });

    expect(result).toBeNull();
  });

  it('requires a known Seedance ratio before estimating output tokens', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'seedance', baseUrl: null },
      model: { id: 'seedance-2.0', protocol: 'seedance' },
      kind: 'video',
      duration: 5,
      resolution: '720p',
    });

    expect(result).toBeNull();
  });

  it('uses the official Seedance pixel mapping for the selected ratio', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'seedance', baseUrl: null },
      model: { id: 'doubao-seedance-2-0-fast-260128', protocol: 'seedance' },
      kind: 'video',
      duration: 5,
      resolution: '720p',
      ratio: '4:3',
    });

    expect(result).toBe(4.021183);
  });

  it('does not price a direct channel when the model protocol conflicts', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'seedance', baseUrl: null },
      model: { id: 'seedance-2.0', protocol: 'dashscope' },
      kind: 'video',
      duration: 5,
      resolution: '720p',
      ratio: '16:9',
    });

    expect(result).toBeNull();
  });

  it('calculates direct DashScope HappyHorse per-second pricing', () => {
    const result = estimateGenerationCost({
      provider: {
        provider: 'custom',
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      },
      model: { id: 'happyhorse-1.1-t2v', protocol: 'dashscope' },
      kind: 'video',
      count: 1,
      duration: 6,
      resolution: '1080P',
    });

    expect(result).toBe(7.2);
  });

  it('returns null for an unpriced provider', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'custom', baseUrl: 'https://api.example.com' },
      model: { id: 'gpt-image-2' },
      kind: 'image',
      count: 1,
      quality: 'low',
    });

    expect(result).toBeNull();
  });

  it('does not trust a pricing-domain name embedded in another URL', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'custom', baseUrl: 'https://proxy.example/openai-hk' },
      model: { id: 'gpt-image-2' },
      kind: 'image',
      count: 1,
      quality: 'low',
    });

    expect(result).toBeNull();
  });

  it('does not extend a verified Seedream price to an unknown model suffix', () => {
    const result = estimateGenerationCost({
      provider: { provider: 'seedream', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
      model: { id: 'doubao-seedream-5-0-260128-pro', protocol: 'ark' },
      kind: 'image',
      count: 1,
    });

    expect(result).toBeNull();
  });
});
