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
