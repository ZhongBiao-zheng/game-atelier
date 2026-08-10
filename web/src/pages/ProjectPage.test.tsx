// web/src/pages/ProjectPage.test.tsx
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from './ProjectPage';

const sample = {
  project: { id: 'p1', slug: 'pokemon', name: '宝可梦风格', created_at: '2026-06-24T00:00:00+00:00', character_count: 3 },
  worldview_md: '暖色调',
};

const works = [
  {
    character_id: 'char-a',
    character_name: '暗影',
    asset_slot: 'promo',
    filename: 'kv.png',
    path: 'characters/char-a/promo/kv.png',
    job_id: 'job-promo-1',
    mtime: 100,
  },
  {
    character_id: 'char-b',
    character_name: '烈拳猴',
    asset_slot: 'portrait',
    filename: 'v1.png',
    path: 'characters/char-b/portrait/v1.png',
    job_id: null,
    mtime: 50,
  },
];

const screenItems = [
  { screen_id: 'home', filename: 'v2.png', path: 'projects/pokemon/screens/home/v2.png', job_id: 'job-ui-2', mtime: 200 },
  { screen_id: 'home', filename: 'v1.png', path: 'projects/pokemon/screens/home/v1.png', job_id: null, mtime: 150 },
  { screen_id: 'battle', filename: 'v1.png', path: 'projects/pokemon/screens/battle/v1.png', job_id: null, mtime: 120 },
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
    if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
      return { ok: true, json: async () => ({ items: works }) } as Response;
    }
    if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
      return { ok: true, json: async () => ({ items: screenItems }) } as Response;
    }
    return { ok: true, json: async () => sample } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ProjectPage', () => {
  it('渲染项目信息 + 可编辑 worldview', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect((screen.getByLabelText('项目经验 / 世界观') as HTMLTextAreaElement).value).toBe('暖色调');
  });

  it('无改动时保存禁用，改动后可保存并 POST', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => screen.getByLabelText('项目经验 / 世界观'));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('项目经验 / 世界观'), { target: { value: '暖色调，避免 IP' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/experience', expect.objectContaining({ method: 'POST' })),
    );
  });

  it('项目经验下方渲染项目作品区：卡片标角色名、点击进角色大图', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('project-works')).toBeInTheDocument());
    expect(screen.getByText('项目作品')).toBeInTheDocument();

    const kvLink = screen.getByRole('link', { name: '查看 暗影 的美宣' });
    expect(kvLink.getAttribute('href')).toBe(
      '/character/char-a/promo/job-promo-1/characters%2Fchar-a%2Fpromo%2Fkv.png',
    );
    // 无 job_id 的图退回资产槽路由
    expect(screen.getByRole('link', { name: '查看 烈拳猴 的立绘' }).getAttribute('href')).toBe(
      '/character/char-b/portrait',
    );
  });

  it('项目没有作品时不渲染作品区', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.queryByTestId('project-works')).toBeNull();
  });

  it('渲染「页面」区：按 screen-id 分组、组内列出版本图', async () => {
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(screen.getByText('页面')).toBeInTheDocument();
    // 两个分组标题（home 在前 —— 后端最新在前，组序跟最新图）
    expect(screen.getByText('home')).toBeInTheDocument();
    expect(screen.getByText('battle')).toBeInTheDocument();
    // home 组两版
    expect(screen.getByRole('link', { name: '查看页面 home 的 v2.png' }).getAttribute('href')).toBe(
      '/api/gallery/image?path=projects%2Fpokemon%2Fscreens%2Fhome%2Fv2.png',
    );
    expect(screen.getByRole('link', { name: '查看页面 home 的 v1.png' })).toBeInTheDocument();
  });

  it('项目没有页面图时不渲染「页面」区', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
        return { ok: true, json: async () => ({ items: works }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" onBack={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.queryByTestId('project-screens')).toBeNull();
  });
});
