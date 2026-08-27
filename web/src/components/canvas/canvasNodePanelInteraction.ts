import type { CanvasContentVersion, CanvasNode } from '@/schema/canvas';

export function generationPanelDismissalAfterNodeSelection(
  dismissedNodeId: string | null,
  selectedNodeId: string,
) {
  return dismissedNodeId === selectedNodeId ? null : dismissedNodeId;
}

/** 收的是「已经解析好的当前版本」而不是全量版本表：节点卡拿不到全量表，
 *  原因见 CanvasEditor 里 resolveVersion 的说明。 */
export function isUploadedImageMaterialNode(
  node: CanvasNode,
  content: CanvasContentVersion | undefined,
) {
  if (node.type !== 'image' || !node.data.current_version_id) return false;
  return content?.kind === 'image' && content.origin.kind === 'upload';
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
