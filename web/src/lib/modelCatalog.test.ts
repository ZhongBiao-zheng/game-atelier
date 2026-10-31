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
    'gpt-image-2.5-sunburst', 'nano-banana-pro', 'doubao-seedream-5-0-pro',
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
