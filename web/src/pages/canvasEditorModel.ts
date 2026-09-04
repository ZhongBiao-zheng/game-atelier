import { imageControlCaps, MJ_IMAGES_PER_TASK, type Quality } from '@/lib/imageControlCaps';
import {
  normalizeStudioSizeForModel,
  studioSizeFor,
  type Resolution,
} from '@/lib/studioSize';
import type { Job, JobParams } from '@/schema/jobs';
import { modelModality, type KeyView } from '@/api/keys';
import {
  normalizeAudioFormat,
  normalizeAudioSpeed,
  normalizeAudioVoice,
} from '@/lib/audioGeneration';
import type {
  CanvasContentNode,
  CanvasBatchMaterialNode,
  CanvasContentVersion,
  CanvasGenerationDefault,
  CanvasGenerationMode,
  CanvasGenerationParamsByMode,
  CanvasGenerationDraft,
  CanvasDocument,
  CanvasMediaVersion,
  CanvasNode,
  CanvasPoint,
  CanvasMediaOperation,
  CanvasSize,
} from '@/schema/canvas';
import {
  videoControlCaps,
  type VideoControlCaps,
  type VideoQuality,
} from '@/lib/videoControlCaps';

/** 把轮询回来的 job 列表并进本地列表。
 *
 *  轮询以前是整体赋值。提交 / 重试 / 取消都会先乐观写一条 job 进来做即时回显，而轮询请求发出
 *  到响应落地之间还夹着一次 getCanvasDocument，窗口宽到足以跨过一次提交：整体赋值会把那条刚
 *  提交的 pending job 抹掉，hasRunningJobs 随之为假，轮询 effect 自己卸载，界面就永远停在
 *  旧状态，且没有任何报错。
 *
 *  服务端对它返回的每一条都是权威的，所以本地同 id 的一律被覆盖；只有服务端这次没返回的本地
 *  条目才保留下来。服务端真删掉某条时，下一轮（本地没有并发写入）会走整体赋值，自动收敛。 */
export function acceptCanvasJobs(local: readonly Job[], remote: readonly Job[]): Job[] {
  const remoteIds = new Set(remote.map(job => job.job_id));
  const localOnly = local.filter(job => !remoteIds.has(job.job_id));
  return localOnly.length ? [...remote, ...localOnly] : [...remote];
}

export function upsertCanvasJob(local: readonly Job[], job: Job): Job[] {
  return [...local.filter(item => item.job_id !== job.job_id), job];
}

/** 后端 CanvasSize 是 Field(gt=0, le=4000)。超界的那一次自动保存返回 422，而 422 在界面上被
 *  归到「保存冲突，内容已保留」——用户以为没事，实际之后每一次编辑都不再落盘，且没有恢复路径。
 *  所以尺寸必须在写入本地文档之前就夹住，而不是等服务端拒绝。 */
export const CANVAS_MAX_NODE_SIZE = 4000;

export function clampCanvasNodeSize(size: CanvasSize): CanvasSize {
  const width = Math.min(CANVAS_MAX_NODE_SIZE, Math.max(1, size.width));
  const height = Math.min(CANVAS_MAX_NODE_SIZE, Math.max(1, size.height));
  return width === size.width && height === size.height ? size : { width, height };
}

export interface CanvasPlacementBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const CANVAS_TEXT_NODE_DEFAULT_SIZE: CanvasSize = { width: 256, height: 144 };
export const CANVAS_DEFAULT_NODE_SIZE: CanvasSize = { width: 320, height: 176 };
const CANVAS_LAYER_STACK_PANEL_WIDTH = 288;
const CANVAS_LAYER_STACK_PREVIEW_WIDTH = 480;
const CANVAS_LAYER_STACK_PREVIEW_MIN_WIDTH = 320;
const CANVAS_LAYER_STACK_PREVIEW_MIN_HEIGHT = 400;
const CANVAS_LAYER_STACK_PREVIEW_MAX_HEIGHT = 640;
const CANVAS_NODE_PLACEMENT_GAP = 48;

function canvasPlacementDirectionRank({ x, y }: { x: number; y: number }) {
  return x > 0 && y === 0 ? 0
    : x === 0 && y > 0 ? 1
      : x < 0 && y === 0 ? 2
        : x === 0 && y < 0 ? 3
          : y > 0 ? 4 : 5;
}

export function sizeLockedToCanvasVersion(
  current: CanvasNode['size'],
  version: CanvasMediaVersion,
) {
  if (!version.width || !version.height) return current ?? CANVAS_DEFAULT_NODE_SIZE;
  const ratio = version.width / version.height;
  let width = Math.min(4000, Math.max(240, current?.width ?? CANVAS_DEFAULT_NODE_SIZE.width));
  let height = width / ratio;
  if (height < 150) {
    height = 150;
    width = height * ratio;
  }
  if (height > 4000) {
    height = 4000;
    width = height * ratio;
  }
  if (width > 4000) {
    width = 4000;
    height = width / ratio;
  }
  return { width: Math.round(width), height: Math.round(height) };
}

/** 图层栈左侧预览随源图比例伸缩，右侧设置区维持固定宽度。
 *
 * 横图优先保留足够的预览宽度，竖图优先保留足够的预览高度；两端都设上限，避免超长图把
 * 新节点撑到远离当前视口。实际像素不会决定画布尺寸，避免一张 8K 图创建出 4000px 节点。 */
export function layerStackSizeForCanvasVersion(
  version: Pick<CanvasMediaVersion, 'width' | 'height'>,
): CanvasSize {
  if (!version.width || !version.height) return { width: 760, height: 480 };
  const ratio = version.width / version.height;
  let previewWidth = CANVAS_LAYER_STACK_PREVIEW_WIDTH;
  let previewHeight = CANVAS_LAYER_STACK_PREVIEW_WIDTH / ratio;
  if (previewHeight > CANVAS_LAYER_STACK_PREVIEW_MAX_HEIGHT) {
    previewHeight = CANVAS_LAYER_STACK_PREVIEW_MAX_HEIGHT;
    previewWidth = Math.max(CANVAS_LAYER_STACK_PREVIEW_MIN_WIDTH, previewHeight * ratio);
  } else {
    previewHeight = Math.max(CANVAS_LAYER_STACK_PREVIEW_MIN_HEIGHT, previewHeight);
  }
  return {
    width: Math.round(previewWidth + CANVAS_LAYER_STACK_PANEL_WIDTH),
    height: Math.round(previewHeight),
  };
}

/** 未提交的图层栈跟随唯一上游图片的当前版本；运行中与已完成节点保持快照不变。 */
export function syncDraftLayerStackSources(document: CanvasDocument): CanvasDocument {
  const nodesById = new Map(document.nodes.map(node => [node.id, node]));
  const sourceNodeIdByStackId = new Map<string, string>();
  for (const connection of document.connections) {
    if (connection.role !== 'input' || connection.slot) continue;
    sourceNodeIdByStackId.set(connection.target_node_id, connection.source_node_id);
  }
  let changed = false;
  const nodes = document.nodes.map(node => {
    if (
      node.type !== 'layer_stack'
      || node.data.base_version_id
      || node.data.active_run_id
    ) return node;
    const sourceNode = nodesById.get(sourceNodeIdByStackId.get(node.id) ?? '');
    if (sourceNode?.type !== 'image' || !sourceNode.data.current_version_id) return node;
    const version = document.content_versions[sourceNode.data.current_version_id];
    if (version?.kind !== 'image' || version.version_id === node.data.source_version_id) return node;
    changed = true;
    return {
      ...node,
      size: layerStackSizeForCanvasVersion(version),
      data: { ...node.data, source_version_id: version.version_id, error: null },
    };
  });
  return changed ? { ...document, nodes } : document;
}

export function canvasNodeRenderedSize(
  node: CanvasNode,
  versions: Readonly<Record<string, CanvasContentVersion>>,
): CanvasSize {
  if (node.type === 'text') return node.size ?? CANVAS_TEXT_NODE_DEFAULT_SIZE;
  if (node.type !== 'image' || node.data.display.free_resize || !node.data.current_version_id) {
    return node.size ?? CANVAS_DEFAULT_NODE_SIZE;
  }
  const version = versions[node.data.current_version_id];
  return version?.kind === 'image'
    ? sizeLockedToCanvasVersion(node.size, version)
    : node.size ?? CANVAS_DEFAULT_NODE_SIZE;
}

/** Group membership is explicit; its frame follows its members, never creates dependencies. */
export function normalizeCanvasGroups(document: CanvasDocument): CanvasDocument {
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  return { ...document, nodes: document.nodes.map(node => {
    if (node.type !== 'group') return node;
    const members = node.data.member_node_ids.flatMap(id => {
      const member = byId.get(id);
      return member && member.type !== 'group' ? [member] : [];
    });
    if (!members.length) return { ...node, data: { ...node.data, member_node_ids: [] } };
    const x = Math.min(...members.map(member => member.position.x)) - 24;
    const y = Math.min(...members.map(member => member.position.y)) - 40;
    const right = Math.max(...members.map(member => member.position.x + canvasNodeRenderedSize(member, document.content_versions).width)) + 24;
    const bottom = Math.max(...members.map(member => member.position.y + canvasNodeRenderedSize(member, document.content_versions).height)) + 24;
    const size = { width: right - x, height: bottom - y };
    if (node.position.x === x && node.position.y === y && node.size?.width === size.width
      && node.size?.height === size.height && members.length === node.data.member_node_ids.length) return node;
    return { ...node, position: { x, y }, size, data: { ...node.data, member_node_ids: members.map(member => member.id) } };
  }) };
}

/** 从期望位置开始，按网格圈由内向外找一个不与现有节点重叠的点。
 *
 * React Flow 官方的新节点示例把屏幕坐标先交给 screenToFlowPosition；这里只负责转换之后的
 * 单节点放置。整张图自动布局会改动用户已经摆好的节点，不适合「点一下工具栏加一个节点」，
 * 所以只移动新节点，并优先把它留在当前可视区。 */
export function placeCanvasNodeWithoutOverlap(
  preferred: CanvasPoint,
  nodes: readonly CanvasNode[],
  size: CanvasSize,
  bounds?: CanvasPlacementBounds,
  resolveNodeSize: (node: CanvasNode) => CanvasSize = node => (
    node.size ?? (node.type === 'text' ? CANVAS_TEXT_NODE_DEFAULT_SIZE : CANVAS_DEFAULT_NODE_SIZE)
  ),
): CanvasPoint {
  const stepX = size.width + CANVAS_NODE_PLACEMENT_GAP;
  const stepY = size.height + CANVAS_NODE_PLACEMENT_GAP;
  const rings = Math.min(24, Math.max(4, Math.ceil(Math.sqrt(nodes.length + 1)) + 2));
  const offsets: Array<{ x: number; y: number }> = [];
  for (let y = -rings; y <= rings; y += 1) {
    for (let x = -rings; x <= rings; x += 1) offsets.push({ x, y });
  }
  offsets.sort((left, right) => {
    const leftRing = Math.max(Math.abs(left.x), Math.abs(left.y));
    const rightRing = Math.max(Math.abs(right.x), Math.abs(right.y));
    if (leftRing !== rightRing) return leftRing - rightRing;
    const leftDirection = canvasPlacementDirectionRank(left);
    const rightDirection = canvasPlacementDirectionRank(right);
    if (leftDirection !== rightDirection) return leftDirection - rightDirection;
    const leftDistance = (left.x * stepX) ** 2 + (left.y * stepY) ** 2;
    const rightDistance = (right.x * stepX) ** 2 + (right.y * stepY) ** 2;
    return leftDistance - rightDistance;
  });

  const overlaps = (position: CanvasPoint) => nodes.some(node => {
    const occupied = resolveNodeSize(node);
    return position.x < node.position.x + occupied.width + CANVAS_NODE_PLACEMENT_GAP
      && position.x + size.width + CANVAS_NODE_PLACEMENT_GAP > node.position.x
      && position.y < node.position.y + occupied.height + CANVAS_NODE_PLACEMENT_GAP
      && position.y + size.height + CANVAS_NODE_PLACEMENT_GAP > node.position.y;
  });
  const insideBounds = (position: CanvasPoint) => !bounds || (
    position.x >= bounds.left
    && position.y >= bounds.top
    && position.x + size.width <= bounds.right
    && position.y + size.height <= bounds.bottom
  );
  const candidates = offsets.map(offset => ({
    x: preferred.x + offset.x * stepX,
    y: preferred.y + offset.y * stepY,
  }));
  return candidates.find(position => insideBounds(position) && !overlaps(position))
    ?? candidates.find(position => !overlaps(position))
    ?? preferred;
}

/** 前端新造的文本 Content Version 用全零 sha256 占位，服务端落盘时改写成真实摘要。
 *  所以「sha256 还是占位值」精确等价于「服务端还没接收过这个版本」。 */
export const CANVAS_LOCAL_VERSION_SHA = '0'.repeat(64);

export function canvasVersionIsPersisted(version: CanvasContentVersion) {
  return version.sha256 !== CANVAS_LOCAL_VERSION_SHA;
}

/** 把服务端返回的 Content Version 合并进本地文档。
 *
 *  服务端拥有已持久化版本的 sha256 与 created_at，并且把「已存在版本的任何差异」当致命错误
 *  （canvas_projects.py 的 existing canvas content versions are immutable → 422）。所以共有
 *  id 一律以服务端为准，只有服务端还没见过的本地版本原样保留。反过来写（本地覆盖服务端）会让
 *  本地永久留着占位 sha256，之后每一次保存都提交一份服务端已判非法的数据，且无法自愈。 */
export function acceptServerContentVersions(
  local: Readonly<Record<string, CanvasContentVersion>>,
  server: Readonly<Record<string, CanvasContentVersion>>,
): Record<string, CanvasContentVersion> {
  return { ...local, ...server };
}

/** 撤销 / 重做时恢复 Content Version。
 *
 *  两条不变式决定了这里既不能整份用快照、也不能整份用当前值：
 *  - Content Version 只增不删（隐藏用 tombstone）。而且省略一个服务端已持久化的版本会被
 *    服务端判成「修改了已存在版本」，同样 422。所以任何情况下都不丢版本。
 *  - 已持久化版本不可变。用旧快照里的占位 sha256 覆盖它会把保存永久锁死。
 *
 *  于是：只把「服务端还没接收」的版本回退到快照里的内容，其余原样保留。节点的
 *  current_version_id 指针由快照的 nodes 负责回退，撤销靠改指针而不是删版本。 */
export function restoreContentVersions(
  snapshot: Readonly<Record<string, CanvasContentVersion>>,
  current: Readonly<Record<string, CanvasContentVersion>>,
): Record<string, CanvasContentVersion> {
  const restored: Record<string, CanvasContentVersion> = { ...current };
  for (const [versionId, version] of Object.entries(snapshot)) {
    if (canvasVersionIsPersisted(restored[versionId] ?? version)) continue;
    restored[versionId] = version;
  }
  return restored;
}

export function canvasNodeActiveRunId(node: CanvasNode): string | null {
  return 'active_run_id' in node.data ? node.data.active_run_id ?? null : null;
}

/** 生成进行中的节点为什么不能删。
 *
 *  厂商调用已经发出并且要计费，而服务端 finalize 只在结果节点还在文档里时才把产物挂回节点上：
 *  删掉它，run 照跑照扣钱，产物落进 content_versions 后没有任何节点指向它，画布上永远看不到，
 *  也没有回收入口。取消运行中的 run 目前没有接口，所以只能拦住并说清原因，不能替用户
 *  「删了顺便取消」。 */
export function canvasDeletionBlockedMessage(
  nodes: readonly CanvasNode[],
  nodeIds: ReadonlySet<string>,
  jobsByRunId: ReadonlyMap<string, Job>,
): string | null {
  // 判据与节点角标同源：看 job 是否还在跑，不看 active_run_id 是否非空。
  // 内容节点的 active_run_id 在生成结束后不清（角标靠它找到 job 显示「生成完成 / 失败原因」），
  // 单看它非空会把所有生成过的节点永久判成「正在生成」。
  const blocked = nodes.filter(node => {
    if (!nodeIds.has(node.id)) return false;
    const runId = canvasNodeActiveRunId(node);
    if (runId === null) return false;
    const status = jobsByRunId.get(runId)?.status;
    return status === 'pending' || status === 'pending_confirm';
  });
  if (blocked.length === 0) return null;
  if (blocked.length === 1) return `「${blocked[0].title}」正在生成，结束后才能删除。`;
  return `选中的节点里有 ${blocked.length} 个正在生成，结束后才能删除。`;
}

export interface CanvasMediaOperationPlaceholder {
  id: string;
  sourceNodeId: string;
  position: { x: number; y: number };
  size: CanvasSize;
  label: string;
}

const MEDIA_OPERATION_PLACEHOLDER_LABEL: Record<CanvasMediaOperation['kind'], string> = {
  crop: '裁剪中…',
  split: '切图中…',
  upscale: '放大中…',
  remove_background: '抠图中…',
};

/** 本地媒体操作是同步接口，结果节点要等处理完才从服务端回来。这段空档给用户一个占位节点，
 *  落点镜像服务端 canvas_media_operations 的公式（源节点右侧 96px、垂直居中、长边 320 / 切图 240），
 *  结果一到就撤掉换成真节点。服务端为避让已有节点可能再做纵向偏移，占位不追。 */
export function canvasMediaOperationPlaceholder(
  source: CanvasNode,
  version: { width: number; height: number },
  operation: CanvasMediaOperation,
): CanvasMediaOperationPlaceholder {
  const sourceWidth = source.size?.width ?? 320;
  const sourceHeight = source.size?.height ?? 176;
  const preferred = operation.kind === 'split' ? 240 : 320;
  const longEdge = Math.max(version.width, version.height);
  const shortEdge = Math.min(version.width, version.height);
  let scale = Math.max(preferred / longEdge, 80 / shortEdge);
  if (longEdge * scale > 1600) scale = 1600 / longEdge;
  const size = { width: version.width * scale, height: version.height * scale };
  return {
    id: `placeholder-${operation.kind}`,
    sourceNodeId: source.id,
    position: {
      x: source.position.x + sourceWidth + 96,
      y: source.position.y + (sourceHeight - size.height) / 2,
    },
    size,
    label: MEDIA_OPERATION_PLACEHOLDER_LABEL[operation.kind],
  };
}

export function canvasNodeAcceptsInput(node: CanvasNode) {
  return node.type !== 'group'
    && node.type !== 'plugin'
    && node.type !== 'batch_material'
    && node.type !== 'layer_stack';
}

export function canvasNodeProvidesContent(node: CanvasNode): node is CanvasContentNode {
  return node.type === 'text' || node.type === 'image' || node.type === 'video' || node.type === 'audio';
}

export function canvasNodeRenderZIndex(
  persistedZIndex: number,
  selected: boolean,
  maximumPersistedZIndex: number,
) {
  return selected ? Math.max(persistedZIndex, maximumPersistedZIndex) + 1 : persistedZIndex;
}

export function canvasNodeHasCurrentContent(
  node: CanvasNode,
  versions: Readonly<Record<string, CanvasContentVersion>>,
): node is CanvasContentNode {
  if (!canvasNodeProvidesContent(node) || !node.data.current_version_id) return false;
  return versions[node.data.current_version_id]?.kind === node.type;
}

/** 内容节点即使还没有内容也能当连线源：「先把图连起来，再逐个生成」是画布上最自然的用法。
 *
 *  代价是提交时那些还空着的输入会被服务端整单拒绝，所以空输入必须在生成按钮上就被拦住并指名，
 *  见 canvasPendingInputNodes 和 referenceErrorMessage。
 *
 *  四类内容节点一视同仁之后就不再需要版本表了：canvasNodeHasCurrentContent 的第一道判据也是
 *  canvasNodeProvidesContent，`A || (A && …)` 恒等于 A。留着那个参数只会逼调用方去拿全量版本表
 *  （节点卡因此每一次按键都要重渲染，见 CanvasEditor 里 resolveVersion 的说明）。 */
export function canvasNodeProvidesOutput(node: CanvasNode): node is CanvasContentNode | CanvasBatchMaterialNode {
  return canvasNodeProvidesContent(node) || node.type === 'batch_material';
}

export interface CanvasPendingInput {
  nodeId: string;
  title: string;
}

/** A different batch source needs a new confirmation, including when retrying a result. */
export function canvasRequiresBatchRun(document: CanvasDocument | null, nodeId: string): boolean {
  if (!document) return false;
  const nodes = new Map(document.nodes.map(node => [node.id, node]));
  const target = nodes.get(nodeId);
  const boundSourceId = target && canvasNodeProvidesContent(target) ? target.data.batch_result?.source_node_id : null;
  return document.connections.some(connection => connection.role === 'input'
    && connection.target_node_id === nodeId
    && nodes.get(connection.source_node_id)?.type === 'batch_material'
    && connection.source_node_id !== boundSourceId);
}

/** 每个目标节点上「已连接但还没有内容」的输入源。
 *
 *  只看不带 slot 的 input 连线：首尾帧模式下服务端会把不带 slot 的连线全部丢掉，带 slot 的那两条
 *  由 missingVideoFrame 单独把关。 */
export function canvasPendingInputNodes(
  document: CanvasDocument | null,
): Map<string, CanvasPendingInput[]> {
  const result = new Map<string, CanvasPendingInput[]>();
  if (!document) return result;
  const nodes = new Map(document.nodes.map(node => [node.id, node]));
  for (const connection of document.connections) {
    if (connection.role !== 'input' || connection.slot) continue;
    const source = nodes.get(connection.source_node_id);
    if (!source || canvasNodeHasCurrentContent(source, document.content_versions)) continue;
    if (source.type === 'batch_material') {
      const target = nodes.get(connection.target_node_id);
      const binding = target && canvasNodeProvidesContent(target) ? target.data.batch_result : null;
      if (binding?.source_node_id === source.id) {
        if (binding.image_version_ids.length && binding.image_version_ids.every(
          id => document.content_versions[id]?.kind === 'image',
        )) continue;
      } else if (source.data.items.length) continue;
    }
    const pending = result.get(connection.target_node_id) ?? [];
    pending.push({ nodeId: source.id, title: source.title });
    result.set(connection.target_node_id, pending);
  }
  return result;
}

export function canCreateCanvasInputConnection(
  document: CanvasDocument | null,
  connection: { source: string | null; target: string | null },
) {
  if (!document || !connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }
  const source = document.nodes.find(node => node.id === connection.source);
  const target = document.nodes.find(node => node.id === connection.target);
  if (
    !source
    || !target
    || !canvasNodeProvidesOutput(source)
    || !canvasNodeAcceptsInput(target)
  ) {
    return false;
  }
  return !document.connections.some(edge => (
    edge.role === 'input'
    && edge.source_node_id === connection.source
    && edge.target_node_id === connection.target
  ));
}

export function closestCanvasConnectionEndpoint(
  pointer: { x: number; y: number },
  nodes: ReadonlyArray<{
    id: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
  side: 'left' | 'right',
  maximumDistance = 32,
) {
  let nearest: { id: string; distance: number } | null = null;
  for (const node of nodes) {
    const besideNode = side === 'left' ? pointer.x < node.left : pointer.x > node.right;
    const alignedWithHandle = pointer.y >= node.top && pointer.y <= node.bottom;
    if (!besideNode || !alignedWithHandle) continue;
    const distance = Math.min(
      Math.abs(node.left - pointer.x),
      Math.abs(node.right - pointer.x),
    );
    if (distance <= maximumDistance && (!nearest || distance < nearest.distance)) {
      nearest = { id: node.id, distance };
    }
  }
  return nearest?.id ?? null;
}

export function canvasConnectionCreationCapabilities(sourceHandle: 'source' | 'target') {
  return sourceHandle === 'target'
    ? { allowEmptyNodes: false, allowUpload: true, allowConfig: false }
    : { allowEmptyNodes: true, allowUpload: false, allowConfig: true };
}

export const CANVAS_GENERATION_MODE_LABELS: Record<CanvasGenerationDraft['mode'], string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
};

function isOpenAiHkBaseUrl(baseUrl: string | null | undefined) {
  return (baseUrl ?? '').toLowerCase().includes('openai-hk.com');
}

function canvasImageModelIsRoutable(key: KeyView, model: KeyView['models'][number]) {
  if (key.provider === 'nano_banana') return false;
  const family = imageControlCaps(model.id, key.provider).family;
  if (family === 'midjourney' || key.provider === 'openrouter') return true;
  if (!['openai', 'midjourney', 'seedream', 'tokendance', 'custom'].includes(key.provider)) {
    return false;
  }
  return model.protocol == null || ['openai', 'ark'].includes(model.protocol);
}

function canvasVideoModelIsRoutable(key: KeyView, model: KeyView['models'][number]) {
  const protocol = model.protocol ?? (() => {
    const id = model.id.toLowerCase();
    if (key.provider === 'seedance') return 'seedance';
    if (key.provider === 'openrouter') return 'openrouter';
    if (key.provider === 'tokendance') {
      if (id.includes('seedance')) return 'seedance';
      if (id.includes('happyhorse')) return 'dashscope';
    }
    if (id.startsWith('kling') && isOpenAiHkBaseUrl(key.base_url)) return 'kling';
    return null;
  })();
  if (!['seedance', 'kling', 'dashscope', 'openrouter'].includes(String(protocol))) return false;
  // Canvas Runner 明确拒绝 HappyHorse video-edit：它只收公网 URL，画布内容是本地版本。
  return protocol !== 'dashscope' || !model.id.toLowerCase().includes('video-edit');
}

export function canvasGenerationModelSupportsMode(
  key: KeyView,
  model: KeyView['models'][number],
  mode: CanvasGenerationDraft['mode'],
  options: { editingExistingVideo?: boolean } = {},
) {
  return modelModality(model, key) === mode
    && (mode !== 'image' || canvasImageModelIsRoutable(key, model))
    && (mode !== 'video' || canvasVideoModelIsRoutable(key, model))
    && (!options.editingExistingVideo || supportsCanvasVideoEdit(model.id, model.protocol))
    && (mode !== 'audio'
      || supportsCanvasAudioGeneration(model.id, key.provider, model.protocol))
    && (mode !== 'text'
      || supportsCanvasTextGeneration(key.provider, model.protocol));
}

export function firstCanvasGenerationModel(
  keys: readonly KeyView[],
  mode: CanvasGenerationDraft['mode'],
) {
  for (const key of keys) {
    const model = key.models.find(candidate => canvasGenerationModelSupportsMode(key, candidate, mode));
    if (model) return { key, model };
  }
  return null;
}

function preferredCanvasGenerationModel(
  keys: readonly KeyView[],
  mode: CanvasGenerationDraft['mode'],
  preference: CanvasGenerationDefault | undefined,
) {
  const selection = preference?.selection;
  if (!selection) return null;
  const key = keys.find(candidate => candidate.alias === selection.alias);
  const model = key?.models.find(candidate => candidate.id === selection.model);
  return key && model && canvasGenerationModelSupportsMode(key, model, mode)
    ? { key, model }
    : null;
}

function defaultCanvasGenerationParams(mode: CanvasGenerationDraft['mode']): JobParams {
  if (mode === 'image') return { n: 1, ratio: '1:1' };
  if (mode === 'video') {
    return {
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
      frame_mode: 'firstlast',
      generate_audio: true,
    };
  }
  if (mode === 'audio') return { voice: 'alloy', response_format: 'mp3', speed: 1 };
  return { n: 1, reasoning_effort: 'auto' };
}

function normalizedCanvasGenerationParams(
  key: KeyView,
  model: KeyView['models'][number],
  mode: CanvasGenerationDraft['mode'],
  current: JobParams,
) {
  if (mode === 'image') {
    return normalizeCanvasImageParams(
      model.id,
      key.provider,
      current,
      key.base_url,
    );
  }
  if (mode === 'video') return normalizeCanvasVideoParams(model.id, model.protocol, current);
  if (mode === 'audio') {
    return normalizeCanvasAudioParams(model.id, key.provider, model.protocol, current);
  }
  return normalizeCanvasTextParams(model.protocol, current);
}

export function canvasGenerationPreferenceForModel<M extends CanvasGenerationMode>(
  key: KeyView,
  model: KeyView['models'][number],
  mode: M,
  current: JobParams = {},
): CanvasGenerationDefault<M> | null {
  if (!canvasGenerationModelSupportsMode(key, model, mode)) return null;
  return {
    selection: { alias: key.alias, model: model.id },
    params: normalizedCanvasGenerationParams(
      key,
      model,
      mode,
      { ...defaultCanvasGenerationParams(mode), ...current },
    ) as CanvasGenerationParamsByMode[M],
  };
}

export function createCanvasGenerationDraft(
  keys: readonly KeyView[],
  mode: CanvasGenerationDraft['mode'],
  options: {
    prompt?: string;
    inputPolicy?: CanvasGenerationDraft['input_policy'];
    preference?: CanvasGenerationDefault;
    now?: string;
  } = {},
): CanvasGenerationDraft {
  const preferred = preferredCanvasGenerationModel(keys, mode, options.preference);
  const selected = preferred ?? firstCanvasGenerationModel(keys, mode);
  const model = selected?.model.id ?? '';
  const mayApplyPreferenceParams = preferred || options.preference?.selection === null;
  const sourceParams = mayApplyPreferenceParams
    ? { ...defaultCanvasGenerationParams(mode), ...options.preference?.params }
    : defaultCanvasGenerationParams(mode);
  const params = !selected
    ? {}
    : normalizedCanvasGenerationParams(selected.key, selected.model, mode, sourceParams);
  return {
    mode,
    prompt: options.prompt ?? '',
    input_policy: options.inputPolicy ?? 'mentions_only',
    model,
    alias: selected?.key.alias ?? null,
    params,
    updated_at: options.now ?? new Date().toISOString(),
  };
}

export function switchCanvasGenerationDraft(
  keys: readonly KeyView[],
  current: CanvasGenerationDraft,
  mode: CanvasGenerationDraft['mode'],
  options: { preference?: CanvasGenerationDefault; now?: string } = {},
) {
  if (mode === current.mode) return current;
  return createCanvasGenerationDraft(keys, mode, {
    prompt: current.prompt,
    inputPolicy: current.input_policy,
    preference: options.preference,
    now: options.now,
  });
}

export function createConnectedCanvasConfig(
  document: CanvasDocument,
  sourceNodeId: string,
  draft: CanvasGenerationDraft,
  ids: { nodeId: string; connectionId: string },
): CanvasDocument | null {
  if (
    document.nodes.some(node => node.id === ids.nodeId)
    || document.connections.some(connection => connection.id === ids.connectionId)
  ) return null;
  const source = document.nodes.find(node => node.id === sourceNodeId);
  if (!source || !canvasNodeHasCurrentContent(source, document.content_versions)) return null;
  const sourceWidth = source.size?.width ?? (source.type === 'text' ? 256 : 320);
  const token = `@[node:${source.id}]`;
  const prompt = draft.prompt.trim() ? `${draft.prompt.trim()} ${token}` : token;
  const configSize = CANVAS_DEFAULT_NODE_SIZE;
  const configNode: CanvasNode = {
    id: ids.nodeId,
    title: `${CANVAS_GENERATION_MODE_LABELS[draft.mode]}生成`,
    type: 'config',
    position: placeCanvasNodeWithoutOverlap(
      { x: source.position.x + sourceWidth + 96, y: source.position.y },
      document.nodes,
      configSize,
      undefined,
      node => canvasNodeRenderedSize(node, document.content_versions),
    ),
    z_index: 0,
    data: {
      draft: { ...draft, prompt, input_policy: 'mentions_only' },
    },
  };
  const nodes = [...document.nodes, configNode];
  if (!canCreateCanvasInputConnection({ ...document, nodes }, {
    source: source.id,
    target: configNode.id,
  })) return null;
  return {
    ...document,
    nodes,
    connections: [...document.connections, {
      id: ids.connectionId,
      role: 'input',
      source_node_id: source.id,
      target_node_id: configNode.id,
    }],
  };
}

export function normalizeCanvasImageParams(
  model: string,
  provider: string | null | undefined,
  current: JobParams,
  baseUrl?: string | null,
): JobParams {
  const caps = imageControlCaps(model, provider, baseUrl);
  const {
    quality: currentQuality,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    resolution: _resolution,
    size: _size,
    ...retained
  } = current;
  const currentRatio = String(current.ratio ?? '');
  const ratio = caps.ratios.includes(currentRatio) ? currentRatio : caps.ratios[0];
  const n = caps.family === 'midjourney'
    ? MJ_IMAGES_PER_TASK
    : Math.max(1, Math.min(4, Number(current.n) || 1));
  const params: JobParams = { ...retained, n, ratio };

  if (caps.showResolution && caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(current.resolution as Resolution)
      ? current.resolution
      : caps.resolutions[0];
  }
  if (caps.qualities?.length) {
    params.quality = caps.qualities.includes(currentQuality as Quality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.sizeKind === 'ratio') {
    params.size = ratio;
  } else if (caps.sizeKind === 'pixels') {
    const resolution = (params.resolution as Resolution | undefined) ?? '2K';
    const currentPixelSize = typeof current.size === 'string' && /^\d+x\d+$/.test(current.size)
      ? current.size
      : null;
    params.size = normalizeStudioSizeForModel(
      currentPixelSize ?? studioSizeFor(ratio, resolution, model),
      model,
    );
  }
  return params;
}

export function supportsCanvasTextReasoning(protocol: string | null | undefined) {
  return protocol === 'openai-responses';
}

export function supportsCanvasTextGeneration(
  provider: string | null | undefined,
  protocol: string | null | undefined,
) {
  const supportedProtocols = [null, undefined, 'openai', 'openai-chat', 'chat-completions', 'openai-responses'];
  const declared = protocol != null && supportedProtocols.includes(protocol);
  return supportedProtocols.includes(protocol)
    && (['openai', 'openrouter', 'seedream', 'tokendance', 'custom'].includes(String(provider)) || declared);
}

export function normalizeCanvasTextParams(
  protocol: string | null | undefined,
  current: JobParams,
): JobParams {
  const params: JobParams = {
    n: Math.max(1, Math.min(4, Number(current.n) || 1)),
  };
  if (typeof current.temperature === 'number' && protocol !== 'openai-responses') {
    params.temperature = current.temperature;
  }
  if (typeof current.max_tokens === 'number') params.max_tokens = current.max_tokens;
  if (
    supportsCanvasTextReasoning(protocol)
    && ['auto', 'low', 'medium', 'high', 'xhigh'].includes(String(current.reasoning_effort))
  ) {
    params.reasoning_effort = current.reasoning_effort;
  }
  return params;
}

export function supportsCanvasAudioGeneration(
  model: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
) {
  if (['openai', 'openai-speech', 'tts', 'speech'].includes(String(protocol))) return true;
  if (protocol != null || !['openai', 'custom'].includes(String(provider))) return false;
  const normalized = model.toLowerCase();
  if (['asr', 'speech-to-text', 'speech2text', 'whisper'].some(value => normalized.includes(value))) {
    return false;
  }
  return normalized.includes('tts') || normalized.includes('text-to-speech');
}

export function normalizeCanvasAudioParams(
  model: string,
  provider: string | null | undefined,
  protocol: string | null | undefined,
  current: JobParams,
): JobParams {
  if (!supportsCanvasAudioGeneration(model, provider, protocol)) return {};
  const params: JobParams = {
    voice: normalizeAudioVoice(current.voice),
    response_format: normalizeAudioFormat(current.response_format),
    speed: normalizeAudioSpeed(current.speed),
  };
  const instructions = String(current.instructions ?? '').trim();
  if (instructions) params.instructions = instructions;
  return params;
}

export function canvasVideoEditCaps(
  model: string,
  protocol: string | null | undefined,
): VideoControlCaps {
  return videoControlCaps(model, protocol);
}

export function supportsCanvasVideoEdit(
  model: string,
  protocol: string | null | undefined,
): boolean {
  const caps = canvasVideoEditCaps(model, protocol);
  // Canvas Content Version 永远是服务端本地文件；HappyHorse video-edit 只收公网 URL，
  // 不能把“协议支持”冒充成“当前空间可执行”。Seedance 会走项目已有 OSS 中转。
  return caps.supportsReferenceVideo && caps.family !== 'happyhorse';
}

export function normalizeCanvasVideoParams(
  model: string,
  protocol: string | null | undefined,
  current: JobParams,
  editingExistingVideo = false,
): JobParams {
  const caps = canvasVideoEditCaps(model, protocol);
  const {
    duration: currentDuration,
    resolution: currentResolution,
    ratio: currentRatio,
    mode: currentQuality,
    frame_mode: currentFrameMode,
    generate_audio: currentGenerateAudio,
    watermark: currentWatermark,
    reference_images: _referenceImages,
    reference_videos: _referenceVideos,
    reference_audios: _referenceAudios,
    n: _count,
    size: _size,
    quality: _imageQuality,
    mask_image: _mask,
    angle_horizontal: _angleHorizontal,
    angle_pitch: _anglePitch,
    angle_distance: _angleDistance,
    angle_wide: _angleWide,
    voice: _voice,
    speed: _speed,
    response_format: _responseFormat,
    instructions: _instructions,
    temperature: _temperature,
    max_tokens: _maxTokens,
    ...retained
  } = current;
  const params: JobParams = { ...retained };

  if (caps.durations.length) {
    const duration = Number(currentDuration);
    params.duration = caps.durations.includes(duration)
      ? duration
      : caps.durations.includes(5) ? 5 : caps.durations[0];
  }
  if (caps.resolutions.length) {
    params.resolution = caps.resolutions.includes(String(currentResolution))
      ? String(currentResolution)
      : caps.resolutions[0];
  }
  if (caps.ratios.length) {
    params.ratio = caps.ratios.includes(String(currentRatio))
      ? String(currentRatio)
      : caps.ratios.includes('16:9') ? '16:9' : caps.ratios[0];
  }
  if (caps.qualities?.length) {
    params.mode = caps.qualities.includes(currentQuality as VideoQuality)
      ? currentQuality
      : caps.qualities[0];
  }
  if (caps.supportsAudio) {
    params.generate_audio = typeof currentGenerateAudio === 'boolean'
      ? currentGenerateAudio
      : true;
  }
  if (caps.supportsWatermark) {
    params.watermark = typeof currentWatermark === 'boolean' ? currentWatermark : false;
  }
  const supportsFrameSlots = caps.modes.includes('firstlast');
  const supportsOmni = caps.modes.includes('omni');
  const usesFrameSlots = ['first', 'last', 'firstlast'].includes(String(currentFrameMode));
  if (editingExistingVideo || (!supportsFrameSlots && supportsOmni)) {
    params.frame_mode = 'auto';
  } else if (!supportsOmni && supportsFrameSlots) {
    params.frame_mode = 'firstlast';
  } else if (usesFrameSlots || currentFrameMode === 'auto') {
    params.frame_mode = currentFrameMode;
  } else {
    params.frame_mode = caps.modes[0] === 'omni' ? 'auto' : 'firstlast';
  }
  return params;
}

/** 生成动作无法提交的原因。按钮保持可点击，由点击动作把原因交给画布顶部反馈。 */
export type CanvasGenerateBlock = {
  kind: 'no_model_available' | 'no_model_selected' | 'no_prompt';
  message: string;
};

export function canvasGenerateBlock(input: {
  mode: CanvasGenerationDraft['mode'];
  modelChoiceCount: number;
  keyCount: number;
  alias: string | null | undefined;
  modelSelected: boolean;
  prompt: string;
}): CanvasGenerateBlock | null {
  if (input.modelChoiceCount === 0) {
    const label = CANVAS_GENERATION_MODE_LABELS[input.mode];
    return {
      kind: 'no_model_available',
      message: input.keyCount === 0
        ? '还没有配置任何模型密钥。'
        : `已配置的密钥里没有能做${label}生成的模型。`,
    };
  }
  if (!input.alias || !input.modelSelected) {
    return { kind: 'no_model_selected', message: '先在上方选择一个生成模型。' };
  }
  if (!input.prompt.trim()) {
    return { kind: 'no_prompt', message: '先填写提示词。' };
  }
  return null;
}
