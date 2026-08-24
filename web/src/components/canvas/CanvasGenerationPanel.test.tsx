import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import {
  CanvasInspector,
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
    ...overrides,
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

it('restores the narrow-screen inspector when the generation panel closes', () => {
  const imageNode: CanvasNode = {
    id: 'image-mobile',
    title: '移动端图片',
    type: 'image',
    position: { x: 0, y: 0 },
    z_index: 0,
    data: {
      current_version_id: null,
      generation_draft: draft,
      active_run_id: null,
      display: { fit: 'contain', free_resize: false },
    },
  };
  const inspectorProps = {
    node: imageNode,
    updateNode: vi.fn(),
    updateText: vi.fn(),
    recordHistory: vi.fn(),
    deleteNode: vi.fn(),
    projectId: 'canvas-test',
    contentVersions: {},
  };
  const { container, rerender } = render(<CanvasInspector {...inspectorProps} hideOnMobile />);
  expect(container.querySelector('.canvas-inspector-panel')).toHaveClass('hidden');

  rerender(<CanvasInspector {...inspectorProps} hideOnMobile={false} />);
  expect(container.querySelector('.canvas-inspector-panel')).not.toHaveClass('hidden');
});

const generationNodes: Array<[CanvasNode, string]> = [
  [{
    id: 'text-one', title: '文案', type: 'text', position: { x: 0, y: 0 }, z_index: 0,
    data: { current_version_id: null, generation_draft: { ...draft, mode: 'text' }, active_run_id: null },
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
