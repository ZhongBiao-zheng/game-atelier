import type { CanvasContentNode, CanvasDocument, CanvasNode } from '@/schema/canvas';

function unchanged(current: unknown, submitted: unknown): boolean {
  return JSON.stringify(current) === JSON.stringify(submitted);
}

export function restoreCanvasRetryConfiguration(
  current: CanvasDocument,
  remote: CanvasDocument,
  submitted: CanvasDocument,
  resultNodeId: string,
): CanvasDocument {
  const before = submitted.nodes.find(node => node.id === resultNodeId);
  const restored = remote.nodes.find(node => node.id === resultNodeId);
  if (!before || !restored || !current.nodes.some(node => node.id === resultNodeId)) return current;
  const incoming = (document: CanvasDocument) => document.connections.filter(connection => (
    connection.role === 'input' && connection.target_node_id === resultNodeId
  ));
  const nodeIds = new Set(current.nodes.map(node => node.id));
  const inputsUnchanged = unchanged(incoming(current), incoming(submitted))
    && incoming(remote).every(connection => nodeIds.has(connection.source_node_id));
  const nodes = current.nodes.map((node): CanvasNode => {
    if (node.id !== resultNodeId) return node;
    // The recipe and references are coupled: a restored @mention must not point at a disconnected input.
    if (!inputsUnchanged) return node;
    if (node.type === 'layer_stack' && before.type === 'layer_stack' && restored.type === 'layer_stack') {
      const restore = <K extends keyof typeof node.data>(field: K): typeof node.data[K] => (
        unchanged(node.data[field], before.data[field]) ? restored.data[field] : node.data[field]
      );
      return { ...node, data: { ...node.data, source_version_id: restore('source_version_id'),
        prompt: restore('prompt'), alias: restore('alias'), model: restore('model'), resolution: restore('resolution') } };
    }
    if ('generation_draft' in node.data && 'generation_draft' in before.data && 'generation_draft' in restored.data
      && unchanged(node.data.generation_draft, before.data.generation_draft)) {
      return { ...node, data: { ...node.data, generation_draft: restored.data.generation_draft } } as CanvasContentNode;
    }
    return node;
  });
  // A retry restores its frozen recipe only where the user has not edited it since submission.
  const connections = inputsUnchanged
    ? [...current.connections.filter(connection => connection.role !== 'input' || connection.target_node_id !== resultNodeId),
      ...incoming(remote).filter(connection => nodeIds.has(connection.source_node_id))]
    : current.connections;
  return { ...current, nodes, connections };
}
