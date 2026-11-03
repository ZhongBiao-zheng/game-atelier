import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { CreationMediaAssetContent } from '@/schema/creationAssets';
import { AssetCard, assetMediaSrc } from './CreationAssetCards';

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

it('renders portrait media at its own ratio without a fixed crop', () => {
  render(<AssetCard asset={{ asset_id: 'portrait', kind: 'media', title: '竖图', tags: [],
    created_at: '', updated_at: '', last_used_at: null, category: null, project_ids: [],
    content: { ...image, width: 300, height: 600 } }} onOpen={() => {}} />);
  expect(screen.getByRole('img', { name: '竖图' })).toHaveStyle({ aspectRatio: '300 / 600' });
  expect(screen.getByText('300×600')).toBeInTheDocument();
});
