import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationElement, CanvasDocument, CanvasImageNode } from '@/schema/canvas';
export function useCanvasAnnotation(document: CanvasDocument | null, selectedIds: ReadonlySet<string>,
  commit: (updater: (document: CanvasDocument) => CanvasDocument, record?: boolean) => void,
  undo: () => void, redo: () => void, canUndo: boolean, canRedo: boolean) {
  const historyActions = useRef({ undo, redo });
  historyActions.current = { undo, redo };
  const undoAnnotation = useCallback(() => historyActions.current.undo(), []);
  const redoAnnotation = useCallback(() => historyActions.current.redo(), []);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const version = useRef<string | null>(null);
  const start = useCallback((node: CanvasImageNode) => {
    version.current = node.data.current_version_id;
    setNodeId(node.id);
  }, []);
  const exit = useCallback(() => setNodeId(null), []);
  useEffect(() => {
    if (!nodeId) return;
    const node = document?.nodes.find(node => node.id === nodeId);
    if (node?.type !== 'image' || node.data.current_version_id !== version.current || !selectedIds.has(nodeId)) setNodeId(null);
  }, [document, selectedIds, nodeId]);
  const write = useCallback((id: string, elements: AnnotationElement[]) => {
    commit(current => ({ ...current, nodes: current.nodes.map(node => {
      if (node.id !== id || node.type !== 'image' || !node.data.current_version_id) return node;
      return { ...node, data: { ...node.data, annotation: elements.length ? {
        version_id: node.data.current_version_id, elements, visible: true, rendered_version_id: null,
      } : null } };
    }) }), true);
  }, [commit]);
  return useMemo(() => ({ nodeId, start, exit, write, undo: undoAnnotation, redo: redoAnnotation, canUndo, canRedo }),
    [nodeId, start, exit, write, undoAnnotation, redoAnnotation, canUndo, canRedo]);
}
export type CanvasAnnotationController = ReturnType<typeof useCanvasAnnotation>;
