import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useRef, useState } from 'react';
import { expect, it, vi } from 'vitest';

import {
  CanvasNodeCard,
  CanvasNodeContext,
  CanvasMobileGenerationPanel,
  type CanvasNodeContextValue,
} from './CanvasEditorViews';
import { DEFAULT_CANVAS_UI_PREFERENCES } from './canvasImageToolbar';
import {
  generationPanelDismissalAfterNodeSelection,
  restoreCanvasNodeFocus,
} from './canvasNodePanelInteraction';
import type { CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';

vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  NodeToolbar: () => null,
  Handle: ({ type }: { type: 'source' | 'target' }) => <button type="button">{type}</button>,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
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
    mentionReferencesByNodeId: new Map(),
    contentVersions: {},
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
      viewportZoom: 1,
      narrowViewport: false,
      dismiss: vi.fn(),
    },
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
    recoverReversePromptConfig: vi.fn(async () => undefined),
    reversePromptConfiguredNodeIds: new Set(),
    replaceMedia: vi.fn(),
    toggleFreeResize: vi.fn(),
    openMediaOperation: vi.fn(),
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
  const context = nodeContext();
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  const panel = screen.getByLabelText('图片生成设置');
  expect(panel).toHaveAttribute('data-floating-node-panel', 'true');
  expect(panel.closest('article')).toBeNull();
  expect(panel.parentElement).toHaveAttribute('data-canvas-node-panel-anchor', 'config-one');
  expect(screen.queryByText(/\d+×/)).not.toBeInTheDocument();
  expect(within(panel).getByText('图片生成')).toBeInTheDocument();
  expect(within(panel).getByText('· 分镜出图')).toBeInTheDocument();
  expect(within(panel).queryByRole('button', { name: '打开图片参数' })).not.toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: '开始生成' })).toBeDisabled();
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
    contentVersions: imageVersions(),
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
    contentVersions: imageVersions(),
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
  expect(screen.queryByRole('button', { name: '重试候选 2' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '将候选 2 设为主结果' }));
  expect(context.selectCandidate).toHaveBeenCalledWith(imageResultNode.id, 'version-other');

  fireEvent.click(screen.getByRole('button', { name: '重试候选 3' }));
  expect(context.retryRun).toHaveBeenCalledWith(
    imageResultNode.id,
    'run-batch',
    'original',
    'candidate-failed',
  );

  fireEvent.click(screen.getByRole('button', { name: '删除候选 3' }));
  expect(context.dismissCandidate).toHaveBeenCalledWith('run-batch', 'candidate-failed');
});

it('keeps retry and delete available for the last failed image slot', () => {
  const job = batchJob();
  job.status = 'failed';
  job.canvas_run!.candidates = [job.canvas_run!.candidates[2]];
  const context = nodeContext({
    contentVersions: imageVersions(),
    jobsByRunId: new Map([['run-batch', job]]),
    jobsByResultNodeId: new Map([[imageResultNode.id, [job]]]),
  });

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageResultNode }} selected={false} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.queryByRole('button', { name: /展开 1 个候选结果/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '重试候选 3' }));
  fireEvent.click(screen.getByRole('button', { name: '删除候选 3' }));
  expect(context.retryRun).toHaveBeenCalledWith(
    imageResultNode.id,
    'run-batch',
    'original',
    'candidate-failed',
  );
  expect(context.dismissCandidate).toHaveBeenCalledWith('run-batch', 'candidate-failed');
});

it('closes the generation panel without removing node handles', () => {
  const dismissGenerationPanel = vi.fn();
  const context = nodeContext({
    generationPanel: {
      dismissedNodeId: null,
      viewportZoom: 1,
      narrowViewport: false,
      dismiss: dismissGenerationPanel,
    },
  });
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  fireEvent.click(screen.getByRole('button', { name: '关闭图片生成设置' }));
  expect(dismissGenerationPanel).toHaveBeenCalledWith(node.id);
  expect(screen.getByRole('button', { name: 'target' })).toBeInTheDocument();
});

it('does not mount a dismissed or narrow-screen desktop generation panel', () => {
  const { rerender } = render(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: {
        dismissedNodeId: node.id,
        viewportZoom: 1,
        narrowViewport: false,
        dismiss: vi.fn(),
      },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片生成设置')).not.toBeInTheDocument();

  rerender(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: {
        dismissedNodeId: null,
        viewportZoom: 1,
        narrowViewport: true,
        dismiss: vi.fn(),
      },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片生成设置')).not.toBeInTheDocument();
});

it('renders the narrow-screen composer in an independent bottom panel', () => {
  const dismissGenerationPanel = vi.fn();
  const context = nodeContext({
    generationPanel: {
      dismissedNodeId: null,
      viewportZoom: 1,
      narrowViewport: true,
      dismiss: dismissGenerationPanel,
    },
  });
  render(
    <CanvasNodeContext.Provider value={context}>
      <CanvasMobileGenerationPanel node={node} draft={draft} context={context} />
    </CanvasNodeContext.Provider>,
  );

  const panel = screen.getByLabelText('图片生成设置');
  expect(panel.closest('.canvas-mobile-generation-panel')).toBeInTheDocument();
  expect(panel.closest('article')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '关闭图片生成设置' }));
  expect(dismissGenerationPanel).toHaveBeenCalledWith(node.id);
});

it('reopens the panel when the dismissed node is selected again', () => {
  const dismissedContext = nodeContext({
    generationPanel: {
      dismissedNodeId: node.id,
      viewportZoom: 1,
      narrowViewport: false,
      dismiss: vi.fn(),
    },
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={dismissedContext}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.queryByLabelText('图片生成设置')).not.toBeInTheDocument();

  const reopenedId = generationPanelDismissalAfterNodeSelection(node.id, node.id);
  rerender(
    <CanvasNodeContext.Provider value={nodeContext({
      generationPanel: { ...dismissedContext.generationPanel, dismissedNodeId: reopenedId },
    })}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByLabelText('图片生成设置')).toBeInTheDocument();
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
  }, '文本生成设置'],
  [{
    id: 'image-one', title: '图片', type: 'image', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: draft, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  }, '图片生成设置'],
  [{
    id: 'video-one', title: '视频', type: 'video', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: { ...draft, mode: 'video' }, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  }, '视频生成设置'],
  [{
    id: 'audio-one', title: '音频', type: 'audio', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: { ...draft, mode: 'audio' }, active_run_id: null },
  }, '音频生成设置'],
  [node, '图片生成设置'],
  [{
    id: 'plugin-one', title: '插件', type: 'plugin', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      plugin_id: 'test', node_type: 'test', plugin_version: '1', data_schema_version: 1,
      payload: {}, generation_draft: draft,
    },
  }, '图片生成设置'],
];

it.each(generationNodes)('uses the shared independent panel for $title', (generationNode, label) => {
  render(
    <CanvasNodeContext.Provider value={nodeContext()}>
      <NodeCard data={{ domain: generationNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('region', { name: label })).toHaveAttribute('data-floating-node-panel', 'true');
});

it('renders connected references as chips and blocks a draft after that reference disconnects', () => {
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
    contentVersions: { [version.version_id]: version },
    keys: [imageKey],
  });
  const { rerender } = render(
    <CanvasNodeContext.Provider value={connected}>
      <CanvasMobileGenerationPanel node={configuredNode} draft={configuredNode.data.draft} context={connected} />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByLabelText('引用图片：雨夜列车')).toHaveTextContent('图片1');
  expect(screen.getByText('输入 @ 引用已连接内容 · 1 项可用')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始生成' })).toBeEnabled();

  const disconnected = nodeContext({ ...connected, mentionReferencesByNodeId: new Map() });
  rerender(
    <CanvasNodeContext.Provider value={disconnected}>
      <CanvasMobileGenerationPanel node={configuredNode} draft={configuredNode.data.draft} context={disconnected} />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('1 个引用已断开');
  expect(screen.getByLabelText('引用已断开：image-source')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '开始生成' })).toBeDisabled();
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
  fireEvent.click(screen.getByRole('button', { name: /^视频生成设置$/ }));
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

  fireEvent.click(screen.getByRole('button', { name: '文本生成设置' }));
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

  fireEvent.click(screen.getByRole('button', { name: '文本生成设置' }));
  fireEvent.click(screen.getByRole('option', { name: '自动' }));
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

  fireEvent.click(screen.getByRole('button', { name: '音频生成设置' }));
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
  const settings = screen.getByRole('button', { name: '打开图片参数' });
  fireEvent.click(settings);
  fireEvent.click(screen.getByRole('option', { name: '4:3' }));
  expect(settings).toHaveTextContent('4:3');

  fireEvent.click(screen.getByRole('button', { name: 'history undo' }));
  expect(screen.getByRole('button', { name: '打开图片参数' })).toHaveTextContent('1:1');

  fireEvent.click(screen.getByRole('button', { name: 'history redo' }));
  expect(screen.getByRole('button', { name: '打开图片参数' })).toHaveTextContent('4:3');
});
