import { describe, expect, it } from 'vitest';

import { modelBrand, modelCatalog, modelDisplayName, sortModels } from './modelCatalog';

describe('modelBrand', () => {
  it.each([
    ['seed-2.0-lite', 'bytedance'],
    ['doubao-seed-2-0-lite-260428', 'bytedance'],
    ['claude-sonnet-5-5', 'anthropic'],
    ['gpt-5', 'openai'],
    ['o1', 'openai'],
    ['o3-mini', 'openai'],
    ['o4-mini', 'openai'],
    ['chatgpt-latest', 'openai'],
    ['gemini-3-pro', 'gemini'],
    ['deepseek-v3', 'deepseek'],
    ['qwen3', 'alibaba'],
    ['qwq-32b', 'alibaba'],
    ['kimi-k2', 'moonshot'],
    ['moonshot-v1', 'moonshot'],
    ['glm-4.5', 'zhipu'],
    ['chatglm-6b', 'zhipu'],
    ['vendor/CLAUDE_SONNET_5_5', 'anthropic'],
    ['unknown-model', undefined],
  ])('infers %s as %s', (id, brand) => {
    expect(modelBrand(id)).toBe(brand);
  });

  it.each([
    'gpt-image-2.6-sunburst', 'gpt-image-2.6-flare', 'gpt-image-2.6-1k',
    'gpt-image-2.5-sunburst', 'nano-banana-pro', 'doubao-seedream-5-0-pro', 'doubao-seedream-5-5-261028', 'seedream-5.5',
    'midjourney', 'flux-3-image', 'seedance-2.0-fast', 'veo-3.1',
    'sora-2-pro', 'kling-3.0', 'minimax-h3', 'happyhorse-1.1',
  ])('preserves the catalog brand for %s', id => {
    expect(modelCatalog(id)).toBeDefined();
    expect(modelBrand(id)).toBe(modelCatalog(id)?.brand);
  });

  it('keeps inferred text models out of catalog naming and ranking', () => {
    const models = [{ id: 'claude-sonnet-5-5' }, { id: 'seed-2.0-lite' }];
    expect(models.map(model => modelCatalog(model.id))).toEqual([undefined, undefined]);
    expect(models.map(modelDisplayName)).toEqual(models.map(model => model.id));
    expect(sortModels(models)).toEqual(models);
  });
});

describe('kling catalog ids across channels', () => {
  it.each([
    ['kling-4.0', 'kling-4.0'],
    ['kling-v4-text-to-video', 'kling-4.0'],
    ['kling-4.0-flash', 'kling-4.0-flash'],
    ['kling-v4-flash-text-to-video', 'kling-4.0-flash'],
    ['kling-3.0', 'kling-3.0'],
    ['kwaivgi/kling-v3.0-std', 'kling-3.0'],
    ['kling-v3-text-to-video', 'kling-3.0'],
    ['kling-3.0-omni', 'kling-3.0-omni'],
    ['kling-o3-text-to-video', 'kling-3.0-omni'],
    ['kling-3.0-turbo', 'kling-3.0-turbo'],
    ['kling-v3-turbo-text-to-video', 'kling-3.0-turbo'],
  ])('%s is %s', (id, key) => {
    expect(modelCatalog(id)?.key).toBe(key);
  });
});

describe('modelDisplayName vendor prefix', () => {
  it.each([
    ['ByteDance: Seedance 2.5', 'Seedance 2.5'],
    ['Kling: Video 4.0 Flash', 'Kling Video 4.0 Flash'],
    ['Kling: Kling TTS', 'Kling TTS'],
  ])('%s → %s', (name, shown) => {
    expect(modelDisplayName({ id: 'x', name })).toBe(shown);
  });
});
