import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Router } from 'wouter';
import { memoryLocation } from 'wouter/memory-location';

import { ProjectFolderPage } from './ProjectFolderPage';

const folders = {
  folders: [{
    id: 'folder-summer',
    name: '夏日版本',
    note: '角色皮肤与宣发',
    created_at: '2026-08-20T00:00:00Z',
    items: [
      { kind: 'character', asset_id: 'cao-cao' },
      { kind: 'ui_screen', asset_id: 'home' },
      { kind: 'video_production', asset_id: 'launch-pv' },
    ],
  }],
};

const workspace = {
  project_id: 'p1',
  art: { characters: 1, canonical: 0, stale: 0 },
  ui: {
    anchors: {}, anchors_approved: 0, style_status: 'missing', has_ui_style: false,
    screen_map_status: 'draft', screens: 1, versions: 0, canonical: 0, stale: 0,
    screen_items: [{ screen_id: 'home', name: '主界面', category: 'core', priority: 'must-have', status: 'planned', dependency: '', purpose: '', brief_summary: '' }],
    next_action: '', next_command: '',
  },
  video: { productions: 1, shots: 0, selected_shots: 0, exports: 0, next_action: '' },
};

const videos = { productions: [{
  production_id: 'launch-pv', title: '上线宣传片', type: 'promo', status: 'draft',
  brief: { goal: '', platform: '', ratio: '', duration: '', sound: '' }, shots: [], exports: [],
}] };

function response(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const path = String(url);
    if (init?.method) return response(folders);
    if (path === '/api/projects/p1/folders') return response(folders);
    if (path === '/api/characters') return response([
      { id: 'cao-cao', name: '曹操', status: 'idle', latest_job_id: null },
      { id: 'sun-quan', name: '孙权', status: 'idle', latest_job_id: null },
    ]);
    if (path === '/api/projects') return response({
      projects: [{ id: 'p1', slug: 'one', name: '项目一', created_at: '' }],
      assignments: { 'cao-cao': 'p1', 'sun-quan': 'p1' },
    });
    if (path === '/api/projects/p1/workspaces') return response(workspace);
    if (path === '/api/gallery/screens?project=p1') return response({ items: [{
      screen_id: 'inventory', filename: 'v1.png', path: 'projects/one/screens/inventory/v1.png',
      job_id: null, style_variant: null, base_version: null, model: null, provider: null,
      prompt: null, mtime: 1,
    }] });
    if (path === '/api/projects/p1/videos') return response(videos);
    return response({});
  }));
});

afterEach(() => vi.unstubAllGlobals());

function renderPage(view: 'overview' | 'art' | 'ui' | 'video' = 'overview') {
  const location = memoryLocation({
    path: `/workshop/p1/folders/folder-summer/${view}`,
    static: false,
    record: true,
  });
  const result = render(
    <Router hook={location.hook}>
      <ProjectFolderPage
        projectId="p1"
        folderId="folder-summer"
        view={view}
        onFolderChange={vi.fn()}
      />
    </Router>,
  );
  return { ...result, location };
}

describe('ProjectFolderPage', () => {
  it('同一详情页混合展示角色、UI 页面和视频企划，四个标签只是过滤链接', async () => {
    renderPage();

    expect(await screen.findByText('曹操')).toBeInTheDocument();
    expect(screen.getByText('主界面')).toBeInTheDocument();
    expect(screen.getByText('上线宣传片')).toBeInTheDocument();
    const filters = screen.getByRole('navigation', { name: '文件夹视图' });
    expect(within(filters).getByRole('link', { name: '美术' })).toHaveAttribute(
      'href', '/workshop/p1/folders/folder-summer/art',
    );
    expect(within(filters).getByRole('link', { name: 'UI' })).toHaveAttribute(
      'href', '/workshop/p1/folders/folder-summer/ui',
    );
  });

  it('按视图过滤成员但不改变引用', async () => {
    renderPage('ui');
    expect(await screen.findByText('主界面')).toBeInTheDocument();
    expect(screen.queryByText('曹操')).not.toBeInTheDocument();
    expect(screen.queryByText('上线宣传片')).not.toBeInTheDocument();
    expect(screen.queryByText('孙权')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '添加UI 页面 inventory' })).toBeInTheDocument();
  });

  it('保存名称与备注，并可从当前项目资产中添加引用', async () => {
    renderPage();
    await screen.findByText('曹操');
    fireEvent.change(screen.getByLabelText('文件夹名称'), { target: { value: '夏日版本 V2' } });
    fireEvent.change(screen.getByLabelText('文件夹备注'), { target: { value: '第二轮整理' } });
    fireEvent.click(screen.getByRole('button', { name: '保存文件夹' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/folders/folder-summer',
      expect.objectContaining({ method: 'POST' }),
    ));

    fireEvent.click(screen.getByRole('button', { name: '添加角色 孙权' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/folders/folder-summer/items',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'character', asset_id: 'sun-quan' }),
      }),
    ));
  });

  it('移除只发引用删除；删除文件夹明确说明不会删除资产或历史', async () => {
    const { location } = renderPage();
    const cao = await screen.findByText('曹操');
    fireEvent.click(within(cao.closest('li')!).getByRole('button', { name: '从文件夹移除 曹操' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      '/api/projects/p1/folders/folder-summer/items?kind=character&asset_id=cao-cao',
      { method: 'DELETE' },
    ));

    fireEvent.click(screen.getByRole('button', { name: '删除文件夹' }));
    expect(screen.getByText('只删除文件夹和整理关系，不会删除资产或历史。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(location.history.at(-1)).toBe('/workshop/p1/overview'));
  });
});
