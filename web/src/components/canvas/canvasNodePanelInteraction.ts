import type { CanvasContentVersion, CanvasNode } from '@/schema/canvas';

export function generationPanelDismissalAfterNodeSelection(
  dismissedNodeId: string | null,
  selectedNodeId: string,
) {
  return dismissedNodeId === selectedNodeId ? null : dismissedNodeId;
}

export function isUploadedImageMaterialNode(
  node: CanvasNode,
  contentVersions: Readonly<Record<string, CanvasContentVersion>>,
) {
  if (node.type !== 'image' || !node.data.current_version_id) return false;
  const version = contentVersions[node.data.current_version_id];
  return version?.kind === 'image' && version.origin.kind === 'upload';
}

export function restoreCanvasNodeFocus(
  nodeId: string,
  root: ParentNode = document,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
) {
  schedule(() => {
    const node = [...root.querySelectorAll<HTMLElement>('[data-canvas-node-id]')]
      .find(element => element.dataset.canvasNodeId === nodeId);
    node?.focus();
  });
}
