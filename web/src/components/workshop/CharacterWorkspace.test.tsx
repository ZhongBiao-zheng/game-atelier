import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CharacterWorkspace } from './CharacterWorkspace';

afterEach(() => vi.unstubAllGlobals());

describe('CharacterWorkspace', () => {
  it('shows own asset map and related project works', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        character: { id: 'zhaoyun', name: '赵云', status: 'idle', latest_job_id: null, derivative: null },
        assets: [
          { slot: 'portrait', count: 1, canonical: null, media: [{
            path: 'characters/zhaoyun/portrait/v1.png', media_type: 'image', produced_at: '2026-08-22T00:00:00Z',
            title: '赵云', detail: '立绘', job_id: 'j1', target: { kind: 'art', character_id: 'zhaoyun', asset_slot: 'portrait' },
          }] },
          { slot: 'promo', count: 0, canonical: null, media: [] },
          { slot: 'turnaround', count: 0, canonical: null, media: [] },
        ],
        related: [
          {
            target: { kind: 'ui', scheme_id: 'v1', screen_id: 'home' }, title: '首页', detail: 'V1 · UI 页面',
            source: 'auto', featured_path: 'projects/shu/ui/v1/screens/home/v1.png', count: 1, media: [],
          },
          {
            target: { kind: 'video', production_id: 'trailer' }, title: '角色预告', detail: '视频企划',
            source: 'manual', featured_path: null, count: 0, media: [],
          },
        ],
        recent_media: [{
          path: 'characters/zhaoyun/portrait/v1.png', media_type: 'image', produced_at: '2026-08-22T00:00:00Z',
          title: '赵云', detail: '立绘', job_id: 'j1', target: { kind: 'art', character_id: 'zhaoyun', asset_slot: 'portrait' },
        }],
      }),
    })));

    render(<CharacterWorkspace projectId="p1" characterId="zhaoyun" />);

    expect(await screen.findByRole('heading', { name: '赵云' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /立绘/ })).toHaveAttribute(
      'href', '/workshop/p1/art/characters/zhaoyun/portrait',
    );
    expect(screen.getByRole('link', { name: /首页/ })).toHaveAttribute(
      'href', '/workshop/p1/ui/v1/screens/home',
    );
    expect(screen.getByRole('link', { name: /角色预告/ })).toHaveAttribute(
      'href', '/workshop/p1/video/trailer',
    );
  });
});
