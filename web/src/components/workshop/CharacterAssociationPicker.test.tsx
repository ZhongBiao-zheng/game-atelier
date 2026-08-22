import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CharacterAssociationPicker } from './CharacterAssociationPicker';

afterEach(() => vi.unstubAllGlobals());

describe('CharacterAssociationPicker', () => {
  it('adds a manual role association without changing ownership', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/projects/p1/characters/index') return { ok: true, json: async () => ({
        items: [{
          character: { id: 'zhaoyun', name: '赵云', status: 'idle', latest_job_id: null, derivative: null },
          cover_paths: [], activity_at: '2026-08-22T00:00:00Z',
        }],
      }) };
      if (path === '/api/projects/p1/character-associations' && init?.method === 'PUT') return {
        ok: true,
        json: async () => ({ items: [{ character_id: 'zhaoyun', target: { kind: 'ui', scheme_id: 'v1', screen_id: 'home' } }] }),
      };
      if (path === '/api/projects/p1/character-associations') return { ok: true, json: async () => ({ items: [] }) };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CharacterAssociationPicker projectId="p1" target={{ kind: 'ui', scheme_id: 'v1', screen_id: 'home' }} />);

    fireEvent.click(screen.getByRole('button', { name: '关联角色' }));
    fireEvent.click(await screen.findByRole('button', { name: '赵云' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '赵云' })).toHaveAttribute('aria-pressed', 'true'));
  });
});
