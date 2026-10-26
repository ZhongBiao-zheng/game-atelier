import { modelCatalog, sortModels } from '@/lib/modelCatalog';
import { describe, expect, it } from 'vitest';

import type { KeyView } from '@/api/keys';
import { convergeModelSelection, modelsForKind } from './studioModelSelection';

function key(alias: string, models: KeyView['models'], modalities?: KeyView['modalities']): KeyView {
  return {
    alias, provider: alias, base_url: null, access_key: '***', secret_key: null, capabilities: [],
    models, notes: '', created_at: '2026-09-01T00:00:00Z', ...(modalities ? { modalities } : {}),
  };
}

const imageKey = key('img', [{ id: 'seedream', name: 'Seedream' }, { id: 'seedream-lite', name: 'Lite' }]);
const videoKey = key('vid', [{ id: 'seedance', name: 'Seedance' }], ['video']);
const mixedKey = key('mixed', [
  { id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' },
  { id: 'sora-2', name: 'Sora 2', modality: 'video' },
]);
const keys = [imageKey, videoKey, mixedKey];

describe('modelsForKind', () => {
  it('模型级 modality 优先，key 级兜底', () => {
    expect(modelsForKind(mixedKey, 'video').map((m) => m.id)).toEqual(['sora-2']);
    expect(modelsForKind(videoKey, 'video').map((m) => m.id)).toEqual(['seedance']);
    expect(modelsForKind(videoKey, 'image')).toEqual([]);
    expect(modelsForKind(undefined, 'image')).toEqual([]);
  });
});

describe('convergeModelSelection', () => {
  it('已落在本类模型上时不改', () => {
    expect(convergeModelSelection(keys, 'image', 'img', 'seedream-lite')).toBeNull();
    expect(convergeModelSelection([], 'image', '', '')).toBeNull();
  });

  it('当前 key 没有本类模型：换到第一个有本类模型的 key，另一类模型换成本类第一个', () => {
    expect(convergeModelSelection(keys, 'video', 'img', 'seedream')).toEqual({ alias: 'vid', model: 'seedance' });
    expect(convergeModelSelection(keys, 'image', 'vid', 'seedance')).toEqual({ alias: 'img', model: 'seedream' });
  });

  it('当前 key 有本类模型但 model 属另一类：留在该 key，换成本类第一个', () => {
    expect(convergeModelSelection(keys, 'video', 'mixed', 'gpt-image-2')).toEqual({ alias: 'mixed', model: 'sora-2' });
  });

  it('当前 key 没有本类模型时优先含当前模型的 key', () => {
    expect(convergeModelSelection(keys, 'video', 'img', 'sora-2')).toEqual({ alias: 'mixed', model: 'sora-2' });
  });

  it('model 为空（复刻缺模型）只收敛 alias', () => {
    expect(convergeModelSelection(keys, 'video', 'img', '')).toEqual({ alias: 'vid', model: '' });
    expect(convergeModelSelection(keys, 'image', 'img', '')).toBeNull();
  });

  it('本机不存在的 model id 原样保留', () => {
    expect(convergeModelSelection(keys, 'image', 'img', 'seedream-9')).toBeNull();
    expect(convergeModelSelection(keys, 'video', 'img', 'seedream-9')).toEqual({ alias: 'vid', model: 'seedream-9' });
  });
});


describe('model catalog', () => {
  it.each([
    ['openai/gpt-image-2.5-sunburst', 'gpt-image-2.5-sunburst', 'openai'],
    ['gpt-image-2.5-flare-vip', 'gpt-image-2.5-flare', 'openai'],
    ['gpt-image-2.5', 'gpt-image-2.5', 'openai'],
    ['openai/gpt_image_2', 'gpt-image-2', 'openai'],
    ['google/gemini-nano-banana-2.1', 'nano-banana-2.1', 'gemini'],
    ['nano-banana', 'nano-banana-pro', 'gemini'],
    ['nano-banana-hd', 'nano-banana-pro', 'gemini'],
    ['nano-banana-pro-2k', 'nano-banana-pro', 'gemini'],
    ['nano-banana-pro-4k-vip', 'nano-banana-pro', 'gemini'],
    ['google/gemini-3-pro-image', 'nano-banana-pro', 'gemini'],
    ['google/gemini-3.1-flash-image', 'nano-banana-2', 'gemini'],
    ['nano-banana-2-4k', 'nano-banana-2', 'gemini'],
    ['doubao-seedream-5-0-pro-260628', 'seedream-5.0-pro', 'bytedance'],
    ['doubao-seedream-5-0-lite-260128', 'seedream-5.0-lite', 'bytedance'],
    ['doubao-seedream-5-0-260128', 'seedream-5.0-lite', 'bytedance'],
    ['doubao-seedream-4-5-251128', 'seedream-4.5', 'bytedance'],
    ['mj_imagine', 'midjourney', 'midjourney'], ['mj-v8.2', 'midjourney', 'midjourney'],
    ['black-forest-labs/flux.2-pro', 'flux-2-pro', 'flux'],
    ['black-forest-labs/flux-3-image', 'flux-3-image', 'flux'],
    ['seedance-2.5', 'seedance-2.5', 'bytedance'],
    ['seedance:seedance-2.0:save', 'seedance-2.0', 'bytedance'],
    ['seedance-2.0-fast:save', 'seedance-2.0-fast', 'bytedance'],
    ['seedance-2.0-mini', 'seedance-2.0-mini', 'bytedance'],
    ['google/veo-3.1', 'veo-3.1', 'gemini'],
    ['openai/sora-2-pro', 'sora-2-pro', 'openai'],
    ['kwaivgi/kling-v3.0-std', 'kling-3.0', 'kling'],
    ['minimax-h3', 'minimax-h3', 'minimax'],
    ['happyhorse-1.1-r2v', 'happyhorse-1.1', 'alibaba'],
    ['happyhorse-1.1-i2v', 'happyhorse-1.1', 'alibaba'],
    ['happyhorse-1.1-t2v', 'happyhorse-1.1', 'alibaba'],
    ['happyhorse-1.0-video-edit', 'happyhorse-1.0', 'alibaba'],
  ])('%s maps to %s', (id, key, brand) => {
    expect(modelCatalog(id)).toMatchObject({ key, brand });
  });
  it('orders popularity, then variants, and preserves unknown order without mutating input', () => {
    const ids = ['unknown-z', 'nano-banana-pro-4k', 'nano-banana-pro-2k', 'nano-banana-pro', 'gpt-image-2', 'unknown-a'];
    const models = ids.map(id => ({ id }));
    expect(sortModels(models).map(model => model.id)).toEqual([
      'gpt-image-2', 'nano-banana-pro', 'nano-banana-pro-2k', 'nano-banana-pro-4k', 'unknown-z', 'unknown-a',
    ]);
    expect(models.map(model => model.id)).toEqual(ids);
    expect(modelCatalog('unknown-z')).toBeUndefined();
  });
});
