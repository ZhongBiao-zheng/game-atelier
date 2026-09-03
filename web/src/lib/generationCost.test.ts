import { describe, expect, it } from 'vitest';

import {
  estimateGenerationCost,
  estimateGenerationCostForSubmission,
  formatGenerationCost,
} from './generationCost';

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

  it.each([
    ['low', 0.12], ['medium', 0.15], ['high', 0.18],
    ['auto', 0.12], [undefined, 0.12],
  ] as const)('prices Tuzi Gemini 3 Pro %s at the announced tier', (quality, price) => {
    const provider = {
      provider: 'custom', baseUrl: 'https://api.tu-zi.com', billingGroup: 'default',
    };
    for (const model of [
      'gemini-3-pro-image',
      'gemini-3-pro-image-preview',
      'nano-banana-pro',
    ]) {
      expect(estimateGenerationCost({
        provider, model: { id: model }, kind: 'image', count: 2, quality,
      })).toBe(price * 2);
    }
  });

  it.each([
    ['nano-banana-pro-2k', 0.3], ['nano-banana-pro-4k', 0.36],
  ])('uses the fixed resolution encoded in %s', (model, price) => {
    for (const quality of ['low', 'medium', 'high', 'auto', undefined] as const) {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com/v1', billingGroup: 'default' },
        model: { id: model }, kind: 'image', count: 2, quality,
      })).toBe(price);
    }
  });

  it('keeps other Tuzi models and billing groups at their existing rates', () => {
    for (const [model, price] of [
      ['seedream-4-5', 0.12], ['seedream-5-0-pro', 0.6],
      ['nano-banana-2', 0.3], ['nano-banana-2-2k', 0.48], ['nano-banana-2-4k', 0.82],
    ] as const) {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com', billingGroup: 'default' },
        model: { id: model }, kind: 'image', count: 1, quality: 'high',
      })).toBe(price);
    }
    expect(estimateGenerationCost({
      provider: {
        provider: 'custom', baseUrl: 'https://api.tu-zi.com', billingGroup: '绘画',
      },
      model: { id: 'gpt-image-2' }, kind: 'image', count: 2,
    })).toBe(0.42);
  });

  it.each([
    ['1024x1024', 'low', 1, 0.028],
    ['768x1024', 'high', 2, 0.056],
    ['1025x1024', 'low', 1, 0.21],
    ['2048x1152', 'auto', 1, 0.21],
    ['2049x1024', 'low', 1, 0.21],
    ['3840x2160', 'high', 2, 0.42],
  ] as const)(
    'prices Tuzi default GPT Image 2 size %s independently of quality',
    (size, quality, count, price) => {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com/v1', billingGroup: 'default' },
        model: { id: 'gpt-image-2' }, kind: 'image', size, quality, count,
      })).toBe(price);
    },
  );

  it.each([undefined, '', '1024', '1024:1024', '0x1024', '1024x-1', 'foo'])(
    'does not guess Tuzi default GPT Image 2 pricing for size %s',
    (size) => {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com', billingGroup: 'default' },
        model: { id: 'gpt-image-2' }, kind: 'image', size,
      })).toBeNull();
    },
  );

  it('passes the frozen submission size into Tuzi GPT Image 2 pricing', () => {
    const params = { size: '2048x2048', quality: 'low', n: 2, estimated_cost_cny: 0.07 };
    expect(estimateGenerationCostForSubmission({
      alias: 'tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com',
      billing_group: 'default', access_key: 'masked', secret_key: null,
      capabilities: ['portrait'], notes: '', created_at: '2026-09-01T00:00:00Z',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }],
    }, 'gpt-image-2', 'image', params)).toBe(0.42);
    expect(params).toEqual({
      size: '2048x2048', quality: 'low', n: 2, estimated_cost_cny: 0.07,
    });
  });

  it('does not reuse Tuzi default size pricing for another group or channel', () => {
    expect(estimateGenerationCost({
      provider: { baseUrl: 'https://api.tu-zi.com', billingGroup: '绘画' },
      model: { id: 'gpt-image-2' }, kind: 'image', size: '1024x1024', count: 2,
    })).toBe(0.42);
    expect(estimateGenerationCost({
      provider: { baseUrl: 'https://api.openai-hk.com', billingGroup: 'default' },
      model: { id: 'gpt-image-2' }, kind: 'image', size: '3840x2160', count: 2,
    })).toBe(0.16);
    for (const model of ['gpt-image-2-preview', 'GPT_IMAGE_2', 'gpt.image.2']) {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com', billingGroup: 'default' },
        model: { id: model }, kind: 'image', size: '1024x1024',
      })).toBeNull();
    }
  });

  it('does not reuse the Pro announcement for other channels, groups or unverified suffixes', () => {
    for (const model of [
      'nano-banana-pro-vip', 'nano-banana-pro-4k-vip', 'nano-banana-pro-hd',
      'gemini-3-pro-image-preview-4k', 'gemini-3-pro-image-new',
    ]) {
      expect(estimateGenerationCost({
        provider: { baseUrl: 'https://api.tu-zi.com', billingGroup: 'default' },
        model: { id: model }, kind: 'image', quality: 'high',
      })).toBeNull();
    }
    for (const provider of [
      { baseUrl: 'https://api.tu-zi.com' },
      { baseUrl: 'https://api.tu-zi.com', billingGroup: '绘画' },
      { baseUrl: 'https://api.tu-zi.com', billingGroup: 'unknown' },
      { baseUrl: 'https://tu-zi.com.example.org', billingGroup: 'default' },
      { baseUrl: 'https://api.openai-hk.com', billingGroup: 'default' },
    ]) {
      expect(estimateGenerationCost({
        provider, model: { id: 'nano-banana-pro' }, kind: 'image', quality: 'high',
      })).toBeNull();
    }
  });

  it('uses the new submission price without mutating a historical cost snapshot', () => {
    const params = { n: 2, quality: 'high', estimated_cost_cny: 0.6 };
    expect(estimateGenerationCostForSubmission({
      alias: 'tuzi', provider: 'custom', base_url: 'https://api.tu-zi.com',
      billing_group: 'default', access_key: 'masked', secret_key: null,
      capabilities: ['portrait'], notes: '', created_at: '2026-08-31T00:00:00Z',
      models: [{ id: 'nano-banana-pro', name: 'Nano Banana Pro', modality: 'image' }],
    }, 'nano-banana-pro', 'image', params)).toBe(0.36);
    expect(params).toEqual({ n: 2, quality: 'high', estimated_cost_cny: 0.6 });
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
