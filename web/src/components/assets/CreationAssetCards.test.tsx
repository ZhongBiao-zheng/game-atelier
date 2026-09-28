import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CreationMediaAssetContent } from '@/schema/creationAssets';
import { assetMediaSrc, MediaPreview } from './CreationAssetCards';

const mediaUrlMock = vi.hoisted(() => vi.fn((input: string) => input));
vi.mock('@/api/connection', async importOriginal => {
  const actual = await importOriginal<typeof import('@/api/connection')>();
  return { ...actual, mediaUrl: (input: string) => mediaUrlMock(input) };
});
afterEach(() => {
  mediaUrlMock.mockReset();
  mediaUrlMock.mockImplementation((input: string) => input);
});

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

  it('carries the media token and the content version on the hosted site', () => {
    mediaUrlMock.mockImplementation((input: string) =>
      `http://127.0.0.1:5174${input}${input.includes('?') ? '&' : '?'}media_token=tok`);
    render(<MediaPreview assetId="asset-1" content={image} alt="预览" className="" />);
    const src = new URL(screen.getByAltText('预览').getAttribute('src')!);
    expect(src.origin).toBe('http://127.0.0.1:5174');
    expect(src.pathname).toBe('/api/creation-assets/asset-1/content');
    expect(src.searchParams.get('v')).toBe('cccccccccccc');
    expect(src.searchParams.get('media_token')).toBe('tok');
  });
});
