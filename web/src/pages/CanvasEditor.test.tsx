import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useContext } from 'react';

import { CanvasEditor } from './CanvasEditor';
import { CanvasNodeContext } from '@/components/canvas/CanvasEditorViews';
import {
  createCanvasReversePromptConfig,
  getCanvasDocument,
  listCanvasJobs,
  listCanvasProjects,
  saveCanvasDocument,
  submitCanvasLayerDecomposition,
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
  CanvasNode,
  CanvasProject,
  CanvasProjectSummary,
  CanvasTextNode,
} from '@/schema/canvas';

vi.mock('@xyflow/react', () => {
  // 生成面板按「画布 transform」和「锚点节点自己的几何」两路重新定位，所以 mock 的 store
  // 得把这两样都提供成**真实的稳定值**：
  // - transform 必须是同一个数组引用。原来写的是 `selector({ transform: [0, 0, 1] })`，每次
  //   调用都是新数组，于是面板在测试里每次 render 都重新定位一次 —— 「拖动节点时面板不跟随」
  //   这个 bug 因此在测试里完全看不出来（注释当时写的是常量数组，代码并没有做到）。
  // - nodeLookup 用 ReactFlow 收到的 nodes 重建，位置 / 尺寸变了 useStore 才看得见。
  type MockInternalNode = {
    internals: { positionAbsolute: { x: number; y: number } };
    measured: { width?: number; height?: number };
  };
  const flowTransform: [number, number, number] = [0, 0, 1];
  let flowNodeLookup = new Map<string, MockInternalNode>();
  return {
    useStore: (selector: (state: {
      transform: [number, number, number];
      nodeLookup: Map<string, MockInternalNode>;
    }) => unknown) => selector({ transform: flowTransform, nodeLookup: flowNodeLookup }),
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, edges, nodes, nodeTypes, onlyRenderVisibleElements, multiSelectionKeyCode, selectionKeyCode, onConnect, onConnectEnd, onEdgesChange, onNodesChange, onNodeClick, onNodeMouseEnter, onMove, onMoveEnd, onDragOver, onDrop }: {
      children: React.ReactNode;
      edges: Array<{ id: string; selected?: boolean }>;
      nodes: Array<{
        id: string;
        selected?: boolean;
        data: unknown;
        position?: { x: number; y: number };
        style?: { width?: number; height?: number };
      }>;
      nodeTypes?: Record<string, React.ComponentType<Record<string, unknown>>>;
      onlyRenderVisibleElements?: boolean;
      onConnect?: (connection: { source: string; target: string; sourceHandle: null; targetHandle: null }) => void;
      onConnectEnd?: (event: MouseEvent, state: { isValid: boolean; fromNode: { id: string }; fromHandle: { type: 'source' | 'target' } }) => void;
      onEdgesChange?: (changes: Array<{ id: string; type: 'select'; selected: boolean }>) => void;
      onNodesChange?: (changes: Array<{ id: string; type: string; selected?: boolean; position?: { x: number; y: number } }>) => void;
      onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
      onNodeMouseEnter?: (event: unknown, node: { id: string }) => void;
      multiSelectionKeyCode?: string[];
      selectionKeyCode?: string[] | null;
      onMoveEnd?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
      onMove?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
      onDragOver?: (event: unknown) => void;
      onDrop?: (event: unknown) => void;
    }) => {
      const CanvasNode = nodeTypes?.canvasNode;
      if (flowEdgeIdentities[flowEdgeIdentities.length - 1] !== edges) flowEdgeIdentities.push(edges);
      flowHandlers.nodesChange = onNodesChange;
      flowNodeLookup = new Map(nodes.map(node => [node.id, {
        internals: { positionAbsolute: node.position ?? { x: 0, y: 0 } },
        measured: { width: node.style?.width, height: node.style?.height },
      }]));
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
              {nodes.map(node => (
                <button
                  key={`hover-${node.id}`}
                  type="button"
                  aria-label={`simulate hover ${node.id}`}
                  onClick={() => onNodeMouseEnter?.({}, node)}
                />
              ))}
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
          <button type="button" aria-label="simulate live zoom" onClick={() => onMove?.({}, { x: 0, y: 0, zoom: 0.42 })} />
          <CanvasContextIdentityProbe />
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
  createCanvasReversePromptConfig: vi.fn(),
  dismissCanvasCandidate: vi.fn(),
  getCanvasDocument: vi.fn(),
  listCanvasJobs: vi.fn(),
  listCanvasProjects: vi.fn(),
  renameCanvasProject: vi.fn(),
  replaceCanvasNodeMedia: vi.fn(),
  retryCanvasRun: vi.fn(),
  runCanvasMediaOperation: vi.fn(),
  saveCanvasDocument: vi.fn(),
  submitCanvasAngleRun: vi.fn(),
  submitCanvasLayerDecomposition: vi.fn(),
  submitCanvasMaskEdit: vi.fn(),
  submitCanvasReversePrompt: vi.fn(),
  submitCanvasRun: vi.fn(),
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

/** 节点卡的 memo 挡不住 context 变化：provider 的 value 换一次引用，所有订阅它的节点卡就全部
 *  重渲染一次。所以「context 换了几次引用」就是 C1 要压住的那个数。探针挂在 ReactFlow mock 的
 *  children 里，正好在 provider 内部。 */
const canvasContextIdentities: unknown[] = [];
/** 每次交给 ReactFlow 的 edges 数组换引用就记一笔——xyflow 的 EdgeWrapper 按对象引用重渲染。 */
const flowEdgeIdentities: unknown[] = [];
/** 直接拿到 ReactFlow 收到的 onNodesChange：position / remove 这类变更没有对应的 UI 入口。 */
const flowHandlers: {
  nodesChange?: (changes: Array<{ id: string; type: string; selected?: boolean; position?: { x: number; y: number } }>) => void;
} = {};

function CanvasContextIdentityProbe() {
  const value = useContext(CanvasNodeContext);
  if (canvasContextIdentities[canvasContextIdentities.length - 1] !== value) {
    canvasContextIdentities.push(value);
  }
  return null;
}

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
  canvasContextIdentities.length = 0;
  flowEdgeIdentities.length = 0;
  flowHandlers.nodesChange = undefined;
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

it('creates an editable layer-decomposition node before calling the model', async () => {
  const source = {
    ...imageNode('source-image', '源图'),
    data: { ...imageNode('source-image', '源图').data, current_version_id: 'source-version' },
  };
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [source],
    content_versions: {
      'source-version': {
        version_id: 'source-version', kind: 'image', path: 'uploads/source.png', mime_type: 'image/png',
        bytes: 42, width: 1200, height: 800, duration_ms: null,
        created_at: '2026-09-03T00:00:00Z', sha256: 'a'.repeat(64),
        origin: { kind: 'upload', upload_id: 'source-upload' },
      },
    },
  }));
  vi.mocked(listKeys).mockResolvedValue({
    keys: [{
      alias: 'tokendance', provider: 'tokendance', base_url: 'https://tokendance.space/gateway/v1',
      access_key: '***', secret_key: null, capabilities: [], modalities: ['image'], notes: '',
      created_at: '2026-09-03T00:00:00Z',
      models: [{ name: 'Seedream 5.0 Pro', id: 'seedream-5.0-pro', modality: 'image', protocol: 'ark' }],
    }],
  });

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-source-image' }));
  fireEvent.click(screen.getByRole('button', { name: '拆分 源图 的图层' }));

  expect(await screen.findByLabelText('图层拆分设置')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: '待拆分图片' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择生成模型' })).toHaveTextContent('Seedream 5.0 Pro');
  expect(submitCanvasLayerDecomposition).not.toHaveBeenCalled();
  await waitFor(() => {
    const saved = lastSavedDocument();
    const stack = saved?.nodes.find(node => node.type === 'layer_stack');
    expect(stack?.data).toMatchObject({
      source_version_id: 'source-version', alias: 'tokendance', model: 'seedream-5.0-pro',
    });
    expect(saved?.connections).toContainEqual(expect.objectContaining({
      role: 'input', source_node_id: 'source-image', target_node_id: stack?.id,
    }));
  });
});

function savedTextOf(saved: CanvasDocument | undefined, nodeId: string) {
  const node = saved?.nodes.find(candidate => candidate.id === nodeId);
  const versionId = node && node.type === 'text' ? node.data.current_version_id : null;
  const version = versionId ? saved?.content_versions[versionId] : undefined;
  return version?.kind === 'text' ? version.text : undefined;
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
  fireEvent.click(screen.getByRole('button', { name: /^flow-node-text-/ }));
  fireEvent.doubleClick(screen.getByText(/^双击输入文本/));
  const editor = await screen.findByLabelText('编辑 文本 正文');
  fireEvent.change(editor, { target: { value: body } });
  return editor;
}

it('loads the immersive editor and stores a manually-authored text node as one content version', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  const editor = await addTextNodeWithBody('雨夜列车分镜');
  fireEvent.keyDown(editor, { key: 'Tab' });

  expect(screen.getByTestId('flow-minimap')).toBeInTheDocument();
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalled(), { timeout: 1000 });
  await waitFor(() => expect(savedText(lastSavedDocument())).toBe('雨夜列车分镜'), { timeout: 1000 });
  expect(lastSavedDocument()?.nodes[0]).toMatchObject({ type: 'text', title: '文本' });
});

it('does not autosave during text editing and saves exactly once after exit', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  const editor = await addTextNodeWithBody('编辑完成后再保存');
  vi.mocked(saveCanvasDocument).mockClear();

  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  expect(saveCanvasDocument).not.toHaveBeenCalled();

  fireEvent.keyDown(editor, { key: 'Tab' });
  await waitFor(() => expect(saveCanvasDocument).toHaveBeenCalledOnce(), { timeout: 1000 });
  expect(savedText(lastSavedDocument())).toBe('编辑完成后再保存');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)); });
  expect(saveCanvasDocument).toHaveBeenCalledOnce();
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

  const editor = await addTextNodeWithBody('第一笔');
  fireEvent.keyDown(editor, { key: 'Tab' });
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

it('syncs an omni-video text reference in the connection transaction while unselected', async () => {
  const videoTarget: CanvasNode = {
    id: 'video-target',
    title: '全能参考视频',
    type: 'video',
    position: { x: 320, y: 0 },
    z_index: 0,
    data: {
      current_version_id: null,
      generation_draft: {
        mode: 'video',
        prompt: '镜头向前推进',
        input_policy: 'all_connected',
        model: 'seedance-2.0',
        alias: 'main',
        params: { frame_mode: 'auto', duration: 5, ratio: '16:9', resolution: '720p' },
        updated_at: '2026-08-28T00:00:00Z',
      },
      active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  };
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('source-one', '前置', 'version-one'), videoTarget],
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

  await waitFor(() => {
    const saved = lastSavedDocument();
    const target = saved?.nodes.find(node => node.id === videoTarget.id);
    expect(target?.type === 'video' ? target.data.generation_draft?.prompt : null)
      .toBe('镜头向前推进 @[node:source-one]');
  }, { timeout: 1000 });

  fireEvent.click(screen.getByRole('button', { name: 'simulate edge selection' }));
  fireEvent.keyDown(window, { key: 'Delete' });
  await waitFor(() => {
    const saved = lastSavedDocument();
    const target = saved?.nodes.find(node => node.id === videoTarget.id);
    expect(saved?.connections).toEqual([]);
    expect(target?.type === 'video' ? target.data.generation_draft?.prompt : null)
      .toBe('镜头向前推进 ');
  }, { timeout: 1000 });
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
  const editor = await addTextNodeWithBody('会保存失败的内容');
  fireEvent.keyDown(editor, { key: 'Tab' });

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
    nodes: [
      imageNode('empty-one', '待生成的分镜'),
      imageNode('image-one', '图片', { ...imageDraft, prompt: '继续生成后续分镜' }),
    ],
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

  const generate = await screen.findByRole('button', { name: '开始生成' });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(
    await screen.findByText('「待生成的分镜」还没有内容，先把它生成出来，或断开这条连接。'),
  ).toBeTruthy();
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
  // 兜底轮询间隔是 4s（SSE 接管了「出图完成」的通知，见下面那条用例），所以这里要等满一轮。
  await waitFor(() => expect(listCanvasJobs).toHaveBeenCalledTimes(3), { timeout: 6000 });
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

it('explains the missing-key block after the user tries to generate', async () => {
  vi.mocked(listKeys).mockResolvedValue({ keys: [] });
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', { ...imageDraft, alias: '', model: '' })],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));

  const generate = screen.getByRole('button', { name: /开始生成/ });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(await screen.findByText('还没有配置任何模型密钥。')).toBeTruthy();
});

it('offers a way in on an empty canvas and a settings entry the immersive chrome otherwise hides', async () => {
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  expect(screen.getByText('画布还是空的')).toBeTruthy();
  expect(screen.getByRole('link', { name: '设置' }).getAttribute('href')).toBe('/settings');

  fireEvent.click(screen.getByRole('button', { name: '文本节点' }));
  expect(screen.queryByText('画布还是空的')).toBeNull();
});

it('keeps the node context stable while typing and while zooming', async () => {
  // contextValue 原来把整张 content_versions 和 viewportZoom 都算进依赖：每一次按键、每一帧缩放
  // 都换一次 context 引用，而 context 变化会绕过节点卡的 memo，把所有卡一起重渲染。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [textNode('text-one', '开场白', 'version-one'), imageNode('image-one', '图片')],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '雨夜',
        created_at: '2026-08-26T00:00:00Z', sha256: 'e'.repeat(64),
        origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-text-one' }));
  fireEvent.doubleClick(await screen.findByText('雨夜'));
  const editor = await screen.findByLabelText('编辑 开场白 正文');
  // 第一次输入会给这个节点建一条本地版本，current_version_id 变了 —— 那是真的结构变化，
  // 图签名跟着失效是对的。从第二次输入开始才是纯内容变化，下面量的是这一段。
  fireEvent.change(editor, { target: { value: '雨夜列' } });

  const before = canvasContextIdentities.length;
  fireEvent.change(editor, { target: { value: '雨夜列车' } });
  fireEvent.change(editor, { target: { value: '雨夜列车进站' } });
  fireEvent.click(screen.getByRole('button', { name: 'simulate live zoom' }));

  // 文本确实写进去了，说明上面三次输入不是空转。
  fireEvent.keyDown(editor, { key: 'Tab' });
  await waitFor(() => expect(savedText(lastSavedDocument())).toBe('雨夜列车进站'), { timeout: 1500 });
  // 而且节点卡确实跟着重渲染了：resolveVersion 是常量引用，卡片的失效完全靠节点对象换引用，
  // 这条断言就是那条不变式的守卫。
  expect(await screen.findByText('雨夜列车进站')).toBeTruthy();
  expect(canvasContextIdentities.length).toBe(before);
});

it('keeps connection objects stable while typing and while hovering an unrelated node', async () => {
  // flowEdges 的依赖里有 document.nodes（连线的无障碍名称要用节点标题）和 activeNodeId（hover），
  // 所以以前每打一个字、每挪一次鼠标，全部连线都会换成新对象——xyflow 的 EdgeWrapper 是
  // useStore(s => s.edgeLookup.get(id))，默认 Object.is 比较，换对象就重画。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [
      textNode('source-one', '前置', 'version-one'),
      imageNode('target-one', '图片', imageDraft),
      textNode('loner', '旁白', 'version-two'),
    ],
    connections: [{
      id: 'connection-one', role: 'input', source_node_id: 'source-one', target_node_id: 'target-one',
    }],
    content_versions: {
      'version-one': {
        version_id: 'version-one', kind: 'text', text: '前置文本',
        created_at: '2026-08-26T00:00:00Z', sha256: 'c'.repeat(64), origin: { kind: 'user_edit' },
      },
      'version-two': {
        version_id: 'version-two', kind: 'text', text: '旁白初稿',
        created_at: '2026-08-26T00:00:00Z', sha256: 'd'.repeat(64), origin: { kind: 'user_edit' },
      },
    },
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);

  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-loner' }));
  fireEvent.doubleClick(await screen.findByText('旁白初稿'));
  const editor = await screen.findByLabelText('编辑 旁白 正文');
  // 第一次输入会给这个节点建本地版本，是真的结构变化；从第二次起才是纯内容变化。
  fireEvent.change(editor, { target: { value: '旁白一' } });

  const before = flowEdgeIdentities.length;
  fireEvent.change(editor, { target: { value: '旁白一二' } });
  fireEvent.change(editor, { target: { value: '旁白一二三' } });
  // 悬停一个不在任何连线上的节点：没有一条连线的 active 会变。
  fireEvent.click(screen.getByRole('button', { name: 'simulate hover loner' }));

  fireEvent.keyDown(editor, { key: 'Tab' });
  await waitFor(
    () => expect(savedTextOf(lastSavedDocument(), 'loner')).toBe('旁白一二三'),
    { timeout: 1500 },
  );
  expect(flowEdgeIdentities.length).toBe(before);

  // 而缓存不是冻住的：悬停到连线端点上，那条连线该换对象还是要换。
  fireEvent.click(screen.getByRole('button', { name: 'simulate hover source-one' }));
  expect(flowEdgeIdentities.length).toBe(before + 1);
});

it('applies a multi-node drag and a simultaneous delete in one pass over the document', async () => {
  // C5 把「每条 change 各扫一遍全部节点」换成先收查找表再扫一遍。复杂度本身测不出来，
  // 这条钉的是改写后的语义：多节点位移一次落定，同一批里的删除照样生效。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [
      textNode('a', '甲'),
      textNode('b', '乙'),
      textNode('c', '丙'),
    ],
    connections: [{ id: 'edge-bc', role: 'input', source_node_id: 'b', target_node_id: 'c' }],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');

  act(() => {
    flowHandlers.nodesChange?.([
      { id: 'a', type: 'position', position: { x: 40, y: 60 } },
      { id: 'b', type: 'position', position: { x: 90, y: 10 } },
      { id: 'c', type: 'remove' },
    ]);
  });

  await waitFor(() => expect(lastSavedDocument()).toBeTruthy(), { timeout: 1500 });
  const saved = lastSavedDocument()!;
  expect(saved.nodes.map(node => [node.id, node.position])).toEqual([
    ['a', { x: 40, y: 60 }],
    ['b', { x: 90, y: 10 }],
  ]);
  // 被删节点的连线要跟着走，不能留下悬空连接。
  expect(saved.connections).toEqual([]);
});

it('re-places the generation panel when the node it is anchored to moves', async () => {
  // 画师报的：点开生成面板后拖节点，面板留在原地不跟随。面板只订阅了画布 transform，
  // 而拖节点改的是节点自己的位置，定位 effect 不会重跑。
  //
  // 钉的是「节点位置变了会不会重新量锚点矩形」，不是量出来的数值：jsdom 里
  // getBoundingClientRect 恒为全 0，位置算不出真值，断言数值等于什么都测不到。
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', imageDraft)],
  }));
  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  fireEvent.click(screen.getByRole('button', { name: 'flow-node-image-one' }));
  await waitFor(() => {
    expect(document.querySelector('[data-canvas-node-panel-anchor="image-one"]')).toBeTruthy();
  });

  const shell = document.querySelector('.canvas-node-shell') as HTMLElement;
  expect(shell).toBeTruthy();
  const measure = vi.spyOn(shell, 'getBoundingClientRect');

  act(() => {
    flowHandlers.nodesChange?.([
      { id: 'image-one', type: 'position', position: { x: 620, y: 480 } },
    ]);
  });

  expect(measure).toHaveBeenCalled();
});

it('pulls canvas jobs as soon as SSE says one changed, without waiting for the next poll', async () => {
  // 画布 job 和角色 / Studio 的 job 在同一个 .runtime/jobs 目录下，watcher 早就在广播
  // job-changed，画布只是一直没订阅：以前最坏要等一整轮兜底轮询才看见出图完成。
  class TestEventSource {
    static last: TestEventSource | null = null;
    listeners = new Map<string, Array<(event: MessageEvent) => void>>();
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { TestEventSource.last = this; }
    addEventListener(type: string, callback: (event: MessageEvent) => void) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }
    close() {}
    emit(type: string, data: unknown) {
      this.listeners.get(type)?.forEach(callback => (
        callback({ data: JSON.stringify(data) } as MessageEvent)
      ));
    }
  }
  vi.stubGlobal('EventSource', TestEventSource);

  const draft: CanvasGenerationDraft = {
    mode: 'image', prompt: '雨夜', input_policy: 'mentions_only',
    model: 'gpt-image-2', alias: 'default', params: {}, updated_at: '2026-08-26T00:00:00Z',
  };
  const pending = {
    job_id: 'job-canvas-1', character_id: 'main', prompt: '雨夜',
    submitted_at: '2026-08-26T00:00:00Z', model: 'gpt-image-2', params: { n: 1 },
    output_paths: [], status: 'pending', error: null, kind: 'image', namespace: 'canvas',
    canvas_project_id: 'canvas-one', alias: 'default', provider: 'openai',
    canvas_run: {
      run_id: 'run-1',
      result_node_id: 'image-one',
      candidates: [{ candidate_id: 'run-1-0', index: 0, status: 'pending', version_id: null, error: null }],
      snapshot: {
        snapshot_version: 1, surface_node_id: 'image-one', result_node_id: 'image-one',
        mode: 'image', final_prompt: '雨夜', input_policy: 'mentions_only',
        model: 'gpt-image-2', provider: 'openai', alias: 'default', normalized_params: {},
        inputs: [], mask_version_id: null, submitted_at: '2026-08-26T00:00:00Z',
        submitted_by: { kind: 'user', actor_id: null }, request_fingerprint: 'f',
      },
    },
  } as unknown as Job;
  vi.mocked(getCanvasDocument).mockResolvedValue(documentWith({
    nodes: [imageNode('image-one', '图片', draft)],
  }));
  vi.mocked(listCanvasJobs).mockResolvedValue([pending]);

  render(<CanvasEditor projectId="canvas-one" onBack={vi.fn()} onSwitchProject={vi.fn()} />);
  await screen.findByLabelText('画布编辑器 列车短片');
  await waitFor(() => expect(listCanvasJobs).toHaveBeenCalled());
  await waitFor(() => expect(TestEventSource.last).not.toBeNull());

  const before = vi.mocked(listCanvasJobs).mock.calls.length;
  await act(async () => {
    TestEventSource.last!.emit('job-changed', { job_id: 'job-canvas-1', status: 'done' });
  });
  expect(vi.mocked(listCanvasJobs).mock.calls.length).toBe(before + 1);

  // 别的命名空间的 job（角色 / Studio 出图）也走同一条广播，画布不该跟着拉。
  await act(async () => {
    TestEventSource.last!.emit('job-changed', { job_id: 'job-character-9', status: 'done' });
  });
  expect(vi.mocked(listCanvasJobs).mock.calls.length).toBe(before + 1);

  vi.unstubAllGlobals();
});
