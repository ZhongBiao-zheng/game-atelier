import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

import { CanvasEditor } from './CanvasEditor';
import {
  createCanvasReversePromptConfig,
  getCanvasDocument,
  listCanvasJobs,
  listCanvasProjects,
  saveCanvasDocument,
  submitCanvasRun,
  uploadCanvasMedia,
} from '@/api/canvas';
import { getCanvasUiPreferences } from '@/api/canvasUi';
import { listKeys } from '@/api/keys';
import { DEFAULT_CANVAS_UI_PREFERENCES } from '@/components/canvas/canvasImageToolbar';
import type { Job } from '@/schema/jobs';
import type {
  CanvasDocument,
  CanvasGenerationDraft,
  CanvasImageNode,
  CanvasProject,
  CanvasProjectSummary,
  CanvasTextNode,
} from '@/schema/canvas';

vi.mock('@xyflow/react', () => {
  return {
    // 生成面板订阅 transform 重新定位；mock 返回常量数组，避免每次 render 换引用。
    useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
      selector({ transform: [0, 0, 1] }),
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, edges, nodes, nodeTypes, onlyRenderVisibleElements, multiSelectionKeyCode, selectionKeyCode, onConnect, onConnectEnd, onEdgesChange, onNodesChange, onNodeClick, onMoveEnd, onDragOver, onDrop }: {
      children: React.ReactNode;
      edges: Array<{ id: string; selected?: boolean }>;
      nodes: Array<{ id: string; selected?: boolean; data: unknown }>;
      nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
      onlyRenderVisibleElements?: boolean;
      onConnect?: (connection: { source: string; target: string; sourceHandle: null; targetHandle: null }) => void;
      onConnectEnd?: (event: MouseEvent, state: { isValid: boolean; fromNode: { id: string }; fromHandle: { type: 'source' | 'target' } }) => void;
      onEdgesChange?: (changes: Array<{ id: string; type: 'select'; selected: boolean }>) => void;
      onNodesChange?: (changes: Array<{ id: string; type: 'select'; selected: boolean }>) => void;
      onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
      multiSelectionKeyCode?: string[];
      selectionKeyCode?: string[] | null;
      onMoveEnd?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
      onDragOver?: (event: unknown) => void;
      onDrop?: (event: unknown) => void;
    }) => {
      const CanvasNode = nodeTypes?.canvasNode;
      return (
        <div data-testid="react-flow" data-node-count={nodes.length} data-visible-only={onlyRenderVisibleElements} data-multi-select-keys={(multiSelectionKeyCode ?? []).join(',')} data-selection-key={selectionKeyCode === null ? 'none' : String(selectionKeyCode)}>
          {nodes.map(node => (
            <button
              type="button"
              key={node.id}
              aria-label={`flow-node-${node.id}`}
              onClick={event => {
                // 复刻 xyflow 的真实顺序：handleNodeClick 先按 multiSelectionKeyCode 更新选择集，
                // 之后才轮到 onNodeClick。B2 的 bug 就藏在这个顺序里。
                if (event.shiftKey || event.metaKey || event.ctrlKey) {
                  onNodesChange?.([{ id: node.id, type: 'select', selected: !node.selected }]);
                }
                onNodeClick?.(event, node);
              }}
            />
          ))}
          {CanvasNode && nodes.filter(node => node.selected).map(node => (
            <CanvasNode key={`view-${node.id}`} id={node.id} data={node.data} selected={true} />
          ))}
          {nodes.length > 1 && (
            <button
              type="button"
              aria-label="simulate node connection"
              onClick={() => onConnect?.({ source: nodes[0].id, target: nodes[1].id, sourceHandle: null, targetHandle: null })}
            />
          )}
          {nodes.length > 0 && (
            <>
              <button
                type="button"
                aria-label="simulate blank connection"
                onClick={() => onConnectEnd?.(
                  new MouseEvent('mouseup', { clientX: 480, clientY: 320 }),
                  { isValid: false, fromNode: { id: nodes[0].id }, fromHandle: { type: 'source' } },
                )}
              />
              <button
                type="button"
                aria-label="simulate blank target connection"
                onClick={() => onConnectEnd?.(
                  new MouseEvent('mouseup', { clientX: 520, clientY: 360 }),
                  { isValid: false, fromNode: { id: nodes[0].id }, fromHandle: { type: 'target' } },
                )}
              />
              <button
                type="button"
                aria-label="simulate node select"
                onClick={() => onNodesChange?.([{ id: nodes[0].id, type: 'select', selected: true }])}
              />
            </>
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
          <button
            type="button"
            aria-label="simulate file drop"
            onClick={event => {
              let overPrevented = false;
              let dropPrevented = false;
              const dataTransfer = {
                files: [new File(['x'], 'shot.png', { type: 'image/png' })],
                types: ['Files'],
                getData: () => '',
                dropEffect: '',
              };
              onDragOver?.({ dataTransfer, preventDefault: () => { overPrevented = true; } });
              onDrop?.({ dataTransfer, clientX: 200, clientY: 160, preventDefault: () => { dropPrevented = true; } });
              event.currentTarget.dataset.overPrevented = String(overPrevented);
              event.currentTarget.dataset.dropPrevented = String(dropPrevented);
            }}
          />
          {children}
        </div>
      );
    },
    useReactFlow: () => ({
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      fitView: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      getZoom: () => 1,
      setCenter: vi.fn(),
      setViewport: vi.fn(),
      zoomIn: vi.fn(),
      zoomOut: vi.fn(),
      zoomTo: vi.fn(),
    }),
    Background: ({ variant }: { variant: string }) => <div data-testid="flow-background" data-variant={variant} />,
    MiniMap: () => <div data-testid="flow-minimap" />,
    NodeResizer: ({ isVisible, maxWidth, maxHeight, onResizeStart, onResizeEnd }: {
      isVisible: boolean;
      maxWidth?: number;
      maxHeight?: number;
      onResizeStart?: (event: unknown, params: unknown) => void;
      onResizeEnd?: (event: unknown, params: { x: number; y: number; width: number; height: number }) => void;
    }) => isVisible ? (
      <>
        <button
          type="button"
          aria-label="simulate node resize"
          data-max-width={maxWidth}
          data-max-height={maxHeight}
          onClick={() => {
            onResizeStart?.({}, {});
            onResizeEnd?.({}, { x: 0, y: 0, width: 420, height: 260 });
          }}
        />
        <button
          type="button"
          aria-label="simulate oversize node resize"
          onClick={() => {
            onResizeStart?.({}, {});
            onResizeEnd?.({}, { x: 0, y: 0, width: 9000, height: 260 });
          }}
        />
      </>
    ) : null,
    NodeToolbar: ({ children, isVisible, ...props }: {
      children?: React.ReactNode;
      isVisible?: boolean;
    } & React.HTMLAttributes<HTMLDivElement>) => isVisible ? <div {...props}>{children}</div> : null,
    Handle: ({ type, children, ...props }: { type: 'source' | 'target'; children?: React.ReactNode; 'aria-label'?: string }) => (
      <button type="button" aria-label={props['aria-label'] ?? type}>{children}</button>
    ),
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
    SelectionMode: { Partial: 'partial', Full: 'full' },
    BackgroundVariant: { Dots: 'dots', Lines: 'lines' },
  };
});

vi.mock('@/api/canvas', () => ({
  canvasDownloadUrl: vi.fn(() => '/download'),
  canvasMediaUrl: vi.fn(() => '/media'),
  cancelCanvasRun: vi.fn(),
  createCanvasPrompt: vi.fn(),
  createCanvasReversePromptConfig: vi.fn(),
  deleteCanvasAsset: vi.fn(),
  deleteCanvasPrompt: vi.fn(),
  dismissCanvasCandidate: vi.fn(),
  getCanvasAssets: vi.fn(),
  getCanvasDocument: vi.fn(),
  getCanvasPrompts: vi.fn(),
  insertCanvasAsset: vi.fn(),
  insertCanvasPrompt: vi.fn(),
  listCanvasJobs: vi.fn(),
  listCanvasProjects: vi.fn(),
  renameCanvasProject: vi.fn(),
  replaceCanvasNodeMedia: vi.fn(),
  retryCanvasRun: vi.fn(),
  runCanvasMediaOperation: vi.fn(),
  saveCanvasAsset: vi.fn(),
  saveCanvasDocument: vi.fn(),
  submitCanvasAngleRun: vi.fn(),
  submitCanvasMaskEdit: vi.fn(),
  submitCanvasReversePrompt: vi.fn(),
  submitCanvasRun: vi.fn(),
  updateCanvasAsset: vi.fn(),
  updateCanvasPrompt: vi.fn(),
  uploadCanvasMedia: vi.fn(),
}));

vi.mock('@/api/canvasUi', () => ({
  getCanvasUiPreferences: vi.fn(),
  saveCanvasUiPreferences: vi.fn(),
}));

vi.mock('@/api/keys', async importOriginal => {
  const original = await importOriginal<typeof import('@/api/keys')>();
  return { ...original, listKeys: vi.fn() };
});

const imageDraft: CanvasGenerationDraft = {
  mode: 'image',
  prompt: '',
  input_policy: 'all_connected',
  model: 'gpt-image-2',
  alias: 'main',
  params: { n: 1, ratio: '1:1', quality: 'low', size: '2048x2048' },
  updated_at: '2026-08-26T00:00:00Z',
};

function textNode(id: string, title: string, versionId: string | null = null): CanvasTextNode {
  return {
    id,
    title,
    type: 'text',
    position: { x: 0, y: 0 },
    z_index: 0,
    data: {
      current_version_id: versionId,
      generation_draft: null,
      active_run_id: null,
      display: { scale: 'sm' },
    },
  };
}

function imageNode(id: string, title: string, draft: CanvasGenerationDraft | null = null): CanvasImageNode {
  return {
    id,
    title,
    type: 'image',
    position: { x: 320, y: 0 },
    z_index: 0,
    data: {
      current_version_id: null,
      generation_draft: draft,
      active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  };
}

const emptyDocument: CanvasDocument = {
  schema_version: 2,
  project_id: 'canvas-one',
  revision: 7,
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { background: 'none', show_image_info: true, show_minimap: true },
  nodes: [],
  connections: [],
  content_versions: {},
  updated_at: '2026-08-26T00:00:00Z',
};

function documentWith(overrides: Partial<CanvasDocument>): CanvasDocument {
  return { ...emptyDocument, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom 不实现 elementFromPoint，而连接拖到空白处要用它探测落点节点。
  document.elementFromPoint = () => null;
  // 编辑器只调 listCanvasProjects(true)（轻量分支，返回 CanvasProject[]）；
  // vi.mocked 取的是重载最后一条 CanvasProjectSummary[]，故此处显式转回轻量形状。
  vi.mocked(listCanvasProjects).mockResolvedValue([{
    schema_version: 2,
    project_id: 'canvas-one',
    name: '列车短片',
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
  } satisfies CanvasProject] as unknown as CanvasProjectSummary[]);
  vi.mocked(getCanvasDocument).mockResolvedValue(emptyDocument);
  vi.mocked(listCanvasJobs).mockResolvedValue([]);
  vi.mocked(getCanvasUiPreferences).mockResolvedValue(DEFAULT_CANVAS_UI_PREFERENCES);
  vi.mocked(saveCanvasDocument).mockImplementation(async (_id, payload) => payload);
  vi.mocked(listKeys).mockResolvedValue({
    keys: [{
      alias: 'main', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
      capabilities: [], modalities: ['image'], notes: '', created_at: '2026-08-23T00:00:00Z',
      models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' }],
    }],
  });
});

function lastSavedDocument() {
  return vi.mocked(saveCanvasDocument).mock.calls.at(-1)?.[1];
}

function savedText(saved: CanvasDocument | undefined) {
  const node = saved?.nodes[0];
  const versionId = node && node.type === 'text' ? node.data.current_version_id : null;
  const version = versionId ? saved?.content_versions[versionId] : undefined;
  return version?.kind === 'text' ? version.text : undefined;
}

async function addTextNodeWithBody(body: string) {
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(within(screen.getByRole('menu', { name: '添加节点' })).getByRole('menuitem', { name: /^文本/ }));
  fireEvent.doubleClick(screen.getByText(/^双击输入文本/));
  const editor = await screen.findByLabelText('编辑 文本 正文');
  fireEvent.change(editor, { target: { value: body } });
  return editor;
}

it('loads the immersive editor and stores a manually-authored text node as one content version', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await addTextNodeWithBody('雨夜列车分镜');

  expect(screen.getByTestId('flow-minimap')).toBeInTheDocument();
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalled(), { timeout: 1000 });
  await waitFor(() => expect(savedText(lastSavedDocument())).toBe('雨夜列车分镜'), { timeout: 1000 });
  expect(lastSavedDocument()?.nodes[0]).toMatchObject({ type: 'text', title: '文本' });
});

it('keeps the server-owned content hash when typing continues during a save', async () => {
  // 服务端拥有 sha256：它把前端的占位值改写成真实摘要，并把「已存在版本的任何差异」
  // 当致命错误（422 existing canvas content versions are immutable）。保存在途中继续打字
  // 会留下一份带占位值的本地快照，一旦它盖住服务端真值，之后每次保存都被拒绝且无法自愈。
  const serverSha = 'a'.repeat(64);
  let releaseFirstSave = () => undefined as void;
  const firstSaveHeld = new Promise<void>(resolve => { releaseFirstSave = resolve; });
  let saveCount = 0;
  vi.mocked(saveCanvasDocument).mockImplementation(async (_id, payload) => {
    saveCount += 1;
    if (saveCount === 1) await firstSaveHeld;
    return {
      ...payload,
      revision: payload.revision + 1,
      content_versions: Object.fromEntries(
        Object.entries(payload.content_versions).map(([versionId, version]) => [
          versionId,
          version.kind === 'text' ? { ...version, sha256: serverSha } : version,
        ]),
      ),
    };
  });
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await addTextNodeWithBody('第一笔');
  await waitFor(() => expect(saveCount).toBe(1), { timeout: 1000 });
  const firstPayload = vi.mocked(saveCanvasDocument).mock.calls[0][1];
  const versionId = firstPayload.nodes[0].type === 'text'
    ? firstPayload.nodes[0].data.current_version_id
    : null;
  expect(versionId).toBeTruthy();

  // 第一次保存还在飞，画师又改了一笔：排队的快照就此带着占位 sha256。
  fireEvent.click(screen.getByRole('button', { name: '增大 文本 字号' }));
  releaseFirstSave();

  await waitFor(
    () => expect(vi.mocked(saveCanvasDocument).mock.calls.length).toBeGreaterThan(1),
    { timeout: 1000 },
  );
  const resubmitted = lastSavedDocument()!.content_versions[versionId!];
  expect(resubmitted.sha256).toBe(serverSha);
});

it('flushes the latest edit before returning to the project wall', async () => {
  const onBack = vi.fn();
  render(<CanvasEditor projectId="canvas-one" onBack={onBack} onSwitchProject={vi.fn()} />);
  await addTextNodeWithBody('离开前最后一笔');

  fireEvent.click(screen.getByRole('button', { name: '返回画布项目列表' }));

  await waitFor(() => expect(onBack).toHaveBeenCalled());
  expect(savedText(lastSavedDocument())).toBe('离开前最后一笔');
  expect(vi.mocked(saveCanvasDocument).mock.invocationCallOrder[0])
    .toBeLessThan(onBack.mock.invocationCallOrder[0]);
});

it('stays in the editor when the forced save fails', async () => {
  vi.mocked(saveCanvasDocument).mockRejectedValue(new Error('disk full'));
  const onBack = vi.fn();
  render(<CanvasEditor projectId="canvas-one" onBack={onBack} onSwitchProject={vi.fn()} />);
  await addTextNodeWithBody('保存不了的一笔');

  fireEvent.click(screen.getByRole('button', { name: '返回画布项目列表' }));

  expect(await screen.findByText('自动保存失败，已留在当前画布。请检查服务后重试。')).toBeInTheDocument();
  expect(onBack).not.toHaveBeenCalled();
});

it('undoes a text field edit as one session snapshot', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  const editor = await addTextNodeWithBody('可以撤销的修改');
  expect(editor).toHaveValue('可以撤销的修改');

  fireEvent.click(screen.getByRole('button', { name: '撤销' }));

  expect(screen.getByLabelText('编辑 文本 正文')).toHaveValue('');
});

it('undoes adding a node back to the loaded canvas', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: '添加节点' }));
  fireEvent.click(within(screen.getByRole('menu', { name: '添加节点' })).getByRole('menuitem', { name: /^图片/ }));
  expect(screen.getByTestId('react-flow')).toHaveAttribute('data-node-count', '1');

  fireEvent.click(screen.getByRole('button', { name: '撤销' }));

  expect(screen.getByTestId('react-flow')).toHaveAttribute('data-node-count', '0');
  await waitFor(() => expect(lastSavedDocument()?.nodes).toEqual([]), { timeout: 1000 });
});

it('submits one canvas run for the selected image node at the current server revision', async () => {
  const draft = { ...imageDraft, prompt: '电影感雨夜列车', params: { ...imageDraft.params, n: 2 } };
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', draft)],
  }));
  vi.mocked(submitCanvasRun).mockResolvedValue({
    job: {
      job_id: 'job-one', character_id: 'main', prompt: '电影感雨夜列车',
      submitted_at: '2026-08-26T00:00:00Z', model: 'gpt-image-2', params: { n: 2 },
      output_paths: [], status: 'pending', error: null, kind: 'image', namespace: 'canvas',
      canvas_project_id: 'canvas-one', alias: 'main', provider: 'openai',
    },
    document: documentWith({ nodes: [imageNode('image-one', '图片', draft)], revision: 8 }),
  });
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));
  fireEvent.click(await screen.findByRole('button', { name: '开始生成' }));

  await waitFor(() => expect(submitCanvasRun).toHaveBeenCalledWith('canvas-one', 'image-one', 7, 2));
});

it('creates and persists a directional input connection between canvas nodes', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('source-one', '前置', 'version-one'), imageNode('target-one', '图片', imageDraft)],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '前置文本',
        created_at: '2026-08-26T00:00:00Z', sha256: 'a'.repeat(64), origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate node connection' }));

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    connections: [expect.objectContaining({
      role: 'input',
      source_node_id: 'source-one',
      target_node_id: 'target-one',
    })],
  })));
});

it('creates a node and input connection when a source handle is dragged to blank canvas', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('source-one', '前置', 'version-one')],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '前置文本',
        created_at: '2026-08-26T00:00:00Z', sha256: 'a'.repeat(64), origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate blank connection' }));
  const menu = screen.getByRole('menu', { name: '连接创建节点' });
  expect(within(menu).queryByRole('menuitem', { name: /上传素材/ })).not.toBeInTheDocument();
  fireEvent.click(within(menu).getByRole('menuitem', { name: /^图片/ }));

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    nodes: expect.arrayContaining([
      expect.objectContaining({ id: 'source-one' }),
      expect.objectContaining({ type: 'image', position: { x: 480, y: 320 } }),
    ]),
    connections: [expect.objectContaining({
      role: 'input',
      source_node_id: 'source-one',
      target_node_id: expect.stringMatching(/^image-/),
    })],
  })));
});

it('offers only content sources when a target handle is dragged to blank canvas', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('target-one', '图片', imageDraft)],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate blank target connection' }));

  // 目标端手柄要的是内容来源：空生成节点与生成配置都填不进去，只留上传素材。
  const menu = screen.getByRole('menu', { name: '连接创建节点' });
  expect(within(menu).getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    expect.stringContaining('上传素材'),
  ]);
});

it('persists resized node dimensions from the Atelier resize chrome', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('resizable-one', '可缩放', 'version-one')],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '可缩放文本',
        created_at: '2026-08-26T00:00:00Z', sha256: 'b'.repeat(64), origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-resizable-one' }));
  fireEvent.click(await screen.findByRole('button', { name: 'simulate node resize' }));

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    nodes: [expect.objectContaining({ size: { width: 420, height: 260 } })],
  })));
});

it('renders the persisted canvas background setting and nothing for a blank canvas', async () => {
  const { unmount } = render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  expect(screen.queryByTestId('flow-background')).not.toBeInTheDocument();
  unmount();

  for (const [background, variant] of [['dots', 'dots'], ['lines', 'lines']] as const) {
    vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
      settings: { ...emptyDocument.settings, background },
    }));
    const view = render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
    await screen.findByLabelText('画布编辑器 列车短片');
    expect(screen.getByTestId('flow-background')).toHaveAttribute('data-variant', variant);
    view.unmount();
  }
});

it('selects and deletes a persisted connection without deleting its nodes', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('source-one', '前置', 'version-one'), imageNode('target-one', '图片', imageDraft)],
    connections: [{
      id: 'connection-one', role: 'input', source_node_id: 'source-one', target_node_id: 'target-one',
    }],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '前置文本',
        created_at: '2026-08-26T00:00:00Z', sha256: 'c'.repeat(64), origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate edge selection' }));
  expect(screen.getByRole('button', { name: 'simulate edge selection' })).toHaveAttribute('data-edge-selected', 'true');
  fireEvent.keyDown(window, { key: 'Delete' });

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    nodes: expect.arrayContaining([
      expect.objectContaining({ id: 'source-one' }),
      expect.objectContaining({ id: 'target-one' }),
    ]),
    connections: [],
  })));
});

it('hands 150 media nodes to visible-area rendering and persists the viewport', async () => {
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: Array.from({ length: 150 }, (_, index) => ({
      ...imageNode(`image-${index}`, `${index}.png`),
      position: { x: (index % 15) * 280, y: Math.floor(index / 15) * 200 },
    })),
  }));

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  expect(await screen.findByTestId('react-flow')).toHaveAttribute('data-node-count', '150');
  expect(screen.getByTestId('react-flow')).toHaveAttribute('data-visible-only', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'simulate viewport change' }));
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    viewport: { x: 120, y: -40, zoom: 0.7 },
  })));
});

it('refuses to delete a node while its generation is still running', async () => {
  const running: CanvasImageNode = {
    ...imageNode('image-1', '雨夜列车', imageDraft),
    data: { ...imageNode('image-1', '雨夜列车').data, active_run_id: 'run-1' },
  };
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({ nodes: [running] }));

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate node select' }));
  fireEvent.keyDown(window, { key: 'Delete' });

  expect(await screen.findByText('「雨夜列车」正在生成，结束后才能删除。')).toBeTruthy();
  // 节点还在：厂商调用已计费，删掉它会让产物永远挂不回画布。
  expect(screen.getByTestId('react-flow').getAttribute('data-node-count')).toBe('1');
});

it('flushes the queued save when the editor unmounts before the debounce fires', async () => {
  const { unmount } = render(
    <CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />,
  );
  await addTextNodeWithBody('卸载前还没落盘的分镜');
  vi.mocked(saveCanvasDocument).mockClear();

  // 350ms 防抖还没到，卸载会 clearTimeout —— 没有冲刷的话这次编辑就消失了。
  unmount();

  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalled(), { timeout: 1000 });
  expect(savedText(lastSavedDocument())).toBe('卸载前还没落盘的分镜');
});

it('keeps a dropped file inside the app and uploads it to the canvas', async () => {
  vi.mocked(uploadCanvasMedia).mockResolvedValue({
    version: {
      version_id: 'version-upload',
      kind: 'image',
      created_at: '2026-08-26T00:00:00Z',
      sha256: 'b'.repeat(64),
      origin: { kind: 'upload', upload_id: 'upload-1' },
      path: 'uploads/shot.png',
      mime_type: 'image/png',
      bytes: 1,
      width: 8,
      height: 8,
    },
    document: { ...emptyDocument, revision: 8 },
    filename: 'shot.png',
  });

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  const drop = screen.getByRole('button', { name: 'simulate file drop' });
  fireEvent.click(drop);

  // 两个 preventDefault 都必须发生：dragover 不拦 drop 就不派发，浏览器直接导航到那个文件。
  expect(drop.dataset.overPrevented).toBe('true');
  expect(drop.dataset.dropPrevented).toBe('true');
  await waitFor(() => expect(uploadCanvasMedia).toHaveBeenCalled());
});

it('clamps an oversized node resize instead of letting every later save 422', async () => {
  // 后端 CanvasSize 是 le=4000。拖过界的那一次保存返回 422，失败快照被重新入队，
  // 之后每一次编辑都不落盘 —— 而界面只说「保存冲突，内容已保留」。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片')],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'simulate node select' }));

  const resizer = await screen.findByRole('button', { name: 'simulate node resize' });
  expect(resizer).toHaveAttribute('data-max-width', '4000');
  expect(resizer).toHaveAttribute('data-max-height', '4000');
  fireEvent.click(screen.getByRole('button', { name: 'simulate oversize node resize' }));

  await waitFor(
    () => expect(lastSavedDocument()?.nodes[0].size).toEqual({ width: 4000, height: 260 }),
    { timeout: 1000 },
  );
});

it('surfaces the server detail when an automatic save fails instead of claiming the content is safe', async () => {
  vi.mocked(saveCanvasDocument).mockRejectedValue(
    new Error('existing canvas content versions are immutable（HTTP 422）'),
  );
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await addTextNodeWithBody('会保存失败的内容');

  expect(await screen.findByRole('button', { name: '保存失败 · 重试' })).toBeTruthy();
  expect(
    await screen.findByText('existing canvas content versions are immutable（HTTP 422）'),
  ).toBeTruthy();
  expect(screen.queryByText('保存冲突，内容已保留')).toBeNull();
});

it('keeps panning out of the undo stack so Ctrl+Z still undoes the last edit', async () => {
  // 平移以前每次都 push 一条历史：撤销撤的是镜头，而且平移够多次时真正想撤的那次编辑
  // 已经被 50 条上限挤出去了。
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();

  fireEvent.click(screen.getByRole('button', { name: 'simulate viewport change' }));
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledWith('canvas-one', expect.objectContaining({
    viewport: { x: 120, y: -40, zoom: 0.7 },
  })), { timeout: 1000 });

  expect(screen.getByRole('button', { name: '撤销' })).toBeDisabled();
});

it('blocks generation by name when a connected input has no content yet', async () => {
  // 「先连线，后逐个生成」是最自然的用法，而服务端在 all_connected 下把空输入整单拒绝。
  // 用空图片节点当来源：空文本节点在加载时会被 materializeEmptyTextContent 补上一个空版本，
  // 本来就不缺内容。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('empty-one', '待生成的分镜'), imageNode('image-one', '图片', imageDraft)],
    connections: [{
      id: 'connection-one',
      role: 'input',
      source_node_id: 'empty-one',
      target_node_id: 'image-one',
    }],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));

  expect(
    await screen.findByText('「待生成的分镜」还没有内容，先把它生成出来，或断开这条连接。'),
  ).toBeTruthy();
  expect(await screen.findByRole('button', { name: '开始生成' })).toBeDisabled();
});

it('accepts a first-frame pick on a config node whose draft is a video generation', async () => {
  // 面板按 draft.mode 决定要不要给首尾帧控件，处理函数以前按 node.type 收窄：配置节点的
  // mode 是 video 但 type 是 config，于是控件显示、点了没反应。
  const videoDraft: CanvasGenerationDraft = {
    mode: 'video',
    prompt: '列车穿过隧道',
    input_policy: 'all_connected',
    model: 'seedance-2.0',
    alias: 'video',
    params: { frame_mode: 'firstlast', duration: 5, resolution: '720p', ratio: '16:9' },
    updated_at: '2026-08-27T00:00:00Z',
  };
  vi.mocked(listKeys).mockResolvedValue({
    keys: [{
      alias: 'video', provider: 'volces', base_url: null, access_key: '***', secret_key: null,
      capabilities: [], modalities: ['video'], notes: '', created_at: '2026-08-23T00:00:00Z',
      models: [{ id: 'seedance-2.0', name: 'Seedance 2.0', modality: 'video', protocol: 'seedance' }],
    }],
  });
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [
      {
        id: 'config-one',
        title: '视频设置',
        type: 'config',
        position: { x: 0, y: 0 },
        z_index: 0,
        data: { draft: videoDraft },
      },
      { ...imageNode('frame-one', '起始帧'), data: { ...imageNode('frame-one', '起始帧').data, current_version_id: 'version-frame' } },
    ],
    content_versions: {
      'version-frame': {
        version_id: 'version-frame', kind: 'image', path: 'canvas-one/media/frame.png',
        mime_type: 'image/png', bytes: 2048, width: 1024, height: 1024,
        created_at: '2026-08-26T00:00:00Z', sha256: 'c'.repeat(64), origin: { kind: 'upload', upload_id: 'upload-1' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-config-one' }));
  fireEvent.click(await screen.findByRole('button', { name: '在画布选择首帧' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-frame-one' }));

  expect(screen.queryByText('只有视频生成节点可以设置首尾帧。')).toBeNull();
  await waitFor(() => expect(lastSavedDocument()?.connections).toEqual([
    expect.objectContaining({
      role: 'input',
      source_node_id: 'frame-one',
      target_node_id: 'config-one',
      slot: 'first_frame',
    }),
  ]), { timeout: 1000 });
});

it('keeps a just-submitted job that an in-flight poll response predates', async () => {
  // 轮询以前整体赋值。请求发出到响应落地之间还夹着一次 getCanvasDocument，窗口足够跨过一次提交：
  // 刚提交的 pending job 被抹掉 → hasRunningJobs 为假 → 轮询自己卸载 → 节点永远停在旧状态。
  function canvasJob(jobId: string, runId: string, resultNodeId: string): Job {
    return {
      job_id: jobId, character_id: 'main', prompt: '电影感雨夜列车',
      submitted_at: '2026-08-26T00:00:00Z', model: 'gpt-image-2', params: { n: 1 },
      output_paths: [], status: 'pending', error: null, kind: 'image', namespace: 'canvas',
      canvas_project_id: 'canvas-one', alias: 'main', provider: 'openai',
      canvas_run: {
        run_id: runId,
        result_node_id: resultNodeId,
        candidates: [{ candidate_id: `${runId}-0`, index: 0, status: 'pending', version_id: null, error: null }],
        snapshot: {
          snapshot_version: 1, surface_node_id: resultNodeId, result_node_id: resultNodeId,
          mode: 'image', final_prompt: '电影感雨夜列车', input_policy: 'all_connected',
          model: 'gpt-image-2', provider: 'openai', alias: 'main', normalized_params: {},
          inputs: [], mask_version_id: null, submitted_at: '2026-08-26T00:00:00Z',
          submitted_by: { kind: 'user', actor_id: null }, request_fingerprint: 'f',
        },
      },
    } as unknown as Job;
  }
  const other = canvasJob('job-other', 'run-other', 'other-one');
  const submitted = canvasJob('job-new', 'run-new', 'image-one');
  const draft = { ...imageDraft, prompt: '电影感雨夜列车' };
  const running: CanvasImageNode = {
    ...imageNode('image-one', '图片', draft),
    data: { ...imageNode('image-one', '图片', draft).data, active_run_id: 'run-new' },
  };
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', draft)],
  }));

  let releasePoll = () => undefined as void;
  const pollHeld = new Promise<void>(resolve => { releasePoll = resolve; });
  let listCalls = 0;
  vi.mocked(listCanvasJobs).mockImplementation(async () => {
    listCalls += 1;
    if (listCalls === 1) return [other];
    // 第二次是轮询，它在提交之前发出：响应里既没有新 job，原来那条也已经结束了。
    // 整体赋值会让 jobs 变空 → hasRunningJobs 为假 → 轮询 effect 卸载 → 不会再有第三次。
    if (listCalls === 2) {
      await pollHeld;
      return [];
    }
    return [submitted];
  });
  vi.mocked(submitCanvasRun).mockResolvedValue({
    job: submitted,
    document: documentWith({ nodes: [running], revision: 8 }),
  });

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));
  fireEvent.click(await screen.findByRole('button', { name: '开始生成' }));
  await waitFor(() => expect(submitCanvasRun).toHaveBeenCalled());

  releasePoll();

  // 第三次轮询本身就是断言：只有新提交的 job 活了下来，轮询才会继续。
  await waitFor(() => expect(listCanvasJobs).toHaveBeenCalledTimes(3), { timeout: 2500 });
  await waitFor(() => expect(
    document.querySelector('[data-canvas-node-status-label="loading"]'),
  ).not.toBeNull(), { timeout: 1000 });
});

it('appends to the selection on a modifier click instead of collapsing it to one node', async () => {
  // 快捷键面板一直写着「Shift / ⌘ 点击追加选择节点」，但 onNodeClick 无条件调 selectOnlyNode，
  // 把 xyflow 刚并进来的那一次点击立刻打平成单选。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('text-one', '开场白'), imageNode('image-one', '图片')],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  expect(screen.getByTestId('react-flow').dataset.multiSelectKeys).toBe('Shift,Meta,Control');
  // Shift 必须同时从 selectionKeyCode 上摘掉：xyflow 的 Pane 在按住 selectionKey 时会用
  // onPointerDownCapture 吞掉落在节点上的 pointerdown 去起框选，节点永远收不到这次点击。
  expect(screen.getByTestId('react-flow').dataset.selectionKey).toBe('none');

  fireEvent.click(screen.getByRole('button', { name: 'flow-node-text-one' }));
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }), { shiftKey: true });

  expect(await screen.findByRole('toolbar', { name: '已选择 2 个节点' })).toBeTruthy();
});

it('leaves a reverse-prompt config node deleted instead of recreating it on the next load', async () => {
  // 自动创建的判据原来是「这个结果节点上还没挂配置」。删掉配置节点后一刷新判据又成立，
  // 节点自己长回来；打开一个有历史反推记录的项目同样会凭空长出配置节点。
  const reverseJob = {
    job_id: 'job-reverse', character_id: 'main', prompt: '反推',
    submitted_at: '2026-08-26T00:00:00Z', model: 'gpt-5', params: { n: 1 },
    output_paths: [], status: 'done', error: null, kind: 'text', namespace: 'canvas',
    canvas_project_id: 'canvas-one', alias: 'main', provider: 'openai',
    canvas_run: {
      run_id: 'run-reverse',
      result_node_id: 'text-reverse',
      candidates: [{
        candidate_id: 'run-reverse-0', index: 0, status: 'succeeded',
        version_id: 'version-reverse', error: null,
      }],
      snapshot: {
        snapshot_version: 1, surface_node_id: 'image-one', result_node_id: 'text-reverse',
        mode: 'text', final_prompt: '反推', input_policy: 'mentions_only',
        model: 'gpt-5', provider: 'openai', alias: 'main',
        normalized_params: { preset_id: 'canvas.reverse_prompt', preset_version: 1 },
        inputs: [], mask_version_id: null, submitted_at: '2026-08-26T00:00:00Z',
        submitted_by: { kind: 'user', actor_id: null }, request_fingerprint: 'f',
      },
    },
  } as unknown as Job;
  vi.mocked(listCanvasJobs).mockResolvedValue([reverseJob]);
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('text-reverse', '反推提示词', 'version-reverse')],
    content_versions: {
      'version-reverse': {
        version_id: 'version-reverse', kind: 'text', text: '雨夜列车',
        created_at: '2026-08-26T00:00:00Z', sha256: 'd'.repeat(64),
        origin: { kind: 'job_output', job_id: 'job-reverse', candidate_id: 'run-reverse-0' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  // 给自动创建 effect 留出跑完的时间；它命中时会调 createCanvasReversePromptConfig。
  await waitFor(() => expect(listCanvasJobs).toHaveBeenCalled());
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(createCanvasReversePromptConfig).not.toHaveBeenCalled();
});

it('explains why the generate button is disabled when no configured key can do the job', async () => {
  // 五个禁用条件里，缺模型 / 缺密钥这两条原来一句解释都没有，沉浸式画布又把设置入口整块藏了。
  vi.mocked(listKeys).mockResolvedValue({ keys: [] });
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', { ...imageDraft, alias: '', model: '' })],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));

  const hint = await screen.findByText(/还没有配置任何模型密钥/);
  expect(within(hint).getByRole('link', { name: '去设置里添加' }).getAttribute('href')).toBe('/settings');
  expect(screen.getByRole('button', { name: /开始生成/ }).hasAttribute('disabled')).toBe(true);
});

it('offers a way in on an empty canvas and a settings entry the immersive chrome otherwise hides', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  expect(screen.getByText('画布还是空的')).toBeTruthy();
  expect(screen.getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/settings');

  fireEvent.click(screen.getByRole('button', { name: '文本节点' }));
  expect(screen.queryByText('画布还是空的')).toBeNull();
});
