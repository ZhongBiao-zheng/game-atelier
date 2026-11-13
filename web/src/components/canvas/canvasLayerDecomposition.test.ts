import { describe, expect, it } from 'vitest';

import { layerDecompositionMaxOutputs, supportsLayerDecomposition, supportsLayerMaxImages } from './canvasLayerDecomposition';

describe('supportsLayerDecomposition', () => {
  const volcano = { provider: 'seedream', base_url: null };

  it.each([
    ['doubao-seedream-5-0-pro-260628', true],
    ['doubao-seedream-5-0-flash-260915', true],
    ['doubao-seedream-5-5-261028', true],
    ['doubao-seedream-5-0-lite-260128', false],
  ])('%s → %s', (id, expected) => {
    expect(supportsLayerDecomposition(volcano, { id, protocol: null, via: undefined })).toBe(expected);
  });
});

describe('supportsLayerMaxImages', () => {
  it('只给 Seedream 5.5 开「最多图层」，5.0 拆分上限仍是 17 张', () => {
    expect(supportsLayerMaxImages('doubao-seedream-5-5-261028')).toBe(true);
    expect(supportsLayerMaxImages('seedream-5.5')).toBe(true);
    expect(supportsLayerMaxImages('doubao-seedream-5-0-pro-260628')).toBe(false);
    expect(layerDecompositionMaxOutputs('seedream-5.5')).toBe(100);
    expect(layerDecompositionMaxOutputs('seedream-5.0-pro')).toBe(17);
  });
});
