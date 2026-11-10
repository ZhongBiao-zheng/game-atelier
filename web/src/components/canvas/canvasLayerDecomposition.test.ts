import { describe, expect, it } from 'vitest';

import { supportsLayerDecomposition } from './canvasLayerDecomposition';

describe('supportsLayerDecomposition', () => {
  const volcano = { provider: 'seedream', base_url: null };

  it.each([
    ['doubao-seedream-5-0-pro-260628', true],
    ['doubao-seedream-5-0-flash-260915', true],
    ['doubao-seedream-5-0-lite-260128', false],
  ])('%s → %s', (id, expected) => {
    expect(supportsLayerDecomposition(volcano, { id, protocol: null, via: undefined })).toBe(expected);
  });
});
