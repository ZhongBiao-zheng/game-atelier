import { describe, expect, it } from 'vitest';
import cases from '../../../tests/fixtures/generation_cost_cases.json';
import { estimateGenerationCost, type GenerationCostRequest } from './generationCost';

describe('shared Python / TypeScript generation estimates', () => {
  it.each(cases)('prices $request.model_id ($request.kind): $expected', ({ request, expected }) => {
    const r = request as Record<string, unknown>;
    const mapped = {
      provider: { provider: r.provider, baseUrl: r.base_url, billingGroup: r.billing_group },
      model: { id: r.model_id, protocol: r.protocol },
      kind: r.kind, count: r.n, size: r.size, sizeMode: r.size_mode, quality: r.quality,
      duration: r.duration, resolution: r.resolution, ratio: r.ratio,
      generateAudio: r.generate_audio, hasReferenceVideo: r.has_reference_video,
      imageEdit: r.image_edit,
    } as GenerationCostRequest;
    expect(estimateGenerationCost(mapped)).toBe(expected);
  });
});
