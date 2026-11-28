import type { Job } from '@/schema/jobs';
import type { CanvasDocument, CanvasNode } from '@/schema/canvas';

import { canvasNodeRenderedSize } from './canvasEditorModel';

/** 撤销 / 重做后告诉用户「变的是哪里」（gemini Q7）：视口里受影响的节点闪一圈描边；
 *  全在视口外时，在那一侧的边缘给一个胶囊，点了才平移过去，不自动劫持视野。 */

export interface CanvasRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CanvasHistoryDirection = 'left' | 'right' | 'up' | 'down';

export interface CanvasHistoryHint {
  key: number;
  label: string;
  direction: CanvasHistoryDirection;
  bounds: CanvasRect;
}

const DIRECTION_LABEL: Record<CanvasHistoryDirection, string> = {
  left: '左侧', right: '右侧', up: '上方', down: '下方',
};

function nodeRect(node: CanvasNode, document: CanvasDocument): CanvasRect {
  const size = canvasNodeRenderedSize(node, document.content_versions);
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height };
}

function sameNode(a: CanvasNode, b: CanvasNode) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** before → after 之间变了的节点：新出现的、内容或位置变了的、连线增删牵连的（这些在 after 里还在，可以描边），
 *  以及被删掉的（只剩 before 里的位置，用来判断方向）。 */
export function canvasHistoryAffectedNodes(before: CanvasDocument, after: CanvasDocument) {
  const previous = new Map(before.nodes.map(node => [node.id, node]));
  const current = new Map(after.nodes.map(node => [node.id, node]));
  const present = new Set<string>();
  for (const node of after.nodes) {
    const old = previous.get(node.id);
    if (!old || !sameNode(old, node)) present.add(node.id);
  }
  const beforeConnections = new Map(before.connections.map(connection => [connection.id, connection]));
  const afterConnections = new Map(after.connections.map(connection => [connection.id, connection]));
  const touched = [
    ...after.connections.filter(connection => !beforeConnections.has(connection.id)),
    ...before.connections.filter(connection => !afterConnections.has(connection.id)),
  ];
  for (const connection of touched) {
    if (current.has(connection.target_node_id)) present.add(connection.target_node_id);
  }
  const removed = before.nodes.filter(node => !current.has(node.id));
  return {
    presentIds: [...present],
    rects: [
      ...[...present].map(id => nodeRect(current.get(id)!, after)),
      ...removed.map(node => nodeRect(node, before)),
    ],
    presentRects: new Map([...present].map(id => [id, nodeRect(current.get(id)!, after)] as const)),
  };
}

export function canvasRectsIntersect(a: CanvasRect, b: CanvasRect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** 受影响的位置全在视口外时，给出边缘胶囊的方向与文案；视口里看得到任何一处就返回 null。 */
export function canvasHistoryHint(
  action: '撤销' | '重做',
  rects: readonly CanvasRect[],
  visible: CanvasRect,
): Omit<CanvasHistoryHint, 'key'> | null {
  if (!rects.length || rects.some(rect => canvasRectsIntersect(rect, visible))) return null;
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  const bounds = { x: left, y: top, width: right - left, height: bottom - top };
  // 按视口宽高归一化后比较：横向偏得更多就是左右，否则上下。
  const dx = (left + right) / 2 - (visible.x + visible.width / 2);
  const dy = (top + bottom) / 2 - (visible.y + visible.height / 2);
  const direction: CanvasHistoryDirection = Math.abs(dx) / visible.width >= Math.abs(dy) / visible.height
    ? dx < 0 ? 'left' : 'right'
    : dy < 0 ? 'up' : 'down';
  return { label: `已${action} · ${DIRECTION_LABEL[direction]} ${rects.length} 处`, direction, bounds };
}

/** 只看用户能在画布上看出来的那几样：位置、尺寸、标题、隐藏、当前版本。
 *  重载回来的文档与本地文档在别的字段上常有无关紧要的差异（补齐的空文本版本、规整过的层级），按整对象比会满屏闪。 */
function visibleSignature(node: CanvasNode) {
  const data = node.data as { current_version_id?: string | null };
  return JSON.stringify([node.position, node.size ?? null, node.title, node.hidden ?? false, data.current_version_id ?? null]);
}

/** 别处（Agent 经 MCP、另一标签页）改了画布之后：哪些节点是新放上来的，哪些看得出被改了。 */
export function canvasRemoteNodeChanges(before: CanvasDocument, after: CanvasDocument) {
  const previous = new Map(before.nodes.map(node => [node.id, node]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const node of after.nodes) {
    const old = previous.get(node.id);
    if (!old) added.push(node.id);
    else if (old !== node && visibleSignature(old) !== visibleSignature(node)) changed.push(node.id);
  }
  return { added, changed };
}

/** Advance only group-owned fields in the undo baseline. A simultaneous rename,
 * move or other external edit still gets its own undo entry. */
export function withGroupRunResults(before: CanvasDocument, after: CanvasDocument, jobs: Job[]): CanvasDocument {
  const runs = new Set<string>();
  const versions = new Set<string>();
  for (const job of jobs) {
    if (!job.canvas_run?.snapshot?.normalized_params?.group_run) continue;
    runs.add(job.canvas_run.run_id);
    for (const candidate of job.canvas_run.candidates) {
      if (candidate.version_id) versions.add(candidate.version_id);
    }
  }
  if (!runs.size) return before;
  const targets = new Map(after.nodes.map(node => [node.id, node]));
  const contentVersions = { ...before.content_versions };
  for (const id of versions) {
    if (after.content_versions[id]) contentVersions[id] = after.content_versions[id];
  }
  const nodes = before.nodes.map(node => {
    const target = targets.get(node.id);
    if (!target || !('current_version_id' in node.data) || !('current_version_id' in target.data)) return node;
    const active = target.data.active_run_id;
    const current = target.data.current_version_id;
    const takeRun = runs.has(active ?? '') || (!active && runs.has(node.data.active_run_id ?? ''));
    const takeVersion = current && versions.has(current) && !before.content_versions[current];
    if (!takeRun && !takeVersion) return node;
    const frame = takeVersion ? groupResultFrame(node, target, before.content_versions) : {};
    return { ...node, ...(frame.size ? {size: frame.size} : {}), data: { ...node.data,
      ...(frame.display ? {display: frame.display} : {}),
      active_run_id: takeRun ? active : node.data.active_run_id,
      current_version_id: takeVersion ? current : node.data.current_version_id,
    } } as CanvasNode;
  });
  return { ...before, nodes, content_versions: contentVersions };
}

// Only accept the group's fixed frame when it matches the actual pre-run dimensions.
// Independent local resizes and display changes remain part of the user's history.
export function groupResultFrame(node: CanvasNode, target: CanvasNode, versions: CanvasDocument['content_versions']) {
  if ((node.type !== 'image' && node.type !== 'video') || (target.type !== 'image' && target.type !== 'video')
    || node.data.display.free_resize || !target.data.display.free_resize) return {};
  const old = canvasNodeRenderedSize(node, versions);
  const next = canvasNodeRenderedSize(target, versions);
  if (old.width !== next.width || old.height !== next.height) return {};
  return {size: target.size, display: {...node.data.display, free_resize: true}};
}
