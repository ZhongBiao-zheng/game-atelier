import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { CanvasEditor } from './CanvasEditor';
import {
  createCanvasJob,
  getCanvasDocument,
  listCanvasJobs,
  listCanvasProjects,
  saveCanvasDocument,
} from '@/api/canvas';
import { listKeys } from '@/api/keys';
import type { Job } from '@/schema/jobs';

vi.mock('@xyflow/react', () => {
  return {
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, edges, nodes, nodeTypes, onlyRenderVisibleElements, onConnect, onEdgesChange, onNodeClick, onMoveEnd }: {
      children: React.ReactNode;
      edges: Array<{ id: string; selected?: boolean }>;
      nodes: Array<{ id: string; selected?: boolean; data: unknown }>;
      nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
      onlyRenderVisibleElements?: boolean;
      onConnect?: (connection: { source: string; target: string }) => void;
      onEdgesChange?: (changes: Array<{ id: string; type: 'select'; selected: boolean }>) => void;
      onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
      onMoveEnd?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
    }) => {
      const CanvasNode = nodeTypes?.canvasNode;
      return (
        <div data-testid="react-flow" data-node-count={nodes.length} data-visible-only={onlyRenderVisibleElements}>
          {nodes.map(node => <button type="button" key={node.id} aria-label={`flow-node-${node.id}`} onClick={event => onNodeClick?.(event, node)} />)}
          {CanvasNode && nodes.filter(node => node.selected).map(node => (
            <CanvasNode key={`view-${node.id}`} id={node.id} data={node.data} selected={true} />
          ))}
          {nodes.length > 1 && (
            <button
              type="button"
              aria-label="simulate node connection"
              onClick={() => onConnect?.({ source: nodes[0].id, target: nodes[1].id })}
            />
          )}
          {edges.length > 0 && (
            <button
              type="button"
              aria-label="simulate edge selection"
              data-edge-selected={edges[0].selected}
              onClick={() => onEdgesChange?.([{ id: edges[0].id, type: 'select', selected: true }])}
            />
          )}
          <button type="button" aria-label="simulate viewport change" onClick={() => onMoveEnd?.({}, { x: 120, y: -40, zoom: 0.7 })} />
          {children}
        </div>
      );
    },
    Background: () => null,
    Controls: () => <div data-testid="flow-controls" />,
    MiniMap: () => <div data-testid="flow-minimap" />,
    Handle: ({ type, children, ...props }: { type: 'source' | 'target'; children?: React.ReactNode; 'aria-label'?: string }) => (
      <button type="button" aria-label={props['aria-label'] ?? type}>{children}</button>
    ),
    Position: { Left: 'left', Right: 'right' },
    BackgroundVariant: { Dots: 'dots' },
  };
});

vi.mock('@/api/canvas', () => ({
  canvasMediaUrl: vi.fn(() => '/media'),
  createCanvasJob: vi.fn(),
  getCanvasDocument: vi.fn(),
  listCanvasJobs: vi.fn(),
  listCanvasProjects: vi.fn(),
  saveCanvasDocument: vi.fn(),
  uploadCanvasMedia: vi.fn(),
}));

vi.mock('@/api/keys', async importOriginal => {
  const original = await importOriginal<typeof import('@/api/keys')>();
  return { ...original, listKeys: vi.fn() };
});

const document = {
  schema_version: 1 as const,
  project_id: 'canvas-one',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [],
  connections: [],
  updated_at: '2026-08-23T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listCanvasProjects).mockResolvedValue([{
    project_id: 'canvas-one',
    name: '列车短片',
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
    cover: null,
  }]);
  vi.mocked(getCanvasDocument).mockResolvedValue(document);
  vi.mocked(listCanvasJobs).mockResolvedValue([]);
  vi.mocked(saveCanvasDocument).mockImplementation(async (_id, payload) => payload);
  vi.mocked(listKeys).mockResolvedValue({
    keys: [{
      alias: 'main', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
      capabilities: [], modalities: ['image'], notes: '', created_at: '2026-08-23T00:00:00Z',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }],
    }],
  });
});

it('loads the immersive editor and adds a manually-authored text node', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  expect(await screen.findByLabelText('画布编辑器 列车短片')).toBeInTheDocument();
  expect(screen.getByTestId('flow-minimap')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(screen.getByRole('button', { name: /文本/ }));

  expect(screen.getByText('节点设置')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '雨夜列车分镜' } });
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalled(), { timeout: 1000 });
  expect(vi.mocked(saveCanvasDocument).mock.calls.at(-1)?.[1].nodes[0]).toMatchObject({
    type: 'text',
    data: { text: '雨夜列车分镜' },
  });
});

it('flushes the latest edit before returning to the project wall', async () => {
  const onBack = vi.fn();
  render(<CanvasEditor projectId="canvas-one" onBack={onBack} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(screen.getByRole('button', { name: /文本/ }));
  fireEvent.change(screen.getByLabelText('正文'), { target: { value: '离开前最后一笔' } });

  fireEvent.click(screen.getByRole('button', { name: '返回画布项目列表' }));

  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    nodes: [expect.objectContaining({ data: expect.objectContaining({ text: '离开前最后一笔' }) })],
  }));
  expect(vi.mocked(saveCanvasDocument).mock.invocationCallOrder[0]).toBeLessThan(onBack.mock.invocationCallOrder[0]);
});

it('stays in the editor when the forced save fails', async () => {
  vi.mocked(saveCanvasDocument).mockRejectedValueOnce(new Error('disk full'));
  const onBack = vi.fn();
  render(<CanvasEditor projectId="canvas-one" onBack={onBack} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(screen.getByRole('button', { name: /文本/ }));

  fireEvent.click(screen.getByRole('button', { name: '返回画布项目列表' }));

  expect(await screen.findByText('自动保存失败，已留在当前画布。请检查服务后重试。')).toBeInTheDocument();
  expect(onBack).not.toHaveBeenCalled();
});

it('undoes a text field edit as one session snapshot', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(screen.getByRole('button', { name: /文本/ }));
  const body = screen.getByLabelText('正文');
  fireEvent.focus(body);
  fireEvent.change(body, { target: { value: '可以撤销的修改' } });

  fireEvent.click(screen.getByRole('button', { name: '撤销' }));

  expect(screen.getByLabelText('正文')).toHaveValue('');
});

it('creates one canvas job from an explicit image node', async () => {
  vi.mocked(listKeys).mockResolvedValue({
    keys: [{
      alias: 'main', provider: 'openai', base_url: 'https://api.openai-hk.com/v1', access_key: '***', secret_key: null,
      capabilities: [], modalities: ['image'], notes: '', created_at: '2026-08-23T00:00:00Z',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }],
    }],
  });
  vi.mocked(createCanvasJob).mockResolvedValue({
    job_id: 'job-one', character_id: 'main', prompt: '电影感雨夜列车',
    submitted_at: '2026-08-23T00:00:00Z', model: 'gpt-image-2', params: { n: 1 },
    output_paths: [], status: 'pending', error: null, kind: 'image', namespace: 'canvas',
    canvas_project_id: 'canvas-one', alias: 'main', provider: 'openai',
  });
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(screen.getByRole('button', { name: '图片生成' }));

  const composer = screen.getByLabelText('图片生成设置');
  expect(composer).toHaveAttribute('data-floating-node-panel', 'true');
  expect(composer.closest('article')).toBeNull();
  expect(screen.queryByText('节点设置')).not.toBeInTheDocument();
  expect(screen.queryByText(/设为参考|已参考/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('数量')).not.toBeInTheDocument();
  expect(screen.queryByText(/\d+×/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '连接到此节点' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '从此节点连接' })).toBeInTheDocument();
  expect(screen.getByText('约 ¥0.06')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('提示词'), { target: { value: '电影感雨夜列车' } });
  fireEvent.click(screen.getByRole('button', { name: '开始生成' }));

  await waitFor(() => expect(createCanvasJob).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    prompt: '电影感雨夜列车',
    model: 'gpt-image-2',
    alias: 'main',
    kind: 'image',
  })));
});

it('creates and persists a directional connection between canvas nodes', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue({
    ...document,
    nodes: [
      { id: 'source-one', type: 'text', position: { x: 0, y: 0 }, data: { title: '前置', text: '' } },
      { id: 'target-one', type: 'text', position: { x: 320, y: 0 }, data: { title: '后置', text: '' } },
    ],
  });
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate node connection' }));

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    connections: [expect.objectContaining({
      kind: 'provenance',
      source_node_id: 'source-one',
      target_node_id: 'target-one',
    })],
  })));
});

it('selects and deletes a persisted connection without deleting its nodes', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue({
    ...document,
    nodes: [
      { id: 'source-one', type: 'text', position: { x: 0, y: 0 }, data: { title: '前置', text: '' } },
      { id: 'target-one', type: 'text', position: { x: 320, y: 0 }, data: { title: '后置', text: '' } },
    ],
    connections: [{
      id: 'connection-one', kind: 'provenance', source_node_id: 'source-one', target_node_id: 'target-one',
    }],
  });
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate edge selection' }));
  expect(screen.getByRole('button', { name: 'simulate edge selection' })).toHaveAttribute('data-edge-selected', 'true');
  fireEvent.keyDown(window, { key: 'Delete' });

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    nodes: expect.arrayContaining([expect.objectContaining({ id: 'source-one' }), expect.objectContaining({ id: 'target-one' })]),
    connections: [],
  })));
});

it('hands 150 media nodes to visible-area rendering without changing the persisted shape', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue({
    ...document,
    nodes: Array.from({ length: 150 }, (_, index) => ({
      id: `resource-${index}`,
      type: 'resource' as const,
      position: { x: (index % 15) * 280, y: Math.floor(index / 15) * 200 },
      data: {
        media_kind: 'image' as const,
        path: `canvases/canvas-one/uploads/${index}.png`,
        filename: `${index}.png`,
      },
    })),
  });

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  expect(await screen.findByTestId('react-flow')).toHaveAttribute('data-node-count', '150');
  expect(screen.getByTestId('react-flow')).toHaveAttribute('data-visible-only', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-resource-149' }));
  expect(screen.getAllByText('149.png')).toHaveLength(3);
  fireEvent.click(screen.getByRole('button', { name: 'simulate viewport change' }));
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    viewport: { x: 120, y: -40, zoom: 0.7 },
  })));
});

it('keeps older video generation rounds reachable and previews video candidates as video', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue({
    ...document,
    nodes: [{
      id: 'video-one',
      type: 'generation',
      position: { x: 0, y: 0 },
      data: {
        media_kind: 'video',
        draft: { prompt: '镜头推进', model: 'video-model', alias: 'video-key', params: {} },
        job_ids: ['old-job', 'new-job'],
        active_job_id: 'new-job',
        selected_output_index: 0,
      },
    }],
  });
  vi.mocked(listCanvasJobs).mockResolvedValue([
    { job_id: 'old-job', status: 'done', output_paths: ['old.mp4'], kind: 'video' } as Job,
    { job_id: 'new-job', status: 'done', output_paths: ['a.mp4', 'b.mp4'], kind: 'video' } as Job,
  ]);

  const { container } = render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-video-one' }));

  expect(screen.getByLabelText('生成轮次')).toHaveValue('new-job');
  expect(screen.getAllByRole('option').filter(option => option.textContent?.includes('第 1 轮'))).toHaveLength(1);
  expect(container.querySelectorAll('[aria-label="选择生成结果"] video')).toHaveLength(2);
});
