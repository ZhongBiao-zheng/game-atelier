import { describe, expect, it } from 'vitest';

import { imageControlCaps } from './imageControlCaps';
import { gptImage26JobParams, normalizeImageSizeParams } from './imageSizeMode';

describe('GPT Image 2.6 params follow the model', () => {
  it('keeps complexity and GIF fields on 2.6 and drops them when switching to 2.5', () => {
    const draft = { size_mode: 'auto' as const, size: 'auto', complexity: 'low' as const,
      output_format: 'gif' as const, frame_count: 12, frame_duration_ms: 80 };
    const kept = normalizeImageSizeParams('gpt-image-2.6-flare', 'openai', null, draft);
    expect(kept).toMatchObject({ complexity: 'low', output_format: 'gif', frame_count: 12, frame_duration_ms: 80 });
    const dropped = normalizeImageSizeParams('gpt-image-2.5-flare', 'openai', null, draft);
    expect(dropped.complexity).toBeUndefined();
    expect(dropped.output_format).toBeUndefined();
    expect(dropped.frame_count).toBeUndefined();
    expect(dropped.frame_duration_ms).toBeUndefined();
  });

  it('keeps the composite choice only on 2.6 and never stores the markup default', () => {
    const composite = { size_mode: 'auto' as const, size: 'auto', annotation_delivery: 'composite' as const };
    expect(normalizeImageSizeParams('gpt-image-2.6-flare', 'openai', null, composite).annotation_delivery).toBe('composite');
    expect(normalizeImageSizeParams('gpt-image-2.5-flare', 'openai', null, composite).annotation_delivery).toBeUndefined();
    const markup = { ...composite, annotation_delivery: 'markup' as const };
    expect(normalizeImageSizeParams('gpt-image-2.6-flare', 'openai', null, markup).annotation_delivery).toBeUndefined();
  });

  it('never submits GIF alongside reference images', () => {
    const caps = imageControlCaps('gpt-image-2.6-sunburst', 'openai');
    const source = { complexity: 'medium' as const, output_format: 'gif' as const, frame_count: 4, frame_duration_ms: 100 };
    expect(gptImage26JobParams(caps, source, false)).toEqual(source);
    expect(gptImage26JobParams(caps, source, true)).toEqual({ complexity: 'medium' });
    expect(gptImage26JobParams(imageControlCaps('gpt-image-2', 'openai'), source, false)).toEqual({});
  });
});
