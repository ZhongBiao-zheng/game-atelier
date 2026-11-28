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

});
