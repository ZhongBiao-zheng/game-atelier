/** 结果组：一次生成出多张时，封面节点 + 其余结果各自的图片节点，收成一个可收起的组件。
 *
 *  - 封面就是这次生成的结果节点（持有生成草稿）；其余每张都是普通图片节点，全部工具可用。
 *  - 收起时只显示封面，连到成员的线画到封面上；展开后成员在封面右侧一字排开、跟着封面移动。
 *  - 拆成节点的时机：这次生成结束时（页面在场）或第一次点「展开」时（旧数据）。
 *    `result_stack.run_id` 记住已拆过的那次生成，成员被删后不会按同一批结果长回来。
 *  - 重新生成替换旧成员；连了线、做过标注或被图层引用的旧成员移出结果组，保留为普通节点。
 */
import type { CanvasDocument, CanvasImageNode, CanvasNode } from '@/schema/canvas';
import type { Job } from '@/schema/jobs';
import { presentCanvasCandidates } from '@/lib/canvasCandidates';
import { canvasNodeRenderedSize } from '@/pages/canvasEditorModel';

/** 展开后相邻两张之间的间距（画布坐标）。 */
export const RESULT_STACK_GAP = 16;

type ImageNode = CanvasImageNode;

function isImage(node: CanvasNode | undefined): node is ImageNode {
  return node?.type === 'image';
}

/** 成员 id → 封面 id；只认真实存在的图片成员。 */
export function resultStackOwners(nodes: readonly CanvasNode[]): Map<string, string> {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const owners = new Map<string, string>();
  for (const node of nodes) {
    if (!isImage(node)) continue;
    for (const id of node.data.result_stack?.member_node_ids ?? []) {
      if (isImage(byId.get(id)) && id !== node.id) owners.set(id, node.id);
    }
  }
  return owners;
}

/** 封面当前存在的成员节点，按结果组顺序。 */
export function resultStackMembers(document: CanvasDocument, cover: CanvasNode): ImageNode[] {
  if (!isImage(cover)) return [];
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  return (cover.data.result_stack?.member_node_ids ?? []).flatMap(id => {
    const node = byId.get(id);
    return isImage(node) && node.id !== cover.id ? [node] : [];
  });
}

/** 最近一次生成：已结束、且这次生成还没拆过时，返回需要拆成节点的其余结果版本。
 *  返回 null 表示没有需要拆的（还在生成、或这次生成已经拆过）。 */
export function pendingResultStack(cover: CanvasNode, jobs: readonly Job[] | undefined): {
  runId: string;
  versionIds: string[];
} | null {
  if (!isImage(cover) || !jobs?.length) return null;
  const latest = jobs[jobs.length - 1];
  const runId = latest.canvas_run?.run_id;
  if (!runId || latest.status === 'pending' || latest.status === 'pending_confirm') return null;
  if (cover.data.result_stack?.run_id === runId) return null;
  const versionIds = presentCanvasCandidates(jobs).current.flatMap(({ candidate }) => (
    candidate.status === 'succeeded' && candidate.version_id && candidate.version_id !== cover.data.current_version_id
      ? [candidate.version_id] : []
  ));
  return { runId, versionIds };
}

/** 旧成员被新一批替换时，是否得留下来：留下来的移出结果组、成为普通节点。 */
function memberInUse(document: CanvasDocument, member: ImageNode) {
  if (member.data.annotation) return true;
  if (document.connections.some(edge => edge.source_node_id === member.id || edge.target_node_id === member.id)) {
    return true;
  }
  return document.nodes.some(node => node.type === 'layer_stack' && (
    node.data.base_material_node_id === member.id
    || node.data.layers.some(layer => layer.material_node_id === member.id)
  ));
}

/** 把封面最近一次生成的其余结果拆成成员节点，替换旧成员，并排好位置。 */
export function settleResultStack(
  document: CanvasDocument,
  coverId: string,
  pending: { runId: string; versionIds: string[] },
  makeNodeId: () => string,
): CanvasDocument {
  const cover = document.nodes.find(node => node.id === coverId);
  if (!isImage(cover)) return document;
  const previous = resultStackMembers(document, cover);
  const removed = new Set(previous.filter(member => !memberInUse(document, member)).map(member => member.id));
  const created: ImageNode[] = pending.versionIds.map((versionId, index) => ({
    id: makeNodeId(),
    type: 'image',
    title: `${cover.title} · ${index + 2}`.slice(0, 120),
    position: cover.position,
    // 同一批的图比例相同，跟封面一样大，展开后排成齐整的一行。
    size: cover.size ?? null,
    z_index: cover.z_index,
    hidden: false,
    data: {
      current_version_id: versionId,
      generation_draft: null,
      active_run_id: null,
      display: { ...cover.data.display },
    },
  }));
  const nextCover: ImageNode = {
    ...cover,
    data: {
      ...cover.data,
      result_stack: { run_id: pending.runId, member_node_ids: created.map(node => node.id) },
    },
  };
  const nodes = document.nodes.flatMap(node => {
    if (removed.has(node.id)) return [];
    if (node.id === coverId) return [nextCover];
    return [node];
  });
  return layoutResultStack({ ...document, nodes: [...nodes, ...created] }, coverId);
}

/** 成员在封面右侧一字排开、与封面顶端对齐。 */
export function layoutResultStack(document: CanvasDocument, coverId: string): CanvasDocument {
  const cover = document.nodes.find(node => node.id === coverId);
  if (!isImage(cover)) return document;
  const members = resultStackMembers(document, cover);
  if (!members.length) return document;
  const positions = new Map<string, { x: number; y: number }>();
  let x = cover.position.x + canvasNodeRenderedSize(cover, document.content_versions).width + RESULT_STACK_GAP;
  for (const member of members) {
    positions.set(member.id, { x, y: cover.position.y });
    x += canvasNodeRenderedSize(member, document.content_versions).width + RESULT_STACK_GAP;
  }
  let changed = false;
  const nodes = document.nodes.map(node => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.position.x && position.y === node.position.y)) return node;
    changed = true;
    return { ...node, position };
  });
  return changed ? { ...document, nodes } : document;
}

/** 每次提交后维持结果组的不变式：
 *  - 封面被删，成员连同它们的连线一起删（结果组是一个组件）；
 *  - 成员始终排在封面右侧：封面移动、改尺寸、换图、成员被删后都重新排一次。 */
export function normalizeResultStacks(next: CanvasDocument, previous: CanvasDocument): CanvasDocument {
  const nextIds = new Set(next.nodes.map(node => node.id));
  const orphaned = new Set<string>();
  for (const node of previous.nodes) {
    if (!isImage(node) || nextIds.has(node.id)) continue;
    for (const id of node.data.result_stack?.member_node_ids ?? []) {
      if (nextIds.has(id)) orphaned.add(id);
    }
  }
  let document = orphaned.size ? {
    ...next,
    nodes: next.nodes.filter(node => !orphaned.has(node.id)),
    connections: next.connections.filter(edge => (
      !orphaned.has(edge.source_node_id) && !orphaned.has(edge.target_node_id)
    )),
  } : next;
  for (const node of document.nodes) {
    if (isImage(node) && node.data.result_stack?.member_node_ids.length) {
      document = layoutResultStack(document, node.id);
    }
  }
  return document;
}

/** 设为封面：封面与该成员交换图片（连同标注与打码），各自的连线跟着图片走。 */
export function swapResultStackCover(document: CanvasDocument, coverId: string, memberId: string): CanvasDocument {
  const cover = document.nodes.find(node => node.id === coverId);
  const member = document.nodes.find(node => node.id === memberId);
  if (!isImage(cover) || !isImage(member)) return document;
  const take = (target: ImageNode, source: ImageNode): ImageNode => ({
    ...target,
    hidden: source.hidden,
    data: {
      ...target.data,
      current_version_id: source.data.current_version_id,
      annotation: source.data.annotation ?? null,
    },
  });
  const swapId = (id: string) => (id === coverId ? memberId : id === memberId ? coverId : id);
  return layoutResultStack({
    ...document,
    nodes: document.nodes.map(node => (
      node.id === coverId ? take(cover, member) : node.id === memberId ? take(member, cover) : node
    )),
    connections: document.connections.map(edge => {
      const source = swapId(edge.source_node_id);
      const target = swapId(edge.target_node_id);
      return source === edge.source_node_id && target === edge.target_node_id
        ? edge : { ...edge, source_node_id: source, target_node_id: target };
    }),
  }, coverId);
}
