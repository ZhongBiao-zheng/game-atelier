import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { Filmstrip } from './Filmstrip';
import type { Job } from '../schema/jobs';

afterEach(() => {
  vi.unstubAllGlobals();
});

const promoJob: Job = {
  job_id: 'job-promo-1',
  character_id: 'cao-cao',
  prompt: '美宣',
  submitted_at: '2026-06-12T00:00:00Z',
  model: 'gpt-image-2',
  params: { n: 2 },
  seed: null,
  output_paths: ['/root/characters/cao-cao/promo/v1.png', '/root/characters/cao-cao/promo/v2.png'],
  status: 'done',
  error: null,
  asset_slot: 'promo',
  kind: 'image',
  namespace: 'character',
};

describe('Filmstrip', () => {
  it('lists the current slot images and switches on click', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [promoJob] })));
    const onSelect = vi.fn();

    render(
      <Filmstrip
        characterId="cao-cao"
        assetSlot="promo"
        currentPath="/root/characters/cao-cao/promo/v1.png"
        onSelect={onSelect}
        sseSignal={0}
      />,
    );

    expect(await screen.findByText('美宣 · 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '当前图片' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: '切换到这张图' })[0]);
    expect(onSelect).toHaveBeenCalledWith('/root/characters/cao-cao/promo/v2.png', 'job-promo-1');
  });
});
