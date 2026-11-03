import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { masonryColumns } from './AssetMasonry';
import { MediaAssetGrid } from './CreationAssetCards';
import type { CreationAsset } from '@/schema/creationAssets';

describe('asset masonry', () => {
  it('places landscape images beside a portrait until that column becomes taller', () => {
    const items = [{ id: 'portrait', ratio: 0.5 }, { id: 'wide', ratio: 2 }, { id: 'square', ratio: 1 }, { id: 'last', ratio: 1 }];
    expect(masonryColumns(items, item => item.ratio).map(column => column.map(item => item.id)))
      .toEqual([['portrait'], ['wide', 'square', 'last']]);
  });

  it('uses loaded dimensions for legacy images and keeps the original ratio', () => {
    const asset: CreationAsset = { asset_id: 'legacy', kind: 'media', title: '旧竖图', tags: [],
      category: null, project_ids: [], created_at: '', updated_at: '', last_used_at: null,
      content: { kind: 'media', path: 'creation-assets/blobs/legacy.png', filename: 'legacy.png',
        mime_type: 'image/png', bytes: 1, sha256: 'a'.repeat(64) } };
    render(<MediaAssetGrid assets={[asset]} staleness={{}} onOpen={() => {}} />);
    const image = screen.getByRole('img', { name: '旧竖图' });
    Object.defineProperties(image, { naturalWidth: { value: 240 }, naturalHeight: { value: 720 } });
    fireEvent.load(image);
    expect(image).toHaveStyle({ aspectRatio: '240 / 720' });
    expect(screen.getByText('240×720')).toBeInTheDocument();
  });
});
