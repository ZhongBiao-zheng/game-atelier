// web/src/pages/ProjectPage.test.tsx
import { act, render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectPage } from './ProjectPage';

const sample = {
  project: { id: 'p1', slug: 'pokemon', name: '宝可梦风格', created_at: '2026-06-24T00:00:00+00:00', character_count: 3 },
  worldview_md: '暖色调',
  revision: 'a'.repeat(64),
};

const works = [
  {
    path: 'characters/char-a/promo/kv.png',
    media_type: 'image',
    produced_at: '2026-08-21T08:00:00Z',
    title: '暗影',
    detail: '美宣',
    job_id: 'job-promo-1',
    target: { kind: 'art', character_id: 'char-a', asset_slot: 'promo' },
  },
  {
    path: 'characters/char-b/portrait/v1.png',
    media_type: 'image',
    produced_at: '2026-08-21T07:00:00Z',
    title: '烈拳猴',
    detail: '立绘',
    job_id: null,
    target: { kind: 'art', character_id: 'char-b', asset_slot: 'portrait' },
  },
];

const characterIndex = {
  items: [
    {
      character: { id: 'char-a', name: '暗影', status: 'idle', latest_job_id: 'job-promo-1', derivative: null },
      cover_path: 'characters/char-a/portrait/v1.png',
      activity_at: '2026-08-21T08:00:00Z',
    },
    {
      character: { id: 'char-b', name: '烈拳猴', status: 'idle', latest_job_id: null, derivative: null },
      cover_path: 'characters/char-b/portrait/v1.png',
      activity_at: '2026-08-21T07:00:00Z',
    },
  ],
};

const screenItems = [
  { screen_id: 'home', filename: 'v2.png', path: 'projects/pokemon/ui/v1/screens/home/v2.png', job_id: 'job-ui-2', style_variant: '厚涂写实', base_version: 'v1.png', model: 'gpt-image-2', provider: 'openai', prompt: '主界面提示词', mtime: 200 },
  { screen_id: 'home', filename: 'v1.png', path: 'projects/pokemon/ui/v1/screens/home/v1.png', job_id: null, style_variant: null, base_version: null, model: null, provider: null, prompt: null, mtime: 150 },
  { screen_id: 'battle', filename: 'v1.png', path: 'projects/pokemon/ui/v1/screens/battle/v1.png', job_id: null, style_variant: null, base_version: null, model: null, provider: null, prompt: null, mtime: 120 },
];

const emptyScreenCanonical = { screens: {} };

function createGalleryHiddenHandler(initialPaths: string[], failOnWrite?: number) {
  let hiddenPaths = initialPaths;
  let writes = 0;
  return async (url: string, init?: RequestInit): Promise<Response | null> => {
    if (url === '/api/gallery/hidden' && init?.method === 'POST') {
      writes += 1;
      if (writes === failOnWrite) throw new Error('offline');
      const body = JSON.parse(String(init.body)) as { path: string; hidden: boolean };
      hiddenPaths = body.hidden ? [body.path] : [];
      return { ok: true, json: async () => ({ paths: hiddenPaths }) } as Response;
    }
    if (url === '/api/gallery/hidden') {
      return { ok: true, json: async () => ({ paths: hiddenPaths }) } as Response;
    }
    return null;
  };
}

const workspaceSummary = {
  project_id: 'p1',
  art: { characters: 3, canonical: 2, stale: 0 },
  ui: {
    scheme_id: 'v1',
    anchors: { gdd: 'approved', prd: 'approved', interaction: 'approved' },
    anchors_approved: 3,
    style_status: 'approved',
    has_ui_style: true,
    screen_map_status: 'draft',
    screens: 2,
    versions: 3,
    canonical: 0,
    stale: 0,
    screen_items: [
      { screen_id: 'home', name: '主界面', category: 'core', priority: 'must-have', status: 'generated', dependency: '', purpose: '进入游戏', brief_summary: '让玩家查看全部核心功能入口' },
      { screen_id: 'battle', name: '战斗页', category: 'core', priority: 'must-have', status: 'planned', dependency: 'home', purpose: '进行战斗', brief_summary: '' },
    ],
    next_action: '完成风格定稿',
    next_command: '/game-atelier:ui-page',
  },
  video: {
    productions: 0,
    versions: 0,
    selected: 0,
    next_action: '建立第一个视频企划',
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
    if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true, revision: 'b'.repeat(64) }) } as Response;
    if (typeof url === 'string' && url === '/api/projects/p1/characters/index') {
      return { ok: true, json: async () => characterIndex } as Response;
    }
    if (typeof url === 'string' && url.startsWith('/api/projects/p1/gallery')) {
      return { ok: true, json: async () => ({ items: works, next_cursor: null }) } as Response;
    }
    if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
      return { ok: true, json: async () => ({ items: screenItems }) } as Response;
    }
    if (typeof url === 'string' && url.includes('/screens/canonical')) {
      return { ok: true, json: async () => emptyScreenCanonical } as Response;
    }
    if (typeof url === 'string' && url.includes('/workspaces')) {
      return { ok: true, json: async () => workspaceSummary } as Response;
    }
    return { ok: true, json: async () => sample } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ProjectPage', () => {
  it('项目经验默认阅读，点编辑才出现输入框', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.getByText('暖色调')).toBeInTheDocument();
    const readingPanel = screen.getByRole('article', { name: '项目经验 / 世界观内容' });
    expect(readingPanel.className).toContain('max-h-72');
    expect(readingPanel.className).toContain('overflow-y-auto');
    expect(readingPanel).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('textbox', { name: '项目经验 / 世界观' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    expect((screen.getByRole('textbox', { name: '项目经验 / 世界观' }) as HTMLTextAreaElement).value).toBe('暖色调');
  });

  it('无改动时保存禁用，改动后可保存并 POST', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await waitFor(() => screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '项目经验 / 世界观' }), { target: { value: '暖色调，避免 IP' } });
    expect(save).not.toBeDisabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith('/api/experience', expect.objectContaining({ method: 'POST', body: JSON.stringify({ project: 'p1', worldview_md: '暖色调，避免 IP', expected_revision: sample.revision }) })),
    );
  });

  it('keeps the worldview draft visible when its source revision was changed by an Agent', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await screen.findByRole('button', { name: '编辑' }); fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    const editor = screen.getByRole('textbox', { name: '项目经验 / 世界观' });
    fireEvent.change(editor, { target: { value: '我未保存的世界观' } });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'DOCUMENT_CONFLICT', message: '文档已被其他编辑者修改' } }), { status: 409 }));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await screen.findByText(/文档已被其他编辑者修改/);
    expect(editor).toHaveValue('我未保存的世界观');
    expect(screen.queryByText('已保存')).not.toBeInTheDocument();
  });

  it('编辑未保存时阻止浏览器后退离开项目', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const forward = vi.spyOn(window.history, 'forward').mockImplementation(() => {});
    window.history.replaceState({}, '', '/workshop/p1/overview');
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await waitFor(() => screen.getByRole('button', { name: '编辑' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(screen.getByRole('textbox', { name: '项目经验 / 世界观' }), {
      target: { value: '尚未保存的新世界观' },
    });

    window.history.pushState({}, '', '/workshop');
    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(confirm).toHaveBeenCalledWith('项目经验尚未保存，确定离开吗？');
    expect(forward).toHaveBeenCalledOnce();
    window.history.replaceState({}, '', '/');
  });

  it('美术工作区渲染角色索引，角色卡进入角色工作台', async () => {
    render(<ProjectPage projectId="p1" workspace="art" />);
    await waitFor(() => expect(screen.getByRole('heading', { name: '全部角色' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '打开角色 暗影' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开角色 烈拳猴' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建角色' })).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith('/api/projects/p1/workspaces');
  });

  it('项目没有角色时仍显示可操作的角色索引空状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url === '/api/projects/p1/characters/index') {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="art" />);
    expect(await screen.findByRole('heading', { name: '全部角色' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建角色' })).toBeInTheDocument();
    expect(screen.queryByText('宝可梦风格')).not.toBeInTheDocument();
  });

  it('没有可见 UI 方案时展示独立空状态且不跳转到 V1', async () => {
    const replaceState = vi.spyOn(window.history, 'replaceState');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/ui-schemes?visible_only=true')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [] }) } as Response;
      }
      if (url.endsWith('/ui-schemes')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="ui" />);

    expect(await screen.findByText('暂无 UI 方案')).toBeInTheDocument();
    expect(replaceState).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      '/workshop/p1/ui/v1',
    );
  });

  it('裸 UI 入口在存在可见方案时跳转到真实内容', async () => {
    window.history.replaceState({}, '', '/workshop/p1/ui');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/ui-schemes?visible_only=true')) {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [{ id: 'v2', name: '寒锋 V2', created_at: '' }],
          }),
        } as Response;
      }
      if (url.endsWith('/ui-schemes')) {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [
              { id: 'v1', name: 'V1', created_at: '' },
              { id: 'v2', name: '寒锋 V2', created_at: '' },
            ],
          }),
        } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="ui" />);

    await waitFor(() => expect(window.location.pathname).toBe('/workshop/p1/ui/v2'));
    window.history.replaceState({}, '', '/');
  });

  it('UI 总览按 screen-map 展示页面地图并链接详情', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);
    await waitFor(() => expect(screen.getByRole('region', { name: '页面地图' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /主界面/ })).toHaveAttribute(
      'href', '/workshop/p1/ui/v1/screens/home',
    );
    expect(screen.getAllByText('待定稿')).toHaveLength(2);
    expect(screen.queryByText('待设计')).not.toBeInTheDocument();
  });

  it('页面详情按 screen-id 列出版本图', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '查看页面 home 的 v2.png' }).getAttribute('href')).toBe(
      '/api/gallery/image?path=projects%2Fpokemon%2Fui%2Fv1%2Fscreens%2Fhome%2Fv2.png',
    );
    expect(screen.getByRole('link', { name: '查看页面 home 的 v1.png' })).toBeInTheDocument();
    expect(screen.getByText('让玩家查看全部核心功能入口')).toBeInTheDocument();
    expect(screen.getByText('openai · gpt-image-2')).toBeInTheDocument();
    expect(screen.getByText('主界面提示词')).toBeInTheDocument();
  });

  it('UI 页面版本可从资产详情恢复到项目画廊，并在失败时保留当前状态', async () => {
    const target = 'projects/pokemon/ui/v1/screens/home/v2.png';
    const galleryHiddenResponse = createGalleryHiddenHandler([target], 2);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const galleryResponse = await galleryHiddenResponse(url, init);
      if (galleryResponse) return galleryResponse;
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      if (url.startsWith('/api/gallery/screens')) {
        return { ok: true, json: async () => ({ items: screenItems }) } as Response;
      }
      if (url.includes('/screens/canonical')) {
        return { ok: true, json: async () => emptyScreenCanonical } as Response;
      }
      if (url.includes('/workspaces')) {
        return { ok: true, json: async () => workspaceSummary } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" screenId="home" />);

    fireEvent.click(await screen.findByRole('button', { name: '恢复展示 v2.png' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/gallery/hidden',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: target, hidden: false }),
      }),
    ));
    const hideButton = await screen.findByRole('button', { name: '从项目画廊隐藏 v2.png' });

    fireEvent.click(hideButton);
    expect(await screen.findByText('更新项目画廊展示状态失败，请稍后再试。')).toBeInTheDocument();
    expect(hideButton).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: '恢复展示 v2.png' })).not.toBeInTheDocument();
  });

  it('项目没有页面图时不渲染「页面」区', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      if (typeof url === 'string' && url.startsWith('/api/projects/p1/gallery')) {
        return { ok: true, json: async () => ({ items: works, next_cursor: null }) } as Response;
      }
      if (typeof url === 'string' && url.includes('/screens/canonical')) {
        return { ok: true, json: async () => emptyScreenCanonical } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);
    await waitFor(() => expect(screen.getByText('这个项目还没有 UI 设计锚')).toBeInTheDocument());
    expect(screen.queryByTestId('project-screens')).toBeNull();
  });

  it('风格候选标风格名与来源版本，普通版本退回文件名', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(screen.getByText('厚涂写实')).toBeInTheDocument();
    expect(screen.getByText('← v1.png')).toBeInTheDocument();
    expect(screen.getByText('v1.png')).toBeInTheDocument();
  });

  it('点定稿按钮 POST screen canonical，再点取消传 null', async () => {
    const canonicalAfterSet = {
      screens: { home: { path: 'projects/pokemon/ui/v1/screens/home/v2.png', set_at: 'x', style_variant: '厚涂写实' } },
    };
    let posted: unknown[] = [];
    let workspaceReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (init?.method === 'POST' && typeof url === 'string' && url.includes('/screens/canonical')) {
        const body = JSON.parse(String(init.body));
        posted.push(body);
        return { ok: true, json: async () => (body.path ? canonicalAfterSet : emptyScreenCanonical) } as Response;
      }
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
        return { ok: true, json: async () => ({ items: works }) } as Response;
      }
      if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
        return { ok: true, json: async () => ({ items: screenItems }) } as Response;
      }
      if (typeof url === 'string' && url.includes('/screens/canonical')) {
        return { ok: true, json: async () => emptyScreenCanonical } as Response;
      }
      if (typeof url === 'string' && url.includes('/workspaces')) {
        workspaceReads += 1;
        return { ok: true, json: async () => workspaceSummary } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '设为定稿 v2.png' }));
    await waitFor(() => expect(screen.getByText('定稿')).toBeInTheDocument());
    expect(posted[0]).toEqual({ screen_id: 'home', path: 'projects/pokemon/ui/v1/screens/home/v2.png' });
    await waitFor(() => expect(workspaceReads).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByRole('button', { name: '取消定稿 v2.png' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ screen_id: 'home', path: null });
  });

  it('定稿后 style.md 变更 → 定稿角标带「风格已变更」(A3)', async () => {
    const staleCanonical = {
      screens: {
        home: {
          path: 'projects/pokemon/ui/v1/screens/home/v2.png',
          set_at: 'x',
          style_variant: '厚涂写实',
          style_stale: true,
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
        return { ok: true, json: async () => ({ items: works }) } as Response;
      }
      if (typeof url === 'string' && url.startsWith('/api/gallery/screens')) {
        return { ok: true, json: async () => ({ items: screenItems }) } as Response;
      }
      if (typeof url === 'string' && url.includes('/screens/canonical')) {
        return { ok: true, json: async () => staleCanonical } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(await screen.findByText('定稿')).toBeInTheDocument();
    expect(await screen.findByText('风格已变更')).toBeInTheDocument();
    expect(screen.getByText('已过时')).toBeInTheDocument();
    expect(screen.getByText(/当前 style\.md 已变更/)).toBeInTheDocument();
  });

  it('内容页不再重复渲染项目壳导航和返回按钮', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);
    await waitFor(() => expect(screen.getByText('页面地图')).toBeInTheDocument());
    expect(screen.queryByText('宝可梦风格')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: '项目工作区' })).not.toBeInTheDocument();
    expect(screen.queryByText('返回工坊')).not.toBeInTheDocument();
  });

  it('概览不再混排完整美术与 UI 版本墙', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.queryByTestId('project-works')).toBeNull();
    expect(screen.queryByTestId('project-screens')).toBeNull();
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/gallery/project'));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/api/gallery/screens'));
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/videos'));
  });

  it('视频工作区空状态复制新建企划指令，不再导向自由试验', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<ProjectPage projectId="p1" workspace="video" />);
    expect(await screen.findByText('这个项目还没有视频企划')).toBeInTheDocument();
    expect(screen.getByText('/game-atelier:video')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '去创作台试验视频' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '复制新建企划指令' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/game-atelier:video'));
    expect(await screen.findByText('已复制，回到对话粘贴并发送即可。')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalledWith('/api/projects/p1/workspaces');
  });

  it('视频企划读取完成前不显示新建空状态', async () => {
    let resolveVideos!: (response: Response) => void;
    const videosResponse = new Promise<Response>((resolve) => {
      resolveVideos = resolve;
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/videos')) return videosResponse;
      if (url.endsWith('/video-references')) {
        return { ok: true, json: async () => ({ candidates: [] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="video" />);

    expect(await screen.findByText('正在读取视频企划…')).toBeInTheDocument();
    expect(screen.queryByText('这个项目还没有视频企划')).not.toBeInTheDocument();

    await act(async () => {
      resolveVideos({
        ok: true,
        json: async () => ({
          productions: [{
            production_id: 'pv',
            title: '上线宣传片',
            type: 'promo',
            status: 'draft',
            brief: { goal: '', platform: '', ratio: '', duration: '', sound: '' },
            prompt: '', versions: [], selected: null,
            planned_reference_images: [], history: [],
          }],
        }),
      } as Response);
      await videosResponse;
    });

    expect(await screen.findByText('上线宣传片')).toBeInTheDocument();
    expect(screen.queryByText('这个项目还没有视频企划')).not.toBeInTheDocument();
  });

  it('视频企划读取失败时显示错误，不误显示新建空状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/videos')) throw new Error('offline');
      if (url.endsWith('/video-references')) {
        return { ok: true, json: async () => ({ candidates: [] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="video" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('视频企划读取失败');
    expect(screen.getByText('无法读取当前项目的视频企划，请刷新页面重试。')).toBeInTheDocument();
    expect(screen.queryByText('这个项目还没有视频企划')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '复制新建企划指令' })).not.toBeInTheDocument();
  });

  it('视频企划指令复制失败时保留手动复制入口', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('blocked')) },
    });
    render(<ProjectPage projectId="p1" workspace="video" />);

    fireEvent.click(await screen.findByRole('button', { name: '复制新建企划指令' }));

    expect(await screen.findByText('复制失败，请手动选择上方指令。')).toBeInTheDocument();
    expect(screen.getByText('/game-atelier:video')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制新建企划指令' })).toBeEnabled();
  });

  it('UI 工作区展示作品与页面地图，不再展示命令式工作流', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);
    expect(await screen.findByRole('region', { name: 'UI 作品' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '页面地图' })).toBeInTheDocument();
    expect(screen.queryByText('下一步：完成风格定稿')).not.toBeInTheDocument();
    expect(screen.queryByText('/game-atelier:ui-page')).not.toBeInTheDocument();
  });

  it('screen-map 只有规划页时展示待设计状态且没有作品区', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      if (url.includes('/workspaces')) {
        return {
          ok: true,
          json: async () => ({
            ...workspaceSummary,
            ui: { ...workspaceSummary.ui, screens: 2, versions: 0 },
          }),
        } as Response;
      }
      if (url.includes('/gallery/screens')) return { ok: true, json: async () => ({ items: [] }) } as Response;
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);

    expect(await screen.findByRole('region', { name: '页面地图' })).toBeInTheDocument();
    expect(screen.getAllByText('待设计')).toHaveLength(1);
    expect(screen.queryByRole('region', { name: 'UI 作品' })).not.toBeInTheDocument();
  });

  it('全部页面定稿后仍以作品与页面地图呈现，不显示工作流状态', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      if (url.includes('/workspaces')) {
        return {
          ok: true,
          json: async () => ({
            ...workspaceSummary,
            ui: {
              ...workspaceSummary.ui,
              screens: 2,
              canonical: 2,
              stale: 0,
              next_action: '复核 UI 页面交付',
              next_command: '/game-atelier:ui',
            },
          }),
        } as Response;
      }
      if (url.includes('/gallery/screens')) return { ok: true, json: async () => ({ items: screenItems }) } as Response;
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);

    expect(await screen.findByRole('region', { name: 'UI 作品' })).toBeInTheDocument();
    expect(screen.queryByText('6. 逐页生成')).not.toBeInTheDocument();
    expect(screen.queryByText('下一步：复核 UI 页面交付')).not.toBeInTheDocument();
  });

  it('可从当前方案复制风格、页面地图和指定页面创建新方案', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/ui-schemes') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [
              { id: 'v1', name: 'V1', created_at: '' },
              { id: 'v2', name: '夏日 V2', created_at: '' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      if (url.includes('/gallery/screens')) return { ok: true, json: async () => ({ items: screenItems }) } as Response;
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      if (url.includes('/workspaces')) return { ok: true, json: async () => workspaceSummary } as Response;
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
    const form = screen.getByRole('form', { name: '新建 UI 方案' });
    fireEvent.change(screen.getByLabelText('方案名称'), { target: { value: '夏日 V2' } });
    fireEvent.click(within(form).getByLabelText('主界面'));
    fireEvent.click(screen.getByRole('button', { name: '创建并打开' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/ui-schemes',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: '夏日 V2',
          source_scheme_id: 'v1',
          copy_style: true,
          copy_screen_map: true,
          screen_ids: ['home'],
        }),
      }),
    ));
    expect(form).not.toBeInTheDocument();
  });

  it('可把当前方案设为默认且不删除其他方案', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/ui-schemes/default') && init?.method === 'POST') {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v2',
            schemes: [
              { id: 'v1', name: 'V1', created_at: '' },
              { id: 'v2', name: '夏日 V2', created_at: '' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return {
          ok: true,
          json: async () => ({
            default_scheme_id: 'v1',
            schemes: [
              { id: 'v1', name: 'V1', created_at: '' },
              { id: 'v2', name: '夏日 V2', created_at: '' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/gallery/screens')) return { ok: true, json: async () => ({ items: [] }) } as Response;
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      if (url.includes('/workspaces')) {
        return {
          ok: true,
          json: async () => ({ ...workspaceSummary, ui: { ...workspaceSummary.ui, scheme_id: 'v2' } }),
        } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v2" />);

    fireEvent.click(await screen.findByRole('button', { name: '设为默认' }));

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/ui-schemes/default',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ scheme_id: 'v2' }),
      }),
    ));
    expect(screen.queryByRole('navigation', { name: '切换 UI 方案' })).not.toBeInTheDocument();
    expect(screen.getByText('夏日 V2')).toBeInTheDocument();
    expect(screen.getByText('默认')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '设为默认' })).not.toBeInTheDocument();
  });

  it('没有 screen-map 时仍可选择复制图库里的既有页面', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) {
        return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      }
      if (url.includes('/gallery/screens')) {
        return { ok: true, json: async () => ({ items: [screenItems[0]] }) } as Response;
      }
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      if (url.includes('/workspaces')) {
        return {
          ok: true,
          json: async () => ({
            ...workspaceSummary,
            ui: { ...workspaceSummary.ui, screen_items: [] },
          }),
        } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" uiSchemeId="v1" />);

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));

    expect(screen.getByRole('checkbox', { name: 'home' })).toBeInTheDocument();
  });

  it('视频工作区按企划展示完整提示词、历史和整片版本', async () => {
    const videoPath = 'projects/pokemon/videos/pv/versions/v1.mp4';
    const galleryHiddenResponse = createGalleryHiddenHandler([videoPath]);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const galleryResponse = await galleryHiddenResponse(url, init);
      if (galleryResponse) return galleryResponse;
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (url.endsWith('/video-references')) {
        return { ok: true, json: async () => ({ candidates: [
          {
            kind: 'character', asset_id: 'hero-summer', scheme_id: null,
            label: '曹操·夏日 · 立绘', detail: '角色衍生定稿',
            path: 'characters/hero-summer/portrait/v2.png', stale: false,
          },
          {
            kind: 'ui_screen', asset_id: 'home', scheme_id: 'v2',
            label: 'V2 · home', detail: 'UI 页面定稿',
            path: 'projects/pokemon/ui/v2/screens/home/v3.png', stale: true,
          },
        ] }) } as Response;
      }
      if (init?.method === 'POST' && url.includes('/references')) {
        return { ok: true, json: async () => ({ paths: ['characters/hero-summer/portrait/v2.png'] }) } as Response;
      }
      if (init?.method === 'POST' && url.includes('/selected')) {
        return { ok: true, json: async () => ({ path: videoPath }) } as Response;
      }
      if (url.includes('/videos')) {
        return {
          ok: true,
          json: async () => ({
            productions: [{
              production_id: 'pv',
              title: '上线宣传片',
              type: 'promo',
              status: 'draft',
              brief: { goal: '角色上线亮相', platform: 'B站', ratio: '16:9', duration: '30s', sound: '音乐驱动' },
              prompt: '主体：曹操@图片1\n镜头1：角色转身。\n镜头2：镜头推进。',
              versions: [videoPath],
              selected: null,
              planned_reference_images: [],
              history: [
                  {
                    job_id: 'job-video-1', submitted_at: '2026-08-20T10:00:00Z',
                    completed_at: null, status: 'done', prompt: '角色转身，镜头推进',
                    model: 'seedance-2.5-pro',
                    params: {
                      duration: 5, resolution: '1080p', ratio: '16:9',
                      reference_images: ['characters/hero/portrait/v1.png'],
                    },
                  },
                  {
                    job_id: 'job-video-0', submitted_at: '2026-08-19T10:00:00Z',
                    completed_at: null, status: 'done', prompt: '旧版镜头',
                    model: 'seedance-2.0', params: { duration: 3 },
                  },
              ],
            }],
          }),
        } as Response;
      }
      if (url.startsWith('/api/gallery/project')) return { ok: true, json: async () => ({ items: [] }) } as Response;
      if (url.startsWith('/api/gallery/screens')) return { ok: true, json: async () => ({ items: [] }) } as Response;
      if (url.includes('/screens/canonical')) return { ok: true, json: async () => emptyScreenCanonical } as Response;
      if (url.includes('/workspaces')) return { ok: true, json: async () => workspaceSummary } as Response;
      return { ok: true, json: async () => sample } as Response;
    }));
    render(
      <ProjectPage
        projectId="p1"
        workspace="video"
        productionId="pv"
      />,
    );

    expect(await screen.findByRole('heading', { name: '上线宣传片' })).toBeInTheDocument();
    expect(screen.getByText(/主体：曹操@图片1/)).toBeInTheDocument();
    expect(screen.getByText(/seedance-2\.5-pro/)).toBeInTheDocument();
    expect(screen.getByText('角色转身，镜头推进')).toBeInTheDocument();
    expect(screen.getByText(/seedance-2\.0/)).toBeInTheDocument();
    expect(screen.getByText('旧版镜头')).toBeInTheDocument();
    expect(screen.getByText('1080p')).toBeInTheDocument();
    expect(screen.getByText('v1.png')).toBeInTheDocument();
    expect(screen.getByAltText('v1.png')).toHaveAttribute(
      'src',
      '/api/raw?job_id=job-video-1&path=characters%2Fhero%2Fportrait%2Fv1.png',
    );
    expect(screen.getByRole('button', { name: '选择参考 曹操·夏日 · 立绘' })).toBeInTheDocument();
    expect(screen.getByText('定稿已过时')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: '恢复展示 v1.mp4' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/gallery/hidden',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: videoPath, hidden: false }),
      }),
    ));
    expect(await screen.findByRole('button', { name: '从项目画廊隐藏 v1.mp4' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择参考 曹操·夏日 · 立绘' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/videos/pv/references',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ paths: ['characters/hero-summer/portrait/v2.png'] }),
      }),
    ));
    fireEvent.click(screen.getByRole('button', { name: '定稿 v1.mp4' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/videos/pv/selected',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('完整视频版本可从企划详情恢复到项目画廊', async () => {
    const exportPath = 'projects/pokemon/videos/pv/versions/final.mp4';
    const galleryHiddenResponse = createGalleryHiddenHandler([exportPath]);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const galleryResponse = await galleryHiddenResponse(url, init);
      if (galleryResponse) return galleryResponse;
      if (url.includes('/videos')) {
        return {
          ok: true,
          json: async () => ({
            productions: [{
              production_id: 'pv', title: '上线宣传片', type: 'promo', status: 'done',
              brief: { goal: '亮相', platform: 'B站', ratio: '16:9', duration: '30s', sound: '音乐' },
              prompt: '镜头1：角色亮相。', versions: [exportPath], selected: exportPath,
              planned_reference_images: [], history: [],
            }],
          }),
        } as Response;
      }
      if (url.includes('/workspaces')) {
        return { ok: true, json: async () => workspaceSummary } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));

    render(<ProjectPage projectId="p1" workspace="video" productionId="pv" />);

    fireEvent.click(await screen.findByRole('button', { name: '恢复展示 final.mp4' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/gallery/hidden',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ path: exportPath, hidden: false }),
      }),
    ));
    expect(await screen.findByRole('button', { name: '从项目画廊隐藏 final.mp4' })).toBeInTheDocument();
  });

  it('视频企划详情展示一份完整多镜头提示词', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/videos')) {
        return {
          ok: true,
          json: async () => ({
            productions: [{
              production_id: 'pv',
              title: '上线宣传片',
              type: 'promo',
              status: 'draft',
              brief: { goal: '角色上线亮相', platform: '抖音', ratio: '9:16', duration: '15s', sound: '保留技能音效' },
              prompt: '镜头1：角色亮相。\n镜头2：展示核心技能。',
              versions: [], selected: null, planned_reference_images: [], history: [],
            }],
          }),
        } as Response;
      }
      if (url.includes('/workspaces')) return { ok: true, json: async () => workspaceSummary } as Response;
      return { ok: true, json: async () => sample } as Response;
    }));

    render(
      <ProjectPage
        projectId="p1"
        workspace="video"
        productionId="pv"
      />,
    );

    expect(await screen.findByText('完整生成提示词')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '复制生成指令' })).toBeEnabled();
    expect(screen.getByText(/镜头1：角色亮相/)).toBeInTheDocument();
    expect(screen.getByText('抖音')).toBeInTheDocument();
    expect(screen.getByText('9:16')).toBeInTheDocument();
    expect(screen.getByText('15s')).toBeInTheDocument();
    expect(screen.getByText('保留技能音效')).toBeInTheDocument();
  });

  it('视频选版失败时提示错误并恢复按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/ui-schemes') && !url.includes('/screens/canonical')) return { ok: true, json: async () => ({ default_scheme_id: 'v1', schemes: [{ id: 'v1', name: 'V1', created_at: '' }] }) } as Response;
      if (init?.method === 'POST' && url.includes('/selected')) throw new Error('offline');
      if (url.includes('/videos')) {
        return {
          ok: true,
          json: async () => ({
            productions: [{
              production_id: 'pv', title: '上线宣传片', type: 'promo', status: 'draft',
              brief: { goal: '亮相', platform: '', ratio: '', duration: '', sound: '' },
              prompt: '镜头1：亮相。',
              versions: ['projects/pokemon/videos/pv/versions/v1.mp4'], selected: null,
              planned_reference_images: [], history: [],
            }],
          }),
        } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(
      <ProjectPage projectId="p1" workspace="video" productionId="pv" />,
    );

    const button = await screen.findByRole('button', { name: '定稿 v1.mp4' });
    fireEvent.click(button);
    expect(await screen.findByText('选版失败，请稍后再试。')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
});
