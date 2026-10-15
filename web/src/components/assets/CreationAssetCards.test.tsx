import { describe, expect, it } from 'vitest';

import type { CreationMediaAssetContent } from '@/schema/creationAssets';
import { assetMediaSrc } from './CreationAssetCards';

const image: CreationMediaAssetContent = {
  kind: 'media',
  path: 'creation-assets/blobs/dog.png',
  mime_type: 'image/png',
  bytes: 3,
  sha256: 'c'.repeat(64),
  filename: 'dog.png',
};

describe('assetMediaSrc', () => {
  it('keeps the plain versioned path on the local page', () => {
    expect(assetMediaSrc('asset 1', image)).toBe('/api/creation-assets/asset%201/content?v=cccccccccccc');
  });

});
