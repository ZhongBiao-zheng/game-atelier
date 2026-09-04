import type { CanvasContentVersion } from '@/schema/canvas';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';

import {
  CanvasNodeCard,
  CanvasNodeContext,
  CanvasMobileGenerationPanel,
  placeCanvasGenerationPanel,
  type CanvasNodeContextValue,
} from './CanvasEditorViews';
import { DEFAULT_CANVAS_UI_PREFERENCES } from './canvasImageToolbar';
import {
  generationPanelDismissalAfterNodeSelection,
  isUploadedImageMaterialNode,
  restoreCanvasNodeFocus,
} from './canvasNodePanelInteraction';
import type { CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';


/** context 里已经不再是版本表而是解析器（见 CanvasEditor 里 resolveVersion 的说明），
 *  测试仍然用字面量声明版本，这里包一层。 */
function versionResolver(versions: Readonly<Record<string, CanvasContentVersion>>) {
  return (versionId: string | null | undefined) => (versionId ? versions[versionId] : undefined);
}

vi.mock('@xyflow/react', () => ({
  // 生成面板订阅 transform 重新定位；mock 返回常量数组，避免每次 render 换引用。
  useStore: (selector: (state: {
    transform: [number, number, number];
    nodeLookup: Map<string, never>;
  }) => unknown) => selector({ transform: [0, 0, 1], nodeLookup: new Map<string, never>() }),
  NodeResizer: () => null,
  NodeToolbar: () => null,
  Handle: ({ type }: { type: 'source' | 'target' }) => <button type="button">{type}</button>,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
}));

vi.mock('@/lib/videoFrame', () => ({
  useVideoFrame: (url: string | null) => url ? `${url}#frame` : null,
}));

const draft = {
  mode: 'image' as const,
  prompt: '',
  input_policy: 'all_connected' as const,
  model: '',
  alias: null,
  params: { n: 1, ratio: '1:1' },
  updated_at: '2026-08-25T00:00:00Z',
};

const node: CanvasNode = {
  id: 'config-one',
  title: '分镜出图',
  type: 'config',
  position: { x: 0, y: 0 },
  z_index: 0,
  data: { draft },
};

function nodeContext(overrides: Partial<CanvasNodeContextValue> = {}): CanvasNodeContextValue {
  return {
    projectId: 'canvas-test',
    materialReferences: [],
    connectedMaterialNodeIdsByNodeId: new Map(),
    mentionReferencesByNodeId: new Map(),
    resolveVersion: versionResolver({}),
    keys: [],
    jobsByRunId: new Map(),
    jobsByResultNodeId: new Map(),
    submittingNodeIds: new Set(),
    mediaReplaceBusyNodeIds: new Set(),
    mediaReplaceError: null,
    canvasUiPreferences: DEFAULT_CANVAS_UI_PREFERENCES,
    canvasUiPreferencesError: null,
    showImageInfo: false,
    libraryBusy: false,
    generationPanel: {
      dismissedNodeId: null,
      narrowViewport: false,
      dismiss: vi.fn(),
    },
    setMaterialConnected: vi.fn(),
    selectNode: vi.fn(),
    previewContent: vi.fn(),
    selectCandidate: vi.fn(),
    submitRun: vi.fn(async () => undefined),
    retryRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => undefined),
    dismissCandidate: vi.fn(async () => undefined),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    updateText: vi.fn(),
    createImageConfigFromText: vi.fn(),
    recordHistory: vi.fn(),
    saveAsset: vi.fn(async () => undefined),
    copyPrompt: vi.fn(async () => undefined),
    reversePrompt: vi.fn(async () => undefined),
    createLayerDecomposition: vi.fn(),
    submitLayerDecomposition: vi.fn(async () => undefined),
    replaceLayerStackSource: vi.fn(),
    recoverReversePromptConfig: vi.fn(async () => undefined),
    reversePromptConfiguredNodeIds: new Set(),
    replaceMedia: vi.fn(),
    toggleFreeResize: vi.fn(),
    openMediaOperation: vi.fn(),
    removeBackground: vi.fn(),
    openMaskEdit: vi.fn(),
    openAngle: vi.fn(),
    editVideo: vi.fn(),
    saveImageToolbarPreferences: vi.fn(async () => undefined),
    deleteNode: vi.fn(),
    ...overrides,
  };
}

const imageResultNode: CanvasNode = {
  id: 'image-result',
  title: '图片结果',
  type: 'image',
  position: { x: 0, y: 0 },
  z_index: 0,
  data: {
    current_version_id: 'version-main',
    generation_draft: draft,
    active_run_id: 'run-batch',
    display: { fit: 'contain', free_resize: false },
  },
};

function batchJob(): Job {
  return {
    job_id: 'job-batch',
    character_id: 'openai-main',
    prompt: '纸雕狐狸',
    submitted_at: '2026-08-25T00:00:00Z',
    model: 'gpt-image-1',
    params: { n: 3 },
    output_paths: [],
    status: 'partial',
    error: '部分候选没有生成成功',
    kind: 'image',
    namespace: 'canvas',
    canvas_project_id: 'canvas-test',
    alias: 'openai-main',
    provider: 'openai',
    canvas_run: {
      run_id: 'run-batch',
      result_node_id: imageResultNode.id,
      snapshot: {
        snapshot_version: 1,
        surface_node_id: 'config-one',
        result_node_id: imageResultNode.id,
        mode: 'image',
        final_prompt: '纸雕狐狸',
        input_policy: 'all_connected',
        model: 'gpt-image-1',
        provider: 'openai',
        alias: 'openai-main',
        normalized_params: { n: 3 },
        inputs: [],
        mask_version_id: null,
        submitted_at: '2026-08-25T00:00:00Z',
        submitted_by: { kind: 'user', actor_id: null },
        request_fingerprint: 'a'.repeat(64),
      },
      candidates: [
        { candidate_id: 'candidate-main', index: 0, status: 'succeeded', version_id: 'version-main', error: null },
        { candidate_id: 'candidate-other', index: 1, status: 'succeeded', version_id: 'version-other', error: null },
        { candidate_id: 'candidate-failed', index: 2, status: 'failed', version_id: null, error: '上游超时' },
      ],
    },
  };
}

function imageVersions() {
  return {
    'version-main': {
      version_id: 'version-main',
      created_at: '2026-08-25T00:00:00Z',
      sha256: 'a'.repeat(64),
      origin: { kind: 'job_output' as const, job_id: 'job-batch', candidate_id: 'candidate-main' },
      kind: 'image' as const,
      path: 'outputs/job-batch/main.png',
      mime_type: 'image/png',
      bytes: 12,
      width: 1024,
      height: 1024,
    },
    'version-other': {
      version_id: 'version-other',
      created_at: '2026-08-25T00:00:00Z',
      sha256: 'b'.repeat(64),
      origin: { kind: 'job_output' as const, job_id: 'job-batch', candidate_id: 'candidate-other' },
      kind: 'image' as const,
      path: 'outputs/job-batch/other.png',
      mime_type: 'image/png',
      bytes: 12,
      width: 1024,
      height: 1024,
    },
  };
}

const NodeCard = CanvasNodeCard as React.ComponentType<{
  data: { domain: CanvasNode };
  selected: boolean;
}>;

it('renders the generation composer as an independent panel below the selected node', () => {
  const reportError = vi.fn();
  const context = nodeContext({ reportError });
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  const panel = screen.getByLabelText('图片设置');
  expect(panel).toHaveAttribute('data-floating-node-panel', 'true');
  expect(panel.closest('article')).toBeNull();
  expect(panel.parentElement).toHaveAttribute('data-canvas-node-panel-anchor', 'config-one');
  expect(screen.queryByText(/\d+×/)).not.toBeInTheDocument();
  expect(within(panel).getByText('图片生成')).toBeInTheDocument();
  expect(within(panel).getByText('· 分镜出图')).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: '图片设置' })).not.toBeInTheDocument();
  const generate = within(panel).getByRole('button', { name: '开始生成' });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(reportError).toHaveBeenCalledWith('还没有配置任何模型密钥。');
});

it('switches a config node between generation modes and summarizes connected inputs', () => {
  const recordHistory = vi.fn();
  const updateNode = vi.fn();
  const imageKey = {
    alias: 'image-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' as const, protocol: 'openai' }],
  };
  const videoKey = {
    alias: 'video-key', provider: 'seedance', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'seedance-2.0', name: 'Seedance 2.0', modality: 'video' as const, protocol: 'seedance' }],
  };
  const context = nodeContext({
    keys: [imageKey, videoKey],
    recordHistory,
    updateNode,
    mentionReferencesByNodeId: new Map([[node.id, [
      { nodeId: 'text-one', versionId: 'text-v1', kind: 'text', label: '文本1', title: '脚本' },
      { nodeId: 'image-one', versionId: 'image-v1', kind: 'image', label: '图片1', title: '构图', previewUrl: '/image' },
    ]]]),
  });
  const configured = {
    ...node,
    data: { draft: { ...draft, alias: imageKey.alias, model: imageKey.models[0].id } },
  } as CanvasNode;
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: configured }} selected />
    </CanvasNodeContext.Provider>,
  );

  const modes = screen.getByRole('radiogroup', { name: '生成类型' });
  expect(within(modes).getByRole('radio', { name: '图片' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByLabelText('当前模型')).toHaveTextContent('GPT Image 2');
  expect(screen.getByText('文本 1')).toBeInTheDocument();
  expect(screen.getByText('图片 1')).toBeInTheDocument();

  const imageMode = within(modes).getByRole('radio', { name: '图片' });
  const videoMode = within(modes).getByRole('radio', { name: '视频' });
  act(() => imageMode.focus());
  fireEvent.keyDown(imageMode, { key: 'ArrowRight' });
  expect(videoMode).toHaveFocus();
  expect(recordHistory).toHaveBeenCalledOnce();
  const updater = updateNode.mock.calls[0]?.[1];
  expect(updater?.(configured)).toMatchObject({
    data: { draft: { mode: 'video', alias: 'video-key', model: 'seedance-2.0' } },
  });
});

it('renders image candidates as a collapsed stack owned by the result node', () => {
  const job = batchJob();
  const context = nodeContext({
    resolveVersion: versionResolver(imageVersions()),
    jobsByRunId: new Map([['run-batch', job]]),
    jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageResultNode }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByTestId('canvas-candidate-stack')).toHaveAttribute('data-expanded', 'false');
  expect(screen.getByRole('button', { name: '展开 3 个候选结果' })).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: '候选 2' })).not.toBeInTheDocument();
});

it('expands image candidates around the node and exposes candidate-specific actions', () => {
  const job = batchJob();
  const context = nodeContext({
    resolveVersion: versionResolver(imageVersions()),
    jobsByRunId: new Map([['run-batch', job]]),
    jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageResultNode }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '展开 3 个候选结果' }));
  expect(screen.getByTestId('canvas-candidate-stack')).toHaveAttribute('data-expanded', 'true');
  expect(screen.getByRole('group', { name: '候选 2' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: '候选 3' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '将候选 2 设为主结果' }));
  expect(context.selectCandidate).toHaveBeenCalledWith(imageResultNode.id, 'version-other');

  fireEvent.click(screen.getByRole('button', { name: '删除候选 3' }));
  expect(context.dismissCandidate).toHaveBeenCalledWith('run-batch', 'candidate-failed');
});

it('shows the current video directly without candidate stacking or primary-result selection', () => {
  const base = batchJob();
  const videoJob = (
    jobId: string,
    runId: string,
    candidateId: string,
    versionId: string,
    submittedAt: string,
  ): Job => ({
    ...base,
    job_id: jobId,
    kind: 'video',
    status: 'done',
    submitted_at: submittedAt,
    canvas_run: {
      ...base.canvas_run!,
      run_id: runId,
      result_node_id: 'video-result',
      snapshot: {
        ...base.canvas_run!.snapshot,
        mode: 'video',
        result_node_id: 'video-result',
        submitted_at: submittedAt,
      },
      candidates: [{
        candidate_id: candidateId,
        index: 0,
        status: 'succeeded',
        version_id: versionId,
        error: null,
      }],
    },
  });
  const original = videoJob('video-old', 'run-old', 'candidate-old', 'video-old', '2026-08-25T00:00:00Z');
  const latest = videoJob('video-new', 'run-new', 'candidate-new', 'video-new', '2026-08-25T00:01:00Z');
  const videoResult: CanvasNode = {
    id: 'video-result',
    title: '视频结果',
    type: 'video',
    position: { x: 0, y: 0 },
    z_index: 0,
    data: {
      current_version_id: 'video-new',
      generation_draft: { ...draft, mode: 'video' },
      active_run_id: 'run-new',
      display: { fit: 'contain', free_resize: false },
    },
  };
  const versions = {
    'video-old': {
      version_id: 'video-old', kind: 'video' as const, path: 'outputs/video-old.mp4',
      mime_type: 'video/mp4', bytes: 12, created_at: original.submitted_at,
      sha256: 'a'.repeat(64), origin: { kind: 'job_output' as const, job_id: original.job_id, candidate_id: 'candidate-old' },
    },
    'video-new': {
      version_id: 'video-new', kind: 'video' as const, path: 'outputs/video-new.mp4',
      mime_type: 'video/mp4', bytes: 12, created_at: latest.submitted_at,
      sha256: 'b'.repeat(64), origin: { kind: 'job_output' as const, job_id: latest.job_id, candidate_id: 'candidate-new' },
    },
  };
  const context = nodeContext({
    resolveVersion: versionResolver(versions),
    jobsByRunId: new Map([['run-new', latest]]),
    jobsByResultNodeId: new Map([[videoResult.id, [original, latest]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: videoResult }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByRole('button', { name: '播放 视频结果' })).toBeInTheDocument();
  expect(screen.queryByTestId('canvas-candidate-stack')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /个候选结果/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /设为主结果/ })).not.toBeInTheDocument();
  expect(context.selectCandidate).not.toHaveBeenCalled();
});

it('keeps delete available for the last failed image slot', () => {
  const job = batchJob();
  job.status = 'failed';
  job.canvas_run!.candidates = [job.canvas_run!.candidates[2]];
  const context = nodeContext({
    resolveVersion: versionResolver(imageVersions()),
    jobsByRunId: new Map([['run-batch', job]]),
    jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageResultNode }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.queryByRole('button', { name: /展开 1 个候选结果/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '删除候选 3' }));
  expect(context.dismissCandidate).toHaveBeenCalledWith('run-batch', 'candidate-failed');
});

it('closes the generation panel without removing node handles', () => {
  const dismissGenerationPanel = vi.fn();
  const context = nodeContext({
    generationPanel: {
      dismissedNodeId: null,
      narrowViewport: false,
      dismiss: dismissGenerationPanel,
    },
  });
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '关闭图片设置' }));
  expect(dismissGenerationPanel).toHaveBeenCalledWith(node.id);
  expect(screen.getByRole('button', { name: 'target' })).toBeInTheDocument();
});

it('does not mount a dismissed or narrow-screen desktop generation panel', () => {
  const { rerender } = render(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: {
        dismissedNodeId: node.id,
        narrowViewport: false,
        dismiss: vi.fn(),
      },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片设置')).not.toBeInTheDocument();

  rerender(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: {
        dismissedNodeId: null,
        narrowViewport: true,
        dismiss: vi.fn(),
      },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片设置')).not.toBeInTheDocument();
});

it('keeps generation settings for generated images while classifying upload versions as pure materials', () => {
  const generatedContext = nodeContext({
    resolveVersion: versionResolver({
      'version-main': {
        version_id: 'version-main',
        kind: 'image',
        created_at: '2026-08-25T00:00:00Z',
        sha256: 'd'.repeat(64),
        origin: { kind: 'job_output', job_id: 'job-batch', candidate_id: 'candidate-main' },
        path: 'jobs/job-batch/main.png',
        mime_type: 'image/png',
        bytes: 42,
        width: 1024,
        height: 1024,
        duration_ms: null,
      },
    }),
  });

  render(
    <CanvasNodeContext.Provider value={generatedContext}>
      <NodeCard data={{ domain: imageResultNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByRole('region', { name: '图片设置' })).toBeInTheDocument();
  const generatedVersion = generatedContext.resolveVersion('version-main')!;
  expect(isUploadedImageMaterialNode(imageResultNode, generatedVersion)).toBe(false);
  expect(isUploadedImageMaterialNode(
    imageResultNode,
    { ...generatedVersion, origin: { kind: 'upload', upload_id: 'upload-image' } },
  )).toBe(true);
});

it('renders the narrow-screen composer in an independent bottom panel', () => {
  const dismissGenerationPanel = vi.fn();
  const context = nodeContext({
    generationPanel: {
      dismissedNodeId: null,
      narrowViewport: true,
      dismiss: dismissGenerationPanel,
    },
  });
  render(
    <CanvasNodeContext.Provider value={context}>
      <CanvasMobileGenerationPanel node={node} draft={draft} context={context} />
    </CanvasNodeContext.Provider>,
  );

  const panel = screen.getByLabelText('图片设置');
  expect(panel.closest('.canvas-mobile-generation-panel')).toBeInTheDocument();
  expect(panel.closest('article')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭图片设置' }));
  expect(dismissGenerationPanel).toHaveBeenCalledWith(node.id);
});

it('reopens the panel when the dismissed node is selected again', () => {
  const dismissedContext = nodeContext({
    generationPanel: {
      dismissedNodeId: node.id,
      narrowViewport: false,
      dismiss: vi.fn(),
    },
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={dismissedContext}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片设置')).not.toBeInTheDocument();

  const reopenedId = generationPanelDismissalAfterNodeSelection(node.id, node.id);
  rerender(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: { ...dismissedContext.generationPanel, dismissedNodeId: reopenedId },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByLabelText('图片设置')).toBeInTheDocument();
});

it('returns focus to the node after its panel closes', () => {
  const schedule = vi.fn((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const { container } = render(<article data-canvas-node-id={node.id} tabIndex={-1} />);
  const nodeElement = container.querySelector<HTMLElement>(`[data-canvas-node-id="${node.id}"]`)!;

  act(() => restoreCanvasNodeFocus(node.id, document, schedule));

  expect(schedule).toHaveBeenCalledOnce();
  expect(nodeElement).toHaveFocus();
});

const generationNodes: Array<[CanvasNode, string]> = [
  [{
    id: 'text-one', title: '文案', type: 'text', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null,
      generation_draft: { ...draft, mode: 'text' },
      active_run_id: null,
      display: { scale: 'sm' },
    },
  }, '文本设置'],
  [{
    id: 'image-one', title: '图片', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: draft, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  }, '图片设置'],
  [{
    id: 'video-one', title: '视频', type: 'video', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: { ...draft, mode: 'video' }, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  }, '视频设置'],
  [{
    id: 'audio-one', title: '音频', type: 'audio', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: { ...draft, mode: 'audio' }, active_run_id: null },
  }, '音频设置'],
  [node, '图片设置'],
  [{
    id: 'plugin-one', title: '插件', type: 'plugin', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      plugin_id: 'test', node_type: 'test', plugin_version: '1', data_schema_version: 1,
      payload: {}, generation_draft: draft,
    },
  }, '图片设置'],
];

it.each(generationNodes)('uses the shared independent panel for $title', (generationNode, label) => {
  render(
    <CanvasNodeContext.Provider value={nodeContext()}>
      <NodeCard data={{ domain: generationNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('region', { name: label })).toHaveAttribute('data-floating-node-panel', 'true');
});

it('renders connected references as chips and reports a disconnected reference on generate', () => {
  const imageKey = {
    alias: 'image-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' as const, protocol: 'openai' }],
  };
  const source: CanvasNode = {
    id: 'image-source', title: '雨夜列车', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: 'version-source', generation_draft: null, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  };
  const configuredNode: CanvasNode = {
    ...node,
    data: {
      draft: {
        ...draft,
        prompt: '沿用 @[node:image-source] 的构图',
        alias: imageKey.alias,
        model: imageKey.models[0].id,
      },
    },
  };
  const version = {
    version_id: 'version-source', kind: 'image' as const, path: 'uploads/source.png',
    mime_type: 'image/png', bytes: 12, created_at: '2026-08-25T00:00:00Z',
    sha256: 'a'.repeat(64), origin: { kind: 'upload' as const, upload_id: 'source' },
  };
  const connected = nodeContext({
    mentionReferencesByNodeId: new Map([[configuredNode.id, [{
      nodeId: source.id,
      versionId: version.version_id,
      kind: 'image',
      label: '图片1',
      title: source.title,
      previewUrl: '/api/canvas/projects/canvas-test/media/version-source',
    }]]]),
    resolveVersion: versionResolver({ [version.version_id]: version }),
    keys: [imageKey],
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={connected}>
      <CanvasMobileGenerationPanel node={configuredNode} draft={configuredNode.data.draft} context={connected} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByLabelText('引用图片：雨夜列车')).toHaveTextContent('图片1');
  expect(screen.getByRole('button', { name: '开始生成' })).toBeEnabled();

  const reportError = vi.fn();
  const disconnected = nodeContext({
    ...connected,
    mentionReferencesByNodeId: new Map(),
    reportError,
  });
  rerender(
    <CanvasNodeContext.Provider value={disconnected}>
      <CanvasMobileGenerationPanel node={configuredNode} draft={configuredNode.data.draft} context={disconnected} />
    </CanvasNodeContext.Provider>,
  );
  // 断连后引用 chip 不再渲染；按钮仍可点击，原因由画布顶部统一反馈。
  expect(screen.queryByLabelText(/引用已断开/)).not.toBeInTheDocument();
  const generate = screen.getByRole('button', { name: '开始生成' });
  expect(generate).toBeEnabled();
  fireEvent.click(generate);
  expect(reportError).toHaveBeenCalledWith(
    '提示词里有 1 处引用指向已断开的素材，删掉这些引用后再生成。',
  );
});

it('connects canvas materials above the prompt without rewriting its @ content', async () => {
  const setMaterialConnected = vi.fn();
  const beginMaterialPick = vi.fn();
  const updateNode = vi.fn();
  const draftWithAtContent = { ...draft, prompt: '保留 @ 原提示词' };
  const material = {
    nodeId: 'image-source',
    versionId: 'version-source',
    kind: 'image' as const,
    title: '雨夜列车',
    previewUrl: '/api/canvas/projects/canvas-test/versions/version-source/media',
  };
  const initial = nodeContext({
    materialReferences: [material],
    connectedMaterialNodeIdsByNodeId: new Map(),
    setMaterialConnected,
    beginMaterialPick,
    updateNode,
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={initial}>
      <CanvasMobileGenerationPanel node={node} draft={draftWithAtContent} context={initial} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.queryByRole('button', { name: '查看已对接素材 雨夜列车' })).not.toBeInTheDocument();
  // 选材不再是面板内下拉：点 + 号进入画布选材态，由画布上点节点触发 setMaterialConnected。
  fireEvent.click(screen.getByRole('button', { name: '为 分镜出图 在画布选择素材' }));
  expect(beginMaterialPick).toHaveBeenCalledWith({
    targetNodeId: node.id,
    selectableNodeIds: new Set([material.nodeId]),
  });
  expect(setMaterialConnected).not.toHaveBeenCalled();
  expect(updateNode).not.toHaveBeenCalled();

  const connected = nodeContext({
    ...initial,
    connectedMaterialNodeIdsByNodeId: new Map([[node.id, new Set([material.nodeId])]]),
  });
  rerender(
    <CanvasNodeContext.Provider value={connected}>
      <CanvasMobileGenerationPanel node={node} draft={draftWithAtContent} context={connected} />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('button', { name: '查看已对接素材 雨夜列车' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '查看已对接素材 雨夜列车' })).toHaveTextContent('雨夜列车');
  expect(screen.getByRole('combobox', { name: '提示词' })).toHaveTextContent('保留 @ 原提示词');

  const materialButton = screen.getByRole('button', { name: '查看已对接素材 雨夜列车' });
  fireEvent.mouseEnter(materialButton);
  const hoverDetail = screen.getByRole('tooltip', { name: '素材详情 雨夜列车' });
  expect(hoverDetail).toHaveAttribute('data-canvas-material-hover', material.nodeId);
  expect(within(hoverDetail).getByRole('img', { name: '雨夜列车' })).toHaveAttribute('src', material.previewUrl);
  fireEvent.mouseLeave(materialButton);
  expect(screen.queryByRole('tooltip', { name: '素材详情 雨夜列车' })).not.toBeInTheDocument();

  fireEvent.focus(materialButton);
  expect(screen.getByRole('tooltip', { name: '素材详情 雨夜列车' })).toBeInTheDocument();
  fireEvent.blur(materialButton);
  expect(screen.queryByRole('tooltip', { name: '素材详情 雨夜列车' })).not.toBeInTheDocument();
});

it('plays a silent connected-video preview only while its material is hovered', () => {
  const material = {
    nodeId: 'video-source',
    versionId: 'version-video-source',
    kind: 'video' as const,
    title: '荒原镜头',
    previewUrl: '/api/canvas/projects/canvas-test/versions/version-video-source/media',
  };
  const context = nodeContext({
    materialReferences: [material],
    connectedMaterialNodeIdsByNodeId: new Map([[node.id, new Set([material.nodeId])]]),
  });
  render(
    <CanvasNodeContext.Provider value={context}>
      <CanvasMobileGenerationPanel node={node} draft={draft} context={context} />
    </CanvasNodeContext.Provider>,
  );

  const materialButton = screen.getByRole('button', { name: '查看已对接素材 荒原镜头' });
  const thumbnail = materialButton.querySelector('img[data-canvas-material-thumbnail="video-source"]');
  expect(thumbnail).toHaveAttribute('src', `${material.previewUrl}#frame`);

  fireEvent.mouseEnter(materialButton);
  const detail = screen.getByRole('tooltip', { name: '素材详情 荒原镜头' });
  const video = within(detail).getByLabelText('荒原镜头');
  expect(video).toHaveAttribute('src', material.previewUrl);
  expect(video).toHaveAttribute('autoplay');
  expect(video).toHaveProperty('muted', true);
  expect(video).toHaveAttribute('loop');

  fireEvent.mouseLeave(materialButton);
  expect(screen.queryByRole('tooltip', { name: '素材详情 荒原镜头' })).not.toBeInTheDocument();
});

it('opens video controls from the node generation panel', () => {
  const videoNode = generationNodes[2][0];
  const key = {
    alias: 'video-key', provider: 'seedance', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'seedance-2.0', name: 'Seedance 2.0', modality: 'video' as const, protocol: 'seedance' }],
  };
  const generationDraft = {
    ...draft,
    mode: 'video' as const,
    alias: key.alias,
    model: key.models[0].id,
    params: { duration: 5, resolution: '720p', ratio: '16:9' },
  };
  const configuredNode = {
    ...videoNode,
    data: { ...videoNode.data, generation_draft: generationDraft },
  } as CanvasNode;
  render(
    <CanvasNodeContext.Provider value={nodeContext({ keys: [key] })}>
      <NodeCard data={{ domain: configuredNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /^视频设置$/ }));
  expect(screen.getByTestId('video-settings-popover')).toBeInTheDocument();
  expect(screen.getByText('视频水印')).toBeInTheDocument();
});

it('records text candidate changes but ignores the already selected value', () => {
  const recordHistory = vi.fn();
  const textKey = {
    alias: 'text-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-5', name: 'GPT 5', modality: 'text' as const, protocol: 'openai' }],
  };
  const baseTextNode = generationNodes[0][0];
  const textNode = {
    ...baseTextNode,
    data: {
      ...baseTextNode.data,
      generation_draft: {
        ...draft,
        mode: 'text' as const,
        alias: textKey.alias,
        model: textKey.models[0].id,
      },
    },
  } as CanvasNode;
  render(
    <CanvasNodeContext.Provider value={nodeContext({ keys: [textKey], recordHistory })}>
      <NodeCard data={{ domain: textNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '文本设置' }));
  fireEvent.click(screen.getByRole('option', { name: '1 个' }));
  expect(recordHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('option', { name: '2 个' }));
  expect(recordHistory).toHaveBeenCalledOnce();
});

it('records Responses reasoning changes but ignores the selected effort', () => {
  const recordHistory = vi.fn();
  const textKey = {
    alias: 'responses-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-5', name: 'GPT 5', modality: 'text' as const, protocol: 'openai-responses' }],
  };
  const textNode = {
    ...generationNodes[0][0],
    data: {
      ...generationNodes[0][0].data,
      generation_draft: {
        ...draft,
        mode: 'text' as const,
        alias: textKey.alias,
        model: textKey.models[0].id,
        params: { n: 1, reasoning_effort: 'auto' as const },
      },
    },
  } as CanvasNode;
  render(
    <CanvasNodeContext.Provider value={nodeContext({ keys: [textKey], recordHistory })}>
      <NodeCard data={{ domain: textNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '文本设置' }));
  fireEvent.click(within(screen.getByLabelText('选择推理强度')).getByRole('option', { name: '自动' }));
  expect(recordHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('option', { name: '高' }));
  expect(recordHistory).toHaveBeenCalledOnce();
});

it('records audio setting changes but ignores the selected voice', () => {
  const recordHistory = vi.fn();
  const audioKey = {
    alias: 'speech-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{
      id: 'gpt-4o-mini-tts', name: 'GPT 4o Mini TTS', modality: 'audio' as const,
      protocol: 'openai-speech',
    }],
  };
  const audioNode = {
    ...generationNodes[3][0],
    data: {
      ...generationNodes[3][0].data,
      generation_draft: {
        ...draft,
        mode: 'audio' as const,
        alias: audioKey.alias,
        model: audioKey.models[0].id,
        params: { voice: 'alloy', response_format: 'mp3', speed: 1 },
      },
    },
  } as CanvasNode;
  render(
    <CanvasNodeContext.Provider value={nodeContext({ keys: [audioKey], recordHistory })}>
      <NodeCard data={{ domain: audioNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '音频设置' }));
  fireEvent.click(screen.getByRole('option', { name: 'Alloy' }));
  expect(recordHistory).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('option', { name: 'Marin' }));
  expect(recordHistory).toHaveBeenCalledOnce();
});

it('undoes and redoes image parameter changes as atomic history entries', () => {
  const imageKey = {
    alias: 'image-key', provider: 'openai', base_url: null, access_key: '***', secret_key: null,
    capabilities: [], notes: '', created_at: '2026-08-25T00:00:00Z',
    models: [{ id: 'gpt-image-2', name: 'GPT Image 2', modality: 'image' as const, protocol: 'openai' }],
  };
  const initialNode = {
    ...generationNodes[1][0],
    data: {
      ...generationNodes[1][0].data,
      generation_draft: {
        ...draft,
        alias: imageKey.alias,
        model: imageKey.models[0].id,
        params: { n: 1, ratio: '1:1', quality: 'low', size: '2048x2048' },
      },
    },
  } as CanvasNode;

  function HistoryHarness() {
    const [current, setCurrent] = useState(initialNode);
    const past = useRef<CanvasNode[]>([]);
    const future = useRef<CanvasNode[]>([]);
    const context = nodeContext({
      keys: [imageKey],
      recordHistory: () => {
        past.current.push(current);
        future.current = [];
      },
      updateNode: (_nodeId, updater) => setCurrent(value => updater(value)),
    });
    return (
      <CanvasNodeContext.Provider value={context}>
        <NodeCard data={{ domain: current }} selected />
        <button type="button" onClick={() => {
          const previous = past.current.pop();
          if (!previous) return;
          future.current.push(current);
          setCurrent(previous);
        }}>history undo</button>
        <button type="button" onClick={() => {
          const next = future.current.pop();
          if (!next) return;
          past.current.push(current);
          setCurrent(next);
        }}>history redo</button>
      </CanvasNodeContext.Provider>
    );
  }

  render(<HistoryHarness />);
  const settings = screen.getByRole('button', { name: '图片设置' });
  fireEvent.click(settings);
  fireEvent.click(screen.getByRole('option', { name: '4:3' }));
  expect(settings).toHaveTextContent('4:3');

  fireEvent.click(screen.getByRole('button', { name: 'history undo' }));
  expect(screen.getByRole('button', { name: '图片设置' })).toHaveTextContent('1:1');

  fireEvent.click(screen.getByRole('button', { name: 'history redo' }));
  expect(screen.getByRole('button', { name: '图片设置' })).toHaveTextContent('4:3');
});

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

const VIEWPORT = rect(0, 0, 1280, 720);

it('keeps the generation panel horizontally centered on a node near the left edge', () => {
  const nearLeftEdge = rect(180, 200, 94, 160);

  const placement = placeCanvasGenerationPanel(nearLeftEdge, VIEWPORT, 290);

  expect(placement.left).toBe(-77);
  expect(placement.width).toBe(608);
  expect(placement.top).toBe(376);
});

it('flips the generation panel above the node when there is no room below', () => {
  const nearBottom = rect(500, 560, 240, 140);

  const placement = placeCanvasGenerationPanel(nearBottom, VIEWPORT, 290);

  expect(placement.top).toBe(254);
  expect(placement.top + 290).toBeLessThanOrEqual(nearBottom.top - 16);
  expect(placement.side).toBe('above');
});

it('chooses the roomier vertical side without changing horizontal alignment', () => {
  const tallNode = rect(400, 40, 320, 640);

  const placement = placeCanvasGenerationPanel(tallNode, rect(0, 0, 700, 400), 600);

  expect(placement.left).toBe(256);
  expect(placement.top).toBe(-344);
  expect(placement.maxHeight).toBe(368);
  expect(placement.width).toBe(608);
});

it('keeps the generation panel directly below instead of jumping sideways', () => {
  const node = rect(90, 60, 330, 330);

  const placement = placeCanvasGenerationPanel(node, rect(0, 0, 1440, 900), 860);

  expect(placement.left).toBe(-49);
  expect(placement.top).toBe(node.bottom + 16);
  expect(placement.width).toBe(608);
  expect(placement.side).toBe('below');
});

it('prefers the roomier side even when the panel extends beyond the viewport', () => {
  const wideNode = rect(0, 40, 1400, 640);

  const placement = placeCanvasGenerationPanel(wideNode, rect(0, 0, 1440, 900), 860);

  expect(placement.left).toBe(396);
  expect(placement.top).toBe(wideNode.bottom + 16);
  expect(placement.width).toBe(608);
});

it('keeps job state on the node badge without a persistent panel status line', () => {
  const cases: Array<[Partial<Job>, string, string]> = [
    [{ status: 'partial', error: '第 2 张没出来' }, '部分完成 · 第 2 张没出来', '部分结果完成'],
    [{ status: 'failed', error: '余额不足' }, '生成失败 · 余额不足', ''],
    [{ status: 'canceled', error: null }, '已停止', ''],
    [{ status: 'done', error: null }, '生成完成', ''],
  ];
  for (const [patch, expected, staleCopy] of cases) {
    const job = { ...batchJob(), ...patch } as Job;
    const context = nodeContext({
      resolveVersion: versionResolver(imageVersions()),
      jobsByRunId: new Map([['run-batch', job]]),
      jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
    });
    const { unmount } = render(
      <CanvasNodeContext.Provider value={context}>
        <NodeCard data={{ domain: imageResultNode }} selected />
      </CanvasNodeContext.Provider>,
    );
    const badge = document.querySelector('[data-canvas-node-status-label]');
    expect(badge?.textContent).toBeTruthy();
    expect(expected.startsWith(badge!.textContent!.trim())).toBe(true);
    expect(screen.queryByTitle(expected)).not.toBeInTheDocument();
    if (staleCopy) expect(screen.queryByTitle(staleCopy)).not.toBeInTheDocument();
    unmount();
  }
});

it('keeps reverse-prompt failure on the node badge without a persistent panel line', () => {
  const job = batchJob();
  job.status = 'failed';
  job.error = null;
  job.canvas_run!.snapshot.normalized_params = {
    preset_id: 'canvas.reverse_prompt',
    preset_version: 1,
  };
  const context = nodeContext({
    resolveVersion: versionResolver(imageVersions()),
    jobsByRunId: new Map([['run-batch', job]]),
    jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageResultNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(document.querySelector('[data-canvas-node-status-label]')).toHaveTextContent('分析失败');
  expect(screen.queryByTitle('分析失败 · 反推提示词失败，请检查设置后重新生成')).not.toBeInTheDocument();
  expect(screen.queryByTitle('生成失败，请检查模型配置后重试')).not.toBeInTheDocument();
});
