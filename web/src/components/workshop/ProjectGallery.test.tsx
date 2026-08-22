import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { ProjectGallery } from './ProjectGallery';

const art = {
  path: 'characters/hero/promo/v1.png',
  media_type: 'image',
  produced_at: '2026-08-21T08:00:00Z',
  title: '英雄',
  detail: '美宣',
  job_id: 'job-1',
  target: { kind: 'art', character_id: 'hero', asset_slot: 'promo' },
};

const video = {
  path: 'projects/demo/videos/trailer/versions/v1.mp4',
  media_type: 'video',
  produced_at: '2026-08-21T07:00:00Z',
  title: '首支预告片',
  detail: '完整视频',
  job_id: 'job-2',
  target: {
    kind: 'video', production_id: 'trailer', output_kind: 'version',
  },
};

function renderGallery(path = '/workshop/p1/overview') {
  const location = memoryLocation({ path });
  return render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <ProjectGallery projectId="p1" />
    </Router>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('ProjectGallery', () => {
  it('按类别重新读取，并通过游标加载更多', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('category=all') && !url.includes('cursor=')) {
        return { ok: true, json: async () => ({ items: [art], next_cursor: 'next' }) };
      }
      if (url.includes('cursor=next')) {
        return { ok: true, json: async () => ({ items: [video], next_cursor: null }) };
      }
      if (url.includes('category=ui')) {
        return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGallery();

    expect(await screen.findByRole('button', { name: '预览英雄，美宣' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('button', { name: '预览首支预告片，完整视频' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'UI' }));
    expect(await screen.findByText('还没有可展示的作品')).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('category=ui'));
  });

  it('图片先进入 URL 可恢复的统一预览，再进入真实资产详情', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [art], next_cursor: null }),
    })));
    renderGallery();

    const card = await screen.findByRole('button', { name: '预览英雄，美宣' });
    fireEvent.click(card);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: '英雄，美宣' })).toBeVisible();
    expect(within(dialog).getByRole('link', { name: '进入资产详情' })).toHaveAttribute(
      'href',
      '/workshop/p1/art/characters/hero/promo/job-1/characters%2Fhero%2Fpromo%2Fv1.png',
    );
  });

  it('可在预览层切换前后作品，并用 Escape 关闭后恢复焦点', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ items: [art, video], next_cursor: null }),
    })));
    renderGallery();

    const artCard = await screen.findByRole('button', { name: '预览英雄，美宣' });
    fireEvent.click(artCard);
    fireEvent.click(await screen.findByRole('button', { name: '下一件' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('video')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(artCard).toHaveFocus();
  });

  it('刷新带 media 查询的地址可直接恢复视频预览，视频不自动播放', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/gallery/media?')) return { ok: true, json: async () => video };
      return { ok: true, json: async () => ({ items: [], next_cursor: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGallery(`/workshop/p1/overview?media=${encodeURIComponent(video.path)}`);

    const dialog = await screen.findByRole('dialog');
    const player = dialog.querySelector('video');
    expect(player).not.toBeNull();
    expect(player).not.toHaveAttribute('autoplay');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/gallery/media?path='));
  });

  it('隐藏作品后从当前画廊移除并关闭预览', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/gallery/hidden' && init?.method === 'POST') {
        return { ok: true, json: async () => ({ paths: [art.path] }) };
      }
      return { ok: true, json: async () => ({ items: [art], next_cursor: null }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    renderGallery();

    fireEvent.click(await screen.findByRole('button', { name: '预览英雄，美宣' }));
    fireEvent.click(await screen.findByRole('button', { name: '从项目画廊隐藏' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: '预览英雄，美宣' })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/gallery/hidden', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ path: art.path, hidden: true }),
    }));
  });
});
