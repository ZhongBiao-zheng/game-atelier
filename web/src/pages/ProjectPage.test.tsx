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
  { screen_id: 'home', filename: 'v2.png', path: 'projects/pokemon/screens/home/v2.png', job_id: 'job-ui-2', style_variant: '厚涂写实', base_version: 'v1.png', model: 'gpt-image-2', provider: 'openai', prompt: '主界面提示词', mtime: 200 },
  { screen_id: 'home', filename: 'v1.png', path: 'projects/pokemon/screens/home/v1.png', job_id: null, style_variant: null, base_version: null, model: null, provider: null, prompt: null, mtime: 150 },
  { screen_id: 'battle', filename: 'v1.png', path: 'projects/pokemon/screens/battle/v1.png', job_id: null, style_variant: null, base_version: null, model: null, provider: null, prompt: null, mtime: 120 },
];

const emptyScreenCanonical = { screens: {} };
const workspaceSummary = {
  project_id: 'p1',
  art: { characters: 3, canonical: 2, stale: 0 },
  ui: {
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
    shots: 0,
    selected_shots: 0,
    exports: 0,
    next_action: '建立第一个视频企划',
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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
      return { ok: true, json: async () => workspaceSummary } as Response;
    }
    return { ok: true, json: async () => sample } as Response;
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('ProjectPage', () => {
  it('渲染项目信息 + 可编辑 worldview', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.getByText('3', { selector: 'dd' })).toBeInTheDocument();
    expect((screen.getByLabelText('项目经验 / 世界观') as HTMLTextAreaElement).value).toBe('暖色调');
  });

  it('无改动时保存禁用，改动后可保存并 POST', async () => {
    render(<ProjectPage projectId="p1" workspace="overview" />);
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
    render(<ProjectPage projectId="p1" workspace="art" />);
    await waitFor(() => expect(screen.getByTestId('project-works')).toBeInTheDocument());
    expect(screen.getByText('全部美术作品')).toBeInTheDocument();

    const kvLink = screen.getByRole('link', { name: '查看 暗影 的美宣' });
    expect(kvLink.getAttribute('href')).toBe(
      '/workshop/p1/art/characters/char-a/promo/job-promo-1/characters%2Fchar-a%2Fpromo%2Fkv.png',
    );
    // 无 job_id 的图退回资产槽路由
    expect(screen.getByRole('link', { name: '查看 烈拳猴 的立绘' }).getAttribute('href')).toBe(
      '/workshop/p1/art/characters/char-b/portrait',
    );
    expect(fetch).not.toHaveBeenCalledWith('/api/projects/p1/workspaces');
  });

  it('项目没有作品时不渲染作品区', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ ok: true }) } as Response;
      if (typeof url === 'string' && url.startsWith('/api/gallery/project')) {
        return { ok: true, json: async () => ({ items: [] }) } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="art" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.queryByTestId('project-works')).toBeNull();
  });

  it('UI 总览按 screen-map 展示页面地图并链接详情', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" />);
    await waitFor(() => expect(screen.getByRole('region', { name: '页面地图' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /主界面/ })).toHaveAttribute(
      'href', '/workshop/p1/ui/screens/home',
    );
    expect(screen.getAllByText('待定稿')).toHaveLength(2);
    expect(screen.queryByText('待设计')).not.toBeInTheDocument();
  });

  it('页面详情按 screen-id 列出版本图', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: '查看页面 home 的 v2.png' }).getAttribute('href')).toBe(
      '/api/gallery/image?path=projects%2Fpokemon%2Fscreens%2Fhome%2Fv2.png',
    );
    expect(screen.getByRole('link', { name: '查看页面 home 的 v1.png' })).toBeInTheDocument();
    expect(screen.getByText('让玩家查看全部核心功能入口')).toBeInTheDocument();
    expect(screen.getByText('openai · gpt-image-2')).toBeInTheDocument();
    expect(screen.getByText('主界面提示词')).toBeInTheDocument();
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
      if (typeof url === 'string' && url.includes('/screens/canonical')) {
        return { ok: true, json: async () => emptyScreenCanonical } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(<ProjectPage projectId="p1" workspace="ui" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
    expect(screen.queryByTestId('project-screens')).toBeNull();
  });

  it('风格候选标风格名与来源版本，普通版本退回文件名', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(screen.getByText('厚涂写实')).toBeInTheDocument();
    expect(screen.getByText('← v1.png')).toBeInTheDocument();
    expect(screen.getByText('v1.png')).toBeInTheDocument();
  });

  it('点定稿按钮 POST screen canonical，再点取消传 null', async () => {
    const canonicalAfterSet = {
      screens: { home: { path: 'projects/pokemon/screens/home/v2.png', set_at: 'x', style_variant: '厚涂写实' } },
    };
    let posted: unknown[] = [];
    let workspaceReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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

    render(<ProjectPage projectId="p1" workspace="ui" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '设为定稿 v2.png' }));
    await waitFor(() => expect(screen.getByText('定稿')).toBeInTheDocument());
    expect(posted[0]).toEqual({ screen_id: 'home', path: 'projects/pokemon/screens/home/v2.png' });
    await waitFor(() => expect(workspaceReads).toBeGreaterThanOrEqual(2));

    fireEvent.click(screen.getByRole('button', { name: '取消定稿 v2.png' }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toEqual({ screen_id: 'home', path: null });
  });

  it('定稿后 style.md 变更 → 定稿角标带「风格已变更」(A3)', async () => {
    const staleCanonical = {
      screens: {
        home: {
          path: 'projects/pokemon/screens/home/v2.png',
          set_at: 'x',
          style_variant: '厚涂写实',
          style_stale: true,
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
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

    render(<ProjectPage projectId="p1" workspace="ui" screenId="home" />);
    await waitFor(() => expect(screen.getByTestId('project-screens')).toBeInTheDocument());
    expect(await screen.findByText('定稿')).toBeInTheDocument();
    expect(await screen.findByText('风格已变更')).toBeInTheDocument();
    expect(screen.getByText('已过时')).toBeInTheDocument();
    expect(screen.getByText(/当前 style\.md 已变更/)).toBeInTheDocument();
  });

  it('内容页不再重复渲染项目壳导航和返回按钮', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" />);
    await waitFor(() => expect(screen.getByText('宝可梦风格')).toBeInTheDocument());
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

  it('视频工作区空状态给出视频 Skill 与自由试验入口', async () => {
    render(<ProjectPage projectId="p1" workspace="video" />);
    expect(await screen.findByText('这个项目还没有视频企划')).toBeInTheDocument();
    expect(screen.getByText('/game-atelier:video')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '去创作台试验视频' })).toHaveAttribute('href', '/studio');
    expect(fetch).not.toHaveBeenCalledWith('/api/projects/p1/workspaces');
  });

  it('UI 工作区显示文件系统推导出的唯一下一步', async () => {
    render(<ProjectPage projectId="p1" workspace="ui" />);
    expect(await screen.findByText('下一步：完成风格定稿')).toBeInTheDocument();
    expect(screen.getByText('/game-atelier:ui-page')).toBeInTheDocument();
  });

  it('screen-map 只有规划页时不把基准页标为完成', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    render(<ProjectPage projectId="p1" workspace="ui" />);

    const baseStep = await screen.findByText('3. 基准页');
    expect(baseStep.parentElement).toHaveTextContent('未开始');
    expect(screen.getAllByText('待设计')).toHaveLength(1);
  });

  it('全部页面定稿后把逐页生成标为完成', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
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
    render(<ProjectPage projectId="p1" workspace="ui" />);

    const generateStep = await screen.findByText('6. 逐页生成');
    expect(generateStep.parentElement).toHaveTextContent('已完成');
    expect(screen.getByText('下一步：复核 UI 页面交付')).toBeInTheDocument();
  });

  it('视频工作区按企划和镜头展示版本，并可选用', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/selected')) {
        return { ok: true, json: async () => ({ shots: { 'shot-01': 'projects/pokemon/videos/pv/shots/shot-01/v1.mp4' } }) } as Response;
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
              shots: [{
                shot_id: 'shot-01',
                purpose: '角色亮相',
                duration: '3s',
                status: 'generated',
                versions: ['projects/pokemon/videos/pv/shots/shot-01/v1.mp4'],
                selected: null,
                prompt: '角色转身，镜头推进',
                model: 'seedance-2.5-pro',
                reference_images: ['characters/hero/portrait/v1.png'],
                reference_videos: [],
                reference_audios: [],
              }],
              exports: [],
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
        shotId="shot-01"
      />,
    );

    expect(await screen.findByRole('link', { name: /上线宣传片/ })).toBeInTheDocument();
    expect(screen.getByText('shot-01')).toBeInTheDocument();
    expect(screen.getByText(/seedance-2\.5-pro/)).toBeInTheDocument();
    expect(screen.getByText('角色转身，镜头推进')).toBeInTheDocument();
    expect(screen.getByText('v1.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选用 shot-01 v1.mp4' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/videos/pv/shots/shot-01/selected',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('视频企划详情按镜头表顺序展示尚未生成的镜头', async () => {
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
              shots: [{
                shot_id: 'shot-02',
                purpose: '展示核心技能',
                duration: '5s',
                status: 'planned',
                versions: [],
                selected: null,
                prompt: '',
                model: '',
                reference_images: [],
                reference_videos: [],
                reference_audios: [],
              }],
              exports: [],
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

    expect(await screen.findByText('镜头板')).toBeInTheDocument();
    expect(screen.getByText('shot-02')).toBeInTheDocument();
    expect(screen.getByText('展示核心技能')).toBeInTheDocument();
    expect(screen.getByText('5s')).toBeInTheDocument();
    expect(screen.getByText('planned')).toBeInTheDocument();
    expect(screen.getByText('抖音')).toBeInTheDocument();
    expect(screen.getByText('9:16')).toBeInTheDocument();
    expect(screen.getByText('15s')).toBeInTheDocument();
    expect(screen.getByText('保留技能音效')).toBeInTheDocument();
  });

  it('视频选版失败时提示错误并恢复按钮', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.includes('/selected')) throw new Error('offline');
      if (url.includes('/videos')) {
        return {
          ok: true,
          json: async () => ({
            productions: [{
              production_id: 'pv', title: '上线宣传片', type: 'promo', status: 'draft',
              brief: { goal: '亮相', platform: '', ratio: '', duration: '', sound: '' },
              shots: [{
                shot_id: 'shot-01', purpose: '亮相', duration: '3s', status: 'generated',
                versions: ['projects/pokemon/videos/pv/shots/shot-01/v1.mp4'], selected: null,
                prompt: '', model: '', reference_images: [], reference_videos: [], reference_audios: [],
              }],
              exports: [],
            }],
          }),
        } as Response;
      }
      return { ok: true, json: async () => sample } as Response;
    }));
    render(
      <ProjectPage projectId="p1" workspace="video" productionId="pv" shotId="shot-01" />,
    );

    const button = await screen.findByRole('button', { name: '选用 shot-01 v1.mp4' });
    fireEvent.click(button);
    expect(await screen.findByText('选版失败，请稍后再试。')).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });
});
