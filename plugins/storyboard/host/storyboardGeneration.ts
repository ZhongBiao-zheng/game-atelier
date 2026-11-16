/** 分镜的逐镜生成：把选中的镜头变成一份「生成计划」，确认后原样应用到画布并逐镜提交。
 *
 *  计划是确认弹窗的唯一数据来源，也是提交时的唯一依据：弹窗显示的镜头数、模型、花费都从它算出；
 *  应用时只建计划里的节点、只写计划里冻结的草稿。确认之后新增的镜头不在计划里，改过的提示词也不会被带上。
 *  每个镜头是画布上一个普通的图片或视频节点，各自一次独立的生成任务。 */
import type { KeyView } from '@/api/keys';
import {
  STORYBOARD_DEFAULT_SIZE, isStoryboardNode, resolveStoryboardBinding, storyboardPayloadOf, storyboardShotLabel,
  type StoryboardEntity, type StoryboardPayload, type StoryboardShot,
} from './canvasStoryboard';
import { estimateGenerationCostForSubmission } from '@/lib/generationCost';
import { providerForAlias, routeChannel } from '@/lib/modelRoutes';
import {
  canvasNodeHasCurrentContent, canvasVideoEditCaps, createCanvasGenerationDraft, placeCanvasNodeWithoutOverlap,
} from '@/pages/canvasEditorModel';
import type {
  CanvasConnection, CanvasDocument, CanvasGenerationDefault, CanvasGenerationDraft, CanvasNode, JsonValue,
} from '@/schema/canvas';

export type ShotGenerationKind = 'image' | 'video';

export interface ShotGenerationItem {
  shotId: string;
  label: string;
  nodeId: string;
  /** 要新建的节点；该镜已有节点时为 null，只写草稿。 */
  create: CanvasNode | null;
  connections: CanvasConnection[];
  /** 确认时冻结的提示词、模型与参数。 */
  draft: CanvasGenerationDraft;
  /** 这一镜的预计花费；模型没有价格时为 null。 */
  cost: number | null;
}

export interface ShotGenerationPlan {
  storyboardNodeId: string;
  kind: ShotGenerationKind;
  items: ShotGenerationItem[];
  /** 选中了但这次不会生成的镜头，以及原因。 */
  skipped: Array<{ shotId: string; label: string; reason: string }>;
  /** 计划里用到的模型名称（去重）。 */
  models: string[];
  /** 全部有价格时是各镜之和；有任何一镜未计价时为 null。 */
  totalCost: number | null;
  unpricedCount: number;
}

export interface ShotGenerationDeps {
  providers: readonly KeyView[];
  preference?: CanvasGenerationDefault;
  newId: (prefix: string) => string;
}

const COLUMNS = 5;
const CELL_WIDTH = 320;
const GAP = 48;
const TITLE_SPACE = 40;
const ENTITY_ORDER: Record<StoryboardEntity['kind'], number> = { character: 0, scene: 1, prop: 2 };

export const NO_IMAGE_FOR_VIDEO = '先出图，视频用这一镜的图作首帧';

function cellHeight(ratio: string): number {
  const [width, height] = ratio.split(':').map(Number);
  return width > 0 && height > 0 ? Math.round(CELL_WIDTH * height / width) : 180;
}

/** 镜头节点的网格位置：分镜节点右侧，每行 5 镜，图在上、视频在下。 */
export function shotCellPosition(storyboard: CanvasNode, index: number, ratio: string, kind: ShotGenerationKind) {
  const height = cellHeight(ratio);
  const rowHeight = (height + TITLE_SPACE + GAP) * 2;
  return {
    x: storyboard.position.x + (storyboard.size?.width ?? STORYBOARD_DEFAULT_SIZE.width) + 96 + (index % COLUMNS) * (CELL_WIDTH + GAP),
    y: storyboard.position.y + Math.floor(index / COLUMNS) * rowHeight + (kind === 'video' ? height + TITLE_SPACE + GAP : 0),
  };
}

/** 本镜涉及的条目，顺序固定为角色、场景、道具。 */
export function shotEntities(payload: StoryboardPayload, shot: StoryboardShot): StoryboardEntity[] {
  return payload.entities.filter(entity => shot.entity_ids.includes(entity.id))
    .sort((a, b) => ENTITY_ORDER[a.kind] - ENTITY_ORDER[b.kind]);
}

/** 出图提示词 = 风格前缀 + 这一镜的提示词 + 涉及条目的固定描述逐条原文。 */
export function composeShotImagePrompt(payload: StoryboardPayload, shot: StoryboardShot): string {
  return [
    payload.style_prefix.trim(),
    (shot.image_prompt.trim() || shot.visual.trim()),
    ...shotEntities(payload, shot).filter(entity => entity.name && entity.description.trim())
      .map(entity => `${entity.name}：${entity.description.trim()}`),
  ].filter(Boolean).join('\n');
}

function costOf(providers: readonly KeyView[], draft: CanvasGenerationDraft, kind: ShotGenerationKind): number | null {
  return estimateGenerationCostForSubmission(providerForAlias(providers, draft.alias), draft.model, kind, draft.params);
}

/** 时长取模型支持的档位里不小于计划时长的最小值；都比它短就取最长一档。 */
function videoDuration(providers: readonly KeyView[], draft: CanvasGenerationDraft, seconds: number): number | undefined {
  const key = providerForAlias(providers, draft.alias);
  const model = key?.models.find(item => item.id === draft.model);
  if (!key || !model) return undefined;
  const channel = routeChannel(key, model);
  const durations = [...canvasVideoEditCaps(channel.model.id, channel.model.protocol, channel.model.declared).durations]
    .sort((a, b) => a - b);
  return durations.find(duration => duration >= seconds) ?? durations.at(-1);
}

function mediaNode(type: ShotGenerationKind, id: string, title: string, position: { x: number; y: number },
  draft: CanvasGenerationDraft): CanvasNode {
  return { id, type, title, position, z_index: 0, data: {
    current_version_id: null, active_run_id: null, generation_draft: draft, display: { fit: 'contain', free_resize: false },
  } } as CanvasNode;
}

export function planShotGeneration({ document, storyboardNodeId, shotIds, kind, count = 1, deps }: {
  document: CanvasDocument;
  storyboardNodeId: string;
  shotIds: readonly string[];
  kind: ShotGenerationKind;
  /** 每镜出几张图（1–4）；视频恒为 1。 */
  count?: number;
  deps: ShotGenerationDeps;
}): ShotGenerationPlan {
  const plan: ShotGenerationPlan = { storyboardNodeId, kind, items: [], skipped: [], models: [], totalCost: 0, unpricedCount: 0 };
  const storyboard = document.nodes.find(node => node.id === storyboardNodeId);
  if (!isStoryboardNode(storyboard)) return plan;
  const payload = storyboardPayloadOf(storyboard);
  const findNode = (id: string) => document.nodes.find(node => node.id === id);
  const placed = [...document.nodes];
  const perShot = kind === 'image' ? Math.max(1, Math.min(4, Math.round(count))) : 1;
  const size = { width: CELL_WIDTH, height: cellHeight(payload.ratio) };

  payload.shots.forEach((shot, index) => {
    if (!shotIds.includes(shot.id)) return;
    const label = storyboardShotLabel(index);
    const skip = (reason: string) => { plan.skipped.push({ shotId: shot.id, label, reason }); };
    const image = resolveStoryboardBinding(findNode, shot.image_node_id, 'image');
    const existing = kind === 'image' ? image : resolveStoryboardBinding(findNode, shot.video_node_id, 'video');
    if (kind === 'video' && !(image && canvasNodeHasCurrentContent(image, document.content_versions))) return skip(NO_IMAGE_FOR_VIDEO);
    if (existing) {
      if (existing.data.active_run_id) return skip('正在生成');
      if (!existing.data.generation_draft?.model) return skip('这个节点没有生成设置');
      const draft = kind === 'image'
        ? { ...existing.data.generation_draft, params: { ...existing.data.generation_draft.params, n: perShot } }
        : existing.data.generation_draft;
      plan.items.push({ shotId: shot.id, label, nodeId: existing.id, create: null, connections: [], draft, cost: costOf(deps.providers, draft, kind) });
      return;
    }
    const nodeId = deps.newId(kind);
    const position = placeCanvasNodeWithoutOverlap(shotCellPosition(storyboard, index, payload.ratio, kind), placed, size);
    if (kind === 'image') {
      const draft = createCanvasGenerationDraft(deps.providers, 'image', {
        preference: deps.preference, prompt: composeShotImagePrompt(payload, shot),
        paramOverrides: { size_mode: 'ratio', ratio: payload.ratio, n: perShot },
      });
      if (!draft.model) return skip('没有可用的图片模型');
      const node = mediaNode('image', nodeId, `${label} 图`, position, draft);
      const sources = [...new Set(shotEntities(payload, shot).flatMap(entity => {
        const reference = resolveStoryboardBinding(findNode, entity.reference_node_id, 'image');
        return reference && canvasNodeHasCurrentContent(reference, document.content_versions) ? [reference.id] : [];
      }))];
      placed.push({ ...node, size });
      plan.items.push({
        shotId: shot.id, label, nodeId, create: node, draft, cost: costOf(deps.providers, draft, kind),
        connections: sources.map(source => ({ id: deps.newId('connection'), role: 'input', source_node_id: source, target_node_id: nodeId })),
      });
      return;
    }
    // 界面与草稿用 firstlast 表示「首尾帧槽位模式」；只连首帧槽时服务端按首帧提交。
    const overrides = { frame_mode: 'firstlast' as const, ratio: payload.ratio };
    const probe = createCanvasGenerationDraft(deps.providers, 'video', { preference: deps.preference, paramOverrides: overrides });
    if (!probe.model) return skip('没有可用的视频模型');
    const duration = videoDuration(deps.providers, probe, shot.duration_s);
    const draft = createCanvasGenerationDraft(deps.providers, 'video', {
      preference: deps.preference, prompt: shot.video_prompt.trim() || shot.visual.trim(),
      paramOverrides: duration === undefined ? overrides : { ...overrides, duration },
    });
    if (draft.params.frame_mode !== 'firstlast') return skip('当前视频模型不支持首帧');
    const node = mediaNode('video', nodeId, `${label} 视频`, position, draft);
    placed.push({ ...node, size });
    plan.items.push({
      shotId: shot.id, label, nodeId, create: node, draft, cost: costOf(deps.providers, draft, kind),
      connections: [{ id: deps.newId('connection'), role: 'input', slot: 'first_frame', source_node_id: image!.id, target_node_id: nodeId }],
    });
  });

  // 弹窗里显示模型名称；查不到名称时退回 id。
  plan.models = [...new Set(plan.items.map(item => (
    providerForAlias(deps.providers, item.draft.alias)?.models.find(model => model.id === item.draft.model)?.name || item.draft.model
  )))];
  plan.unpricedCount = plan.items.filter(item => item.cost === null).length;
  plan.totalCost = plan.unpricedCount > 0 ? null : plan.items.reduce((sum, item) => sum + (item.cost ?? 0), 0);
  return plan;
}

/**
 * 把确认过的计划应用到当前文档：建节点、连参考、把镜头绑到节点、写入冻结的草稿。
 * 只动计划里的镜头；确认之后被删掉的镜头跳过。返回新文档与要逐个提交的节点 id。
 */
export function applyShotGenerationPlan(document: CanvasDocument, plan: ShotGenerationPlan):
  { document: CanvasDocument; nodeIds: string[] } {
  const storyboard = document.nodes.find(node => node.id === plan.storyboardNodeId);
  if (!isStoryboardNode(storyboard)) return { document, nodeIds: [] };
  const payload = storyboardPayloadOf(storyboard);
  const liveShots = new Set(payload.shots.map(shot => shot.id));
  const existingIds = new Set(document.nodes.map(node => node.id));
  const items = plan.items.filter(item => liveShots.has(item.shotId)
    && (item.create ? !existingIds.has(item.nodeId) : existingIds.has(item.nodeId)));
  if (items.length === 0) return { document, nodeIds: [] };
  const byNode = new Map(items.map(item => [item.nodeId, item]));
  const created = new Map(items.flatMap(item => (item.create ? [[item.shotId, item.nodeId] as const] : [])));
  const field = plan.kind === 'image' ? 'image_node_id' : 'video_node_id';
  const nextPayload: StoryboardPayload = {
    ...payload, shots: payload.shots.map(shot => (created.has(shot.id) ? { ...shot, [field]: created.get(shot.id)! } : shot)),
  };
  const topZ = Math.max(0, ...document.nodes.map(node => node.z_index));
  const nodes = [
    ...document.nodes.map(node => {
      if (node.id === storyboard.id) return { ...storyboard, data: { ...storyboard.data, payload: nextPayload as unknown as JsonValue } };
      const item = byNode.get(node.id);
      // 已有节点：写入确认时冻结的草稿；这期间开始生成的节点不动。
      return item && (node.type === 'image' || node.type === 'video') && !node.data.active_run_id
        ? { ...node, data: { ...node.data, generation_draft: item.draft } } as CanvasNode : node;
    }),
    ...items.flatMap((item, index) => (item.create ? [{ ...item.create, z_index: topZ + index + 1 }] : [])),
  ];
  const connections = [
    ...document.connections,
    ...items.flatMap(item => (item.create ? item.connections.filter(edge => existingIds.has(edge.source_node_id)) : [])),
  ];
  return { document: { ...document, nodes, connections }, nodeIds: items.map(item => item.nodeId) };
}

/** 默认范围：没有勾选时，取全部还没出图（或已有图但还没出视频）的镜头。 */
export function defaultShotSelection(document: CanvasDocument, payload: StoryboardPayload, kind: ShotGenerationKind): string[] {
  const findNode = (id: string) => document.nodes.find(node => node.id === id);
  return payload.shots.filter(shot => {
    const image = resolveStoryboardBinding(findNode, shot.image_node_id, 'image');
    const hasImage = Boolean(image && canvasNodeHasCurrentContent(image, document.content_versions));
    if (kind === 'image') return !hasImage && !image?.data.active_run_id;
    const video = resolveStoryboardBinding(findNode, shot.video_node_id, 'video');
    const videoBusy = Boolean(video?.data.active_run_id);
    const hasVideo = Boolean(video && canvasNodeHasCurrentContent(video, document.content_versions));
    return hasImage && !hasVideo && !videoBusy;
  }).map(shot => shot.id);
}

/**
 * 在已有内容的节点上重新生成时，画布把结果放进一个新节点。这一镜改绑到新结果并沿用原标题；
 * 旧节点留在画布上，不再属于这一镜。镜头已被删掉时不动。
 */
export function rebindShotResult(document: CanvasDocument, plan: ShotGenerationPlan, shotId: string,
  resultNodeId: string, title: string): CanvasDocument {
  const storyboard = document.nodes.find(node => node.id === plan.storyboardNodeId);
  const result = document.nodes.find(node => node.id === resultNodeId);
  if (!isStoryboardNode(storyboard) || result?.type !== plan.kind) return document;
  const payload = storyboardPayloadOf(storyboard);
  if (!payload.shots.some(shot => shot.id === shotId)) return document;
  const field = plan.kind === 'image' ? 'image_node_id' : 'video_node_id';
  const nextPayload: StoryboardPayload = {
    ...payload, shots: payload.shots.map(shot => (shot.id === shotId ? { ...shot, [field]: resultNodeId } : shot)),
  };
  return {
    ...document,
    nodes: document.nodes.map(node => {
      if (node.id === storyboard.id) return { ...storyboard, data: { ...storyboard.data, payload: nextPayload as unknown as JsonValue } };
      return node.id === resultNodeId && title ? { ...node, title } : node;
    }),
  };
}
