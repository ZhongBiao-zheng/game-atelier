import { describe, expect, it } from 'vitest';
import type { KeyView, KeyModel } from '@/api/keys';
import type { ModelRouteMember } from '@/api/models';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { routeChannel } from '@/lib/modelRoutes';
import { editModelChoices, isEditModel } from './imageEditGeometry';
import { supportsLayerDecomposition } from './canvasLayerDecomposition';

const member = (provider: string, model: string, protocol: string | null = null): ModelRouteMember => ({
  alias: provider, provider, model_id: model, name: model, protocol,
  base_url: provider === 'evolink' ? 'https://api.evolink.ai/v1' : null,
});
const hub = (model: KeyModel): KeyView => ({ alias: 'Hub', provider: 'atelier', base_url: 'http://localhost:5180',
  access_key: '***', secret_key: null, capabilities: [], models: [model], notes: '', created_at: '' });

describe('gateway capabilities', () => {
  it('opens edit only when every remote member supports it', () => {
    const model: KeyModel = { id: 'gpt-image-2.5', name: 'GPT', modality: 'image',
      via: [member('openai', 'gpt-image-2.5'), member('custom', 'gpt-image-2.5')] };
    expect(isEditModel(model, hub(model))).toBe(true);
    model.via!.push(member('unknown', 'gpt-image-2.5'));
    expect(isEditModel(model, hub(model))).toBe(false);
    model.via = [];
    expect(isEditModel(model, hub(model))).toBe(false);
  });
  it('keeps MJ editor behavior and edit pricing through the gateway', () => {
    const model: KeyModel = { id: 'mj-v8.2', name: 'MJ', modality: 'image',
      via: [member('evolink', 'mj-v8.2', 'evolink')] };
    const key = hub(model);
    expect(editModelChoices([key])[0].mj).toBe(true);
    expect(estimateGenerationCostForSubmission(key, model.id, 'image',
      { n: 4, image_edit: { mode: 'inpaint' } })).toBe(0.84);
  });
  it('takes the intersection for layer decomposition', () => {
    const model: KeyModel = { id: 'seedream-5.0-pro', name: 'Seedream', modality: 'image',
      via: [member('seedream', 'seedream-5.0-pro', 'ark')] };
    expect(supportsLayerDecomposition(hub(model), model)).toBe(true);
    model.via!.push(member('custom', 'seedream-5.0-pro', 'openai'));
    expect(supportsLayerDecomposition(hub(model), model)).toBe(false);
  });
  it('resolves video protocol and pricing from the first upstream member', () => {
    const first = member('seedance', 'doubao-seedance-2-0-fast-260128', 'seedance');
    const model: KeyModel = { id: `seedance:${first.model_id}`, name: 'Video', modality: 'video',
      protocol: 'seedance', via: [first, member('custom', first.model_id, 'seedance')] };
    const key = hub(model);
    const real = routeChannel(key, model);
    expect(real.model.protocol).toBe('seedance');
    const params = { duration: 5, resolution: '720p', ratio: '16:9', generate_audio: true };
    const expected = estimateGenerationCostForSubmission({ ...real.key, models: [real.model] },
      real.model.id, 'video', params);
    expect(expected).not.toBeNull();
    expect(estimateGenerationCostForSubmission(key, model.id, 'video', params)).toBe(expected);
  });
});
