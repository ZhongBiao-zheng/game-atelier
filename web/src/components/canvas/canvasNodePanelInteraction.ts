export function generationPanelDismissalAfterNodeSelection(
  dismissedNodeId: string | null,
  selectedNodeId: string,
) {
  return dismissedNodeId === selectedNodeId ? null : dismissedNodeId;
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
