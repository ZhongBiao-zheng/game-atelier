import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  CanvasNodeCard,
  CanvasNodeContext,
  type CanvasNodeContextValue,
} from './CanvasEditorViews';
import { DEFAULT_CANVAS_UI_PREFERENCES } from './canvasImageToolbar';
import { canvasNodeRunState } from './CanvasNodeRunStatus';
import type { CanvasContentVersion, CanvasNode } from '@/schema/canvas';
import type { Job, JobStatus } from '@/schema/jobs';

vi.mock('@xyflow/react', () => ({
  NodeResizer: () => null,
  NodeToolbar: ({ children, isVisible, ...props }: {
    children?: React.ReactNode;
    isVisible?: boolean;
  } & React.HTMLAttributes<HTMLDivElement>) => isVisible ? <div {...props}>{children}</div> : null,
  Handle: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  Position: { Left: 'left', Right: 'right' },
}));

const imageNode: CanvasNode = {
  id: 'image-result',
  title: '生成图片',
  type: 'image',
  position: { x: 0, y: 0 },
  z_index: 0,
  data: {
    current_version_id: null,
    generation_draft: null,
    active_run_id: 'run-1',
    display: { fit: 'contain', free_resize: false },
  },
};

const idleNodes: CanvasNode[] = [
  { ...imageNode, data: { ...imageNode.data, active_run_id: null } },
  {
    id: 'text', title: '文本', type: 'text', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: null, active_run_id: null },
  },
  {
    id: 'video', title: '视频', type: 'video', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      current_version_id: null, generation_draft: null, active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  },
  {
    id: 'audio', title: '音频', type: 'audio', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: null, active_run_id: null },
  },
  {
    id: 'config', title: '配置', type: 'config', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      draft: {
        mode: 'image', prompt: '', input_policy: 'all_connected', model: '', params: {},
        updated_at: '2026-08-25T00:00:00Z',
      },
    },
  },
  {
    id: 'group', title: '分组', type: 'group', position: { x: 0, y: 0 }, z_index: 0,
    data: { member_node_ids: [] },
  },
  {
    id: 'plugin', title: '插件', type: 'plugin', position: { x: 0, y: 0 }, z_index: 0,
    data: {
      plugin_id: 'test', node_type: 'test', plugin_version: '1', data_schema_version: 1,
      payload: {}, generation_draft: null,
    },
  },
];

const contentNodes = idleNodes.slice(0, 4).map(node => ({
  ...node,
  data: { ...node.data, active_run_id: 'run-1' },
} as CanvasNode));

function withExistingContent(node: CanvasNode): CanvasNode {
  if (node.type !== 'text' && node.type !== 'image' && node.type !== 'video' && node.type !== 'audio') return node;
  return {
    ...node,
    data: { ...node.data, current_version_id: `version-${node.type}` },
  } as CanvasNode;
}

function existingVersion(node: CanvasNode): CanvasContentVersion {
  const base = {
    version_id: `version-${node.type}`,
    created_at: '2026-08-25T00:00:00Z',
    sha256: 'c'.repeat(64),
    origin: { kind: 'upload' as const, upload_id: `upload-${node.type}` },
  };
  if (node.type === 'text') return { ...base, kind: 'text', text: '保留的文本内容' };
  const kind = node.type === 'video' || node.type === 'audio' ? node.type : 'image';
  return {
    ...base,
    kind,
    path: `uploads/existing.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`,
    mime_type: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'audio/mpeg',
    bytes: 42,
    width: kind === 'audio' ? null : 1024,
    height: kind === 'audio' ? null : 1024,
    duration_ms: kind === 'image' ? null : 1000,
  };
}

function expectExistingContent(node: CanvasNode, container: HTMLElement) {
  if (node.type === 'text') expect(screen.getByText('保留的文本内容')).toBeInTheDocument();
  if (node.type === 'image') expect(container.querySelector('img')).toBeInTheDocument();
  if (node.type === 'video') expect(container.querySelector('video')).toBeInTheDocument();
  if (node.type === 'audio') expect(screen.getByText('音频素材')).toBeInTheDocument();
}

function canvasJob(status: JobStatus, overrides: Partial<Job> = {}, resultNodeId = imageNode.id): Job {
  return {
    job_id: `job-${status}`,
    character_id: 'canvas-key',
    prompt: 'cinematic portrait',
    submitted_at: '2026-08-25T00:00:00Z',
    model: 'image-model',
    params: {},
    output_paths: [],
    status,
    error: status === 'failed' ? '上游服务暂时不可用' : null,
    kind: 'image',
    namespace: 'canvas',
    canvas_project_id: 'canvas-test',
    canvas_run: {
      run_id: 'run-1',
      result_node_id: resultNodeId,
      snapshot: {
        snapshot_version: 1,
        surface_node_id: resultNodeId,
        result_node_id: resultNodeId,
        mode: 'image',
        final_prompt: 'cinematic portrait',
        input_policy: 'all_connected',
        model: 'image-model',
        provider: 'test',
        alias: 'canvas-key',
        normalized_params: {},
        inputs: [],
        mask_version_id: null,
        submitted_at: '2026-08-25T00:00:00Z',
        submitted_by: { kind: 'user', actor_id: null },
        request_fingerprint: 'fingerprint',
      },
      candidates: [{ candidate_id: 'candidate-1', index: 0, status: 'pending', version_id: null, error: null }],
    },
    ...overrides,
  };
}

function nodeContext(job: Job): CanvasNodeContextValue {
  return {
    projectId: 'canvas-test',
    contentVersions: {},
    keys: [],
    jobsByRunId: new Map([['run-1', job]]),
    jobsByResultNodeId: new Map([[imageNode.id, [job]]]),
    submittingNodeIds: new Set(),
    mediaReplaceBusyNodeIds: new Set(),
    mediaReplaceError: null,
    canvasUiPreferences: DEFAULT_CANVAS_UI_PREFERENCES,
    canvasUiPreferencesError: null,
    showImageInfo: false,
    libraryBusy: false,
    selectNode: vi.fn(),
    previewContent: vi.fn(),
    selectCandidate: vi.fn(),
    submitRun: vi.fn(async () => undefined),
    retryRun: vi.fn(async () => undefined),
    cancelRun: vi.fn(async () => undefined),
    updateNode: vi.fn(),
    renameNode: vi.fn(),
    updateText: vi.fn(),
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
  };
}

const NodeCard = CanvasNodeCard as React.ComponentType<{
  data: { domain: CanvasNode };
  selected: boolean;
}>;

it('derives the four node states from the active result Job only', () => {
  for (const node of idleNodes) {
    expect(canvasNodeRunState(node, new Map()).status).toBe('idle');
  }
  expect(canvasNodeRunState(imageNode, new Map([['run-1', canvasJob('pending')]])).status).toBe('loading');
  expect(canvasNodeRunState(imageNode, new Map([['run-1', canvasJob('done')]])).status).toBe('success');
  expect(canvasNodeRunState(imageNode, new Map([['run-1', canvasJob('partial')]]))).toMatchObject({
    status: 'success', label: '部分完成',
  });
  expect(canvasNodeRunState(imageNode, new Map([['run-1', canvasJob('failed')]])).status).toBe('error');
  expect(canvasNodeRunState(imageNode, new Map([['run-1', canvasJob('canceled')]]))).toMatchObject({
    status: 'idle', label: '已停止',
  });
  const wrongResultJob = canvasJob('pending', {}, 'another-node');
  expect(canvasNodeRunState(imageNode, new Map([['run-1', wrongResultJob]]))).toMatchObject({
    status: 'idle',
    job: undefined,
  });
});

it.each(contentNodes.map(node => [node.type, node] as const))(
  'renders empty and existing-content loading/error states for %s without nesting live regions',
  (_type, baseNode) => {
    for (const hasContent of [false, true]) {
      for (const status of ['pending', 'failed'] as const) {
        const node = hasContent ? withExistingContent(baseNode) : baseNode;
        const job = canvasJob(status, {}, node.id);
        const context = nodeContext(job);
        if (hasContent) {
          const version = existingVersion(node);
          context.contentVersions = { [version.version_id]: version };
        }
        const { container, unmount } = render(
          <CanvasNodeContext.Provider value={context}>
            <NodeCard data={{ domain: node }} selected />
          </CanvasNodeContext.Provider>,
        );

        const article = container.querySelector<HTMLElement>(`[data-canvas-node-id="${node.id}"]`)!;
        expect(article).toHaveAttribute('data-canvas-node-status', status === 'pending' ? 'loading' : 'error');
        const liveRegion = screen.getByRole(status === 'pending' ? 'status' : 'alert');
        expect(article).not.toContainElement(liveRegion);
        if (hasContent) expectExistingContent(node, container);
        if (!hasContent && status === 'failed') {
          expect(article).not.toContainElement(screen.getByRole('button', { name: '按原设置重试' }));
        }
        unmount();
      }
    }
  },
);

it('announces terminal status transitions without remounting the live region', () => {
  const pending = canvasJob('pending');
  const { rerender } = render(
    <CanvasNodeContext.Provider value={nodeContext(pending)}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  const liveStatus = screen.getByRole('status');
  expect(liveStatus).toHaveTextContent('正在生成');

  rerender(
    <CanvasNodeContext.Provider value={nodeContext(canvasJob('done'))}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('status')).toBe(liveStatus);
  expect(liveStatus).toHaveTextContent('生成完成');

  rerender(
    <CanvasNodeContext.Provider value={nodeContext(canvasJob('partial'))}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(liveStatus).toHaveTextContent('部分完成');

  rerender(
    <CanvasNodeContext.Provider value={nodeContext(canvasJob('canceled'))}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(liveStatus).toHaveTextContent('已停止');
});

it('keeps cancellation and reverse-prompt labels honest', () => {
  const cancelRequested = canvasJob('pending', { cancel_requested_at: '2026-08-25T00:01:00Z' });
  expect(canvasNodeRunState(imageNode, new Map([['run-1', cancelRequested]]))).toMatchObject({
    status: 'loading',
    label: '正在停止…',
    detail: '已请求停止，上游可能仍在执行',
  });
  const canceledView = render(
    <CanvasNodeContext.Provider value={nodeContext(cancelRequested)}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('button', { name: '正在停止 生成图片' })).toBeDisabled();
  canceledView.unmount();

  const reversePending = canvasJob('pending');
  reversePending.canvas_run!.snapshot.normalized_params = {
    preset_id: 'canvas.reverse_prompt',
    preset_version: 1,
  };
  const pendingView = render(
    <CanvasNodeContext.Provider value={nodeContext(reversePending)}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('button', { name: '停止反推提示词' })).toBeInTheDocument();
  pendingView.unmount();

  const reverseFailed = canvasJob('failed');
  reverseFailed.canvas_run!.snapshot.normalized_params = {
    preset_id: 'canvas.reverse_prompt',
    preset_version: 1,
  };
  render(
    <CanvasNodeContext.Provider value={nodeContext(reverseFailed)}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );
  expect(screen.getByRole('button', { name: '按原设置重试反推提示词' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '选择节点 生成图片，分析失败' })).toBeInTheDocument();
});

it('does not expose reverse-prompt recovery for a Run owned by another result node', () => {
  const wrongReverse = canvasJob('done', {}, 'another-node');
  wrongReverse.canvas_run!.snapshot.normalized_params = {
    preset_id: 'canvas.reverse_prompt',
    preset_version: 1,
  };
  wrongReverse.canvas_run!.candidates = [{
    candidate_id: 'candidate-1',
    index: 0,
    status: 'succeeded',
    version_id: 'version-text',
    error: null,
  }];
  const node = withExistingContent(imageNode);
  const context = nodeContext(wrongReverse);
  const version = existingVersion(node);
  context.contentVersions = { [version.version_id]: version };

  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByRole('button', { name: '选择节点 生成图片，待编辑' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '从反推文本创建图片配置' })).not.toBeInTheDocument();
});

it('keeps existing content visible while a new run is loading and exposes stop in the toolbar', () => {
  const node = {
    ...imageNode,
    data: { ...imageNode.data, current_version_id: 'version-existing' },
  } as CanvasNode;
  const job = canvasJob('pending');
  const context = nodeContext(job);
  context.contentVersions = {
    'version-existing': {
      version_id: 'version-existing', kind: 'image', created_at: '2026-08-25T00:00:00Z',
      sha256: 'a'.repeat(64), origin: { kind: 'upload', upload_id: 'upload-1' },
      path: 'uploads/existing.png', mime_type: 'image/png', bytes: 42,
      width: 1024, height: 1024, duration_ms: null,
    },
  };

  const { container } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  const article = container.querySelector('[data-canvas-node-id="image-result"]');
  expect(article).toHaveAttribute('data-canvas-node-status', 'loading');
  expect(article).toHaveAttribute('aria-busy', 'true');
  expect(container.querySelector('img')).toHaveAttribute('src', expect.stringContaining('version-existing'));
  expect(screen.getByRole('status')).toHaveTextContent('正在生成');
  fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: '停止 生成图片 的生成' }));
  expect(context.cancelRun).toHaveBeenCalledWith('run-1');
});

it('shows an empty error body and retries the immutable snapshot from body or toolbar', () => {
  const job = canvasJob('failed');
  const context = nodeContext(job);
  render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: imageNode }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(screen.getByRole('button', { name: '选择节点 生成图片，生成失败' })).toHaveAttribute(
    'data-canvas-node-status',
    'error',
  );
  expect(screen.getByRole('alert')).toHaveTextContent('上游服务暂时不可用');
  fireEvent.click(screen.getByRole('button', { name: '按原设置重试' }));
  fireEvent.click(within(screen.getByRole('toolbar')).getByRole('button', { name: '按原设置重试 生成图片' }));
  expect(context.retryRun).toHaveBeenNthCalledWith(1, imageNode.id, 'run-1', 'original');
  expect(context.retryRun).toHaveBeenNthCalledWith(2, imageNode.id, 'run-1', 'original');
});

it('keeps old content visible after failure and leaves retry in the node toolbar', () => {
  const node = {
    ...imageNode,
    data: { ...imageNode.data, current_version_id: 'version-existing' },
  } as CanvasNode;
  const job = canvasJob('failed');
  const context = nodeContext(job);
  context.contentVersions = {
    'version-existing': {
      version_id: 'version-existing', kind: 'image', created_at: '2026-08-25T00:00:00Z',
      sha256: 'b'.repeat(64), origin: { kind: 'upload', upload_id: 'upload-2' },
      path: 'uploads/existing.png', mime_type: 'image/png', bytes: 42,
      width: 1024, height: 1024, duration_ms: null,
    },
  };

  const { container } = render(
    <CanvasNodeContext.Provider value={context}>
      <NodeCard data={{ domain: node }} selected />
    </CanvasNodeContext.Provider>,
  );

  expect(container.querySelector('img')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('上游服务暂时不可用');
  expect(screen.queryByRole('button', { name: '按原设置重试' })).not.toBeInTheDocument();
  expect(within(screen.getByRole('toolbar')).getByRole('button', { name: '按原设置重试 生成图片' })).toBeInTheDocument();
});
