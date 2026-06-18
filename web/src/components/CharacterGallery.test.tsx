import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    expect(await screen.findByText('等待第一张作品')).toBeInTheDocument();
    expect(screen.queryByText(/等终端确认/)).not.toBeInTheDocument();
    expect(screen.queryByText('等待确认的青袍谋主')).not.toBeInTheDocument();
  });

  it('shows a stale-pending card with a void button instead of an endless spinner', async () => {
    const staleJob: Job = {
      job_id: 'job-stale-1',
      character_id: 'cao-cao',
      prompt: '两小时前卡住的 pending',
      submitted_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      model: 'gpt-image-2',
      params: { n: 2 },
      seed: null,
      output_paths: [],
      status: 'pending',
      error: null,
      asset_slot: 'portrait',
      kind: 'image',
      namespace: 'character',
    };

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/jobs/job-stale-1/cancel' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, job_id: 'job-stale-1', status: 'failed' }) };
      }
      return { ok: true, json: async () => [staleJob] };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    // 不再渲染「生成中…」转圈骨架，渲染可作废的中断卡。
    expect(await screen.findByTestId('stale-pending-job-stale-1')).toBeInTheDocument();
    expect(screen.getByText('可能已中断')).toBeInTheDocument();
    expect(screen.queryByText('生成中…')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('[作废]'));
    // 自定义对话框，点击确认按钮
    await waitFor(() => screen.getByText('确认'));
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/jobs/job-stale-1/cancel', { method: 'POST' });
    });
    // 本地翻面成失败卡，可走既有删除流程。
    expect(await screen.findByText('出图失败')).toBeInTheDocument();
    expect(screen.queryByTestId('stale-pending-job-stale-1')).not.toBeInTheDocument();
  });

  it('keeps the spinner for fresh pending jobs', async () => {
    const freshJob: Job = {
      job_id: 'job-fresh-1',
      character_id: 'cao-cao',
      prompt: '刚提交的 pending',
      submitted_at: new Date().toISOString(),
      model: 'gpt-image-2',
      params: { n: 1 },
      seed: null,
      output_paths: [],
      status: 'pending',
      error: null,
      asset_slot: 'portrait',
      kind: 'image',
      namespace: 'character',
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [freshJob],
    })));

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    expect(await screen.findByText('生成中…')).toBeInTheDocument();
    expect(screen.queryByText('可能已中断')).not.toBeInTheDocument();
  });

  it('toggles homepage-gallery hiding from the card top-left button', async () => {
    const doneJob: Job = {
      job_id: 'job-done-1',
      character_id: 'cao-cao',
      prompt: '完成的立绘',
      submitted_at: '2026-06-10T02:00:00Z',
      model: 'gpt-image-2',
      params: { n: 1 },
      seed: null,
      output_paths: ['/root/characters/cao-cao/portrait/v1.png'],
      status: 'done',
      error: null,
      asset_slot: 'portrait',
      kind: 'image',
      namespace: 'character',
    };

    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === '/api/gallery/hidden' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ paths: ['characters/cao-cao/portrait/v1.png'] }) };
      }
      if (String(url) === '/api/gallery/hidden') {
        return { ok: true, json: async () => ({ paths: [] }) };
      }
      return { ok: true, json: async () => [doneJob] };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    fireEvent.click(await screen.findByLabelText('隐藏'));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/gallery/hidden', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: '/root/characters/cao-cao/portrait/v1.png', hidden: true }),
      }));
    });
    // sidecar 存相对路径、job 给的是绝对路径——后缀比对生效后按钮翻成「恢复展示」常显态。
    expect(await screen.findByLabelText('恢复展示')).toBeInTheDocument();
    expect(screen.queryByLabelText('隐藏')).not.toBeInTheDocument();
  });

  it('opens on the routed asset tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })));

    render(
      <CharacterGallery
        characterId="cao-cao"
        characterName="曹操"
        initialTab="promo"
        onSelectImage={vi.fn()}
        sseSignal={0}
      />,
    );

    expect(await screen.findByText('等待第一张美宣')).toBeInTheDocument();
  });
});
