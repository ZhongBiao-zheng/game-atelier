import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CharacterGallery } from './CharacterGallery';
import type { Job } from '../schema/jobs';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CharacterGallery', () => {
  it('does not show pending_confirm jobs as terminal confirmation cards', async () => {
    const pendingConfirmJob: Job = {
      job_id: 'job-waiting-confirm',
      character_id: 'cao-cao',
      prompt: '等待确认的青袍谋主',
      submitted_at: '2026-05-28T02:00:00Z',
      model: 'gpt-image-2',
      params: { n: 1, size: '1024x1024' },
      seed: null,
      output_paths: [],
      status: 'pending_confirm',
      error: null,
      asset_slot: 'portrait',
      kind: 'image',
      namespace: 'character',
    };

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [pendingConfirmJob],
    })));

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        detailMode={false}
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    expect(await screen.findByText('等待第一张作品')).toBeInTheDocument();
    expect(screen.queryByText(/等终端确认/)).not.toBeInTheDocument();
    expect(screen.queryByText('等待确认的青袍谋主')).not.toBeInTheDocument();
  });
});
