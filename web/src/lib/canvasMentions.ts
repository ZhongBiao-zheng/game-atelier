import { canvasMediaUrl } from '@/api/canvas';
import type {
  CanvasConnection,
  CanvasContentNode,
  CanvasContentVersion,
  CanvasNode,
} from '@/schema/canvas';

export type CanvasMentionKind = 'text' | 'image' | 'video' | 'audio';

export interface CanvasMaterialReference {
  nodeId: string;
  versionId: string;
  kind: CanvasMentionKind;
  title: string;
  text?: string;
  previewUrl?: string;
}

export interface CanvasMentionReference extends CanvasMaterialReference {
  label: string;
}

const MENTION_PATTERN = /@\[node:([^\]]+)\]/g;

export interface CanvasMentionMatch {
  token: string;
  nodeId: string;
  index: number;
}

export function canvasMentionToken(nodeId: string): string {
  return `@[node:${nodeId}]`;
}

export function canvasMentionNodeIds(prompt: string): string[] {
  return canvasMentionMatches(prompt).map(match => match.nodeId);
}

export function canvasMentionMatches(prompt: string): CanvasMentionMatch[] {
  return Array.from(prompt.matchAll(MENTION_PATTERN), match => ({
    token: match[0],
    nodeId: match[1],
    index: match.index,
  }));
}

export function missingCanvasMentionIds(
  prompt: string,
  references: readonly CanvasMentionReference[],
): string[] {
  const available = new Set(references.map(reference => reference.nodeId));
  return [...new Set(canvasMentionNodeIds(prompt).filter(nodeId => !available.has(nodeId)))];
}

export function buildCanvasMentionReferences(
  projectId: string,
  surface: CanvasNode,
  nodes: readonly CanvasNode[],
  connections: readonly CanvasConnection[],
  contentVersions: Readonly<Record<string, CanvasContentVersion>>,
): CanvasMentionReference[] {
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const counts: Record<CanvasMentionKind, number> = {
    text: 0,
    image: 0,
    video: 0,
    audio: 0,
  };
  const surfaceVersionId = isMentionContentNode(surface)
    ? surface.data.current_version_id
    : null;
  const surfaceVersion = surfaceVersionId ? contentVersions[surfaceVersionId] : undefined;
  const draft = surface.type === 'config'
    ? surface.data.draft
    : isMentionContentNode(surface)
      ? surface.data.generation_draft
      : null;
  if (surface.type === 'video' && surfaceVersion && draft?.mode === 'video') return [];
  if (surfaceVersion && draft?.mode !== 'audio') counts[surfaceVersion.kind] += 1;
  const seen = new Set<string>();
  return connections.flatMap(connection => {
    if (
      connection.role !== 'input'
      || connection.target_node_id !== surface.id
      || seen.has(connection.source_node_id)
    ) return [];
    seen.add(connection.source_node_id);
    const node = nodesById.get(connection.source_node_id);
    const material = node
      ? canvasMaterialReference(projectId, node, contentVersions)
      : null;
    if (!material) return [];
    const index = ++counts[material.kind];
    return [{
      ...material,
      label: `${mentionKindLabel(material.kind)}${index}`,
    }];
  });
}

export function buildCanvasMaterialReferences(
  projectId: string,
  nodes: readonly CanvasNode[],
  contentVersions: Readonly<Record<string, CanvasContentVersion>>,
): CanvasMaterialReference[] {
  return nodes.flatMap(node => {
    const reference = canvasMaterialReference(projectId, node, contentVersions);
    return reference ? [reference] : [];
  });
}

export function mentionKindLabel(kind: CanvasMentionKind): string {
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  return '文本';
}

function isMentionContentNode(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

function canvasMaterialReference(
  projectId: string,
  node: CanvasNode,
  contentVersions: Readonly<Record<string, CanvasContentVersion>>,
): CanvasMaterialReference | null {
  if (!isMentionContentNode(node)) return null;
  const versionId = node.data.current_version_id;
  const version = versionId ? contentVersions[versionId] : undefined;
  if (!version || version.kind !== node.type) return null;
  return {
    nodeId: node.id,
    versionId: version.version_id,
    kind: version.kind,
    title: node.title,
    text: version.kind === 'text' ? version.text : undefined,
    previewUrl: version.kind === 'text'
      ? undefined
      : canvasMediaUrl(projectId, version.version_id),
  };
}
