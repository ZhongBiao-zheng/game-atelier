/** 分镜节点（ADR-0038）：存成插件节点外壳，`plugin_id` 是宿主保留的 `atelier.storyboard`，镜头数据在 payload。
 *
 *  payload 可能来自项目包、局域网分享或粘贴，一律当不可信数据：读取只走 normalizeStoryboardPayload
 *  （缺字段补默认、类型不对取默认、超长截断、多余字段丢弃），里面的节点 id 只在当前文档内解析。
 *  规则与后端 `canvas_storyboard.normalize_payload` 相同，共用夹具 `tests/fixtures/storyboard_payload_cases.json`。 */
import type { CanvasNode, CanvasPluginNode, CanvasPoint, JsonValue } from '@/schema/canvas';

export const STORYBOARD_PLUGIN_ID = 'atelier.storyboard';
export const STORYBOARD_NODE_TYPE = 'board';
export const STORYBOARD_DEFAULT_SIZE = { width: 420, height: 480 };
export const STORYBOARD_MAX_SHOTS = 120;
export const STORYBOARD_MAX_ENTITIES = 60;
export const STORYBOARD_MAX_SHOT_ENTITIES = 20;
export const STORYBOARD_MAX_SCRIPT_NODES = 8;
/** 插件节点载荷上限是 256 KiB（读盘模型里的约束）；留一点余量给两端序列化的差异。 */
export const STORYBOARD_PAYLOAD_MAX_BYTES = 250 * 1024;
export const STORYBOARD_TOO_LARGE = '镜头太多，请拆成两个分镜节点';
export const STORYBOARD_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;
export const STORYBOARD_SHOT_SIZES = ['远景', '全景', '中景', '近景', '特写'] as const;
export const STORYBOARD_CAMERA_MOVES = ['固定', '推', '拉', '摇', '移', '跟', '升降', '手持'] as const;
export const STORYBOARD_ENTITY_KINDS = ['character', 'scene', 'prop'] as const;
export const STORYBOARD_ENTITY_KIND_LABELS: Record<StoryboardEntityKind, string> = {
  character: '角色', scene: '场景', prop: '道具',
};
export const STORYBOARD_TEXT_LIMITS = {
  style_prefix: 2000, entity_name: 40, entity_description: 1000,
  scene: 60, shot_size: 20, camera: 40, visual: 2000, dialogue: 1000, image_prompt: 4000, video_prompt: 4000,
} as const;
export const STORYBOARD_MIN_DURATION_S = 1;
export const STORYBOARD_MAX_DURATION_S = 60;

const DEFAULT_RATIO = '16:9';
const DEFAULT_DURATION_S = 5;
const MAX_NODE_ID = 120;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const RATIO = /^[1-9]\d?:[1-9]\d?$/;
const SHOT_TEXT_FIELDS = ['scene', 'shot_size', 'camera', 'visual', 'dialogue', 'image_prompt', 'video_prompt'] as const;

export type StoryboardEntityKind = typeof STORYBOARD_ENTITY_KINDS[number];

export interface StoryboardEntity {
  id: string;
  kind: StoryboardEntityKind;
  name: string;
  /** 固定描述：逐字带入用到它的镜头。 */
  description: string;
  reference_node_id: string | null;
}

export interface StoryboardShot {
  id: string;
  scene: string;
  shot_size: string;
  camera: string;
  duration_s: number;
  visual: string;
  dialogue: string;
  entity_ids: string[];
  image_prompt: string;
  video_prompt: string;
  image_node_id: string | null;
  video_node_id: string | null;
}

export interface StoryboardPayload {
  ratio: string;
  style_prefix: string;
  entities: StoryboardEntity[];
  shots: StoryboardShot[];
  /** 剧本来源的文本节点。旧版本不接受连到插件节点的连线，所以不画线。 */
  script_node_ids: string[];
}

export type StoryboardNode = CanvasPluginNode & { data: { plugin_id: typeof STORYBOARD_PLUGIN_ID } };

export function isStoryboardNode(node: CanvasNode | null | undefined): node is StoryboardNode {
  return node?.type === 'plugin' && node.data.plugin_id === STORYBOARD_PLUGIN_ID
    && node.data.node_type === STORYBOARD_NODE_TYPE;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  return value.length > limit ? Array.from(value).slice(0, limit).join('') : value;
}

function nodeId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NODE_ID ? value : null;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DURATION_S;
  return Math.min(STORYBOARD_MAX_DURATION_S, Math.max(STORYBOARD_MIN_DURATION_S, value));
}

function uniqueIds(values: unknown, allowed: ReadonlySet<string> | null, limit: number): string[] {
  const result: string[] = [];
  for (const value of items(values)) {
    const id = nodeId(value);
    if (id === null || result.includes(id) || (allowed && !allowed.has(id))) continue;
    result.push(id);
    if (result.length === limit) break;
  }
  return result;
}

function validItem(value: unknown, seen: ReadonlySet<string>): (Record<string, unknown> & { id: string }) | null {
  const item = record(value);
  return item && typeof item.id === 'string' && ID.test(item.id) && !seen.has(item.id)
    ? item as Record<string, unknown> & { id: string } : null;
}

export function normalizeStoryboardPayload(raw: unknown): StoryboardPayload {
  const source = record(raw) ?? {};
  const entities: StoryboardEntity[] = [];
  const entityIds = new Set<string>();
  for (const value of items(source.entities)) {
    if (entities.length === STORYBOARD_MAX_ENTITIES) break;
    const item = validItem(value, entityIds);
    if (!item) continue;
    entityIds.add(item.id);
    entities.push({
      id: item.id,
      kind: STORYBOARD_ENTITY_KINDS.includes(item.kind as StoryboardEntityKind)
        ? item.kind as StoryboardEntityKind : 'character',
      name: text(item.name, STORYBOARD_TEXT_LIMITS.entity_name),
      description: text(item.description, STORYBOARD_TEXT_LIMITS.entity_description),
      reference_node_id: nodeId(item.reference_node_id),
    });
  }
  const shots: StoryboardShot[] = [];
  const shotIds = new Set<string>();
  for (const value of items(source.shots)) {
    if (shots.length === STORYBOARD_MAX_SHOTS) break;
    const item = validItem(value, shotIds);
    if (!item) continue;
    shotIds.add(item.id);
    const texts = Object.fromEntries(SHOT_TEXT_FIELDS.map(field => [field, text(item[field], STORYBOARD_TEXT_LIMITS[field])])) as
      Pick<StoryboardShot, typeof SHOT_TEXT_FIELDS[number]>;
    shots.push({
      id: item.id,
      ...texts,
      duration_s: duration(item.duration_s),
      entity_ids: uniqueIds(item.entity_ids, entityIds, STORYBOARD_MAX_SHOT_ENTITIES),
      image_node_id: nodeId(item.image_node_id),
      video_node_id: nodeId(item.video_node_id),
    });
  }
  return {
    ratio: typeof source.ratio === 'string' && RATIO.test(source.ratio) ? source.ratio : DEFAULT_RATIO,
    style_prefix: text(source.style_prefix, STORYBOARD_TEXT_LIMITS.style_prefix),
    entities,
    shots,
    script_node_ids: uniqueIds(source.script_node_ids, null, STORYBOARD_MAX_SCRIPT_NODES),
  };
}

export function storyboardPayloadOf(node: StoryboardNode): StoryboardPayload {
  return normalizeStoryboardPayload(node.data.payload);
}

export function storyboardPayloadBytes(payload: StoryboardPayload): number {
  return new TextEncoder().encode(JSON.stringify(payload)).length;
}

/** 写回节点。超过载荷上限时不写，返回一句提示。 */
export function withStoryboardPayload(node: StoryboardNode, payload: StoryboardPayload):
  { ok: true; node: StoryboardNode } | { ok: false; message: string } {
  const normalized = normalizeStoryboardPayload(payload);
  if (storyboardPayloadBytes(normalized) > STORYBOARD_PAYLOAD_MAX_BYTES) return { ok: false, message: STORYBOARD_TOO_LARGE };
  return { ok: true, node: { ...node, data: { ...node.data, payload: normalized as unknown as JsonValue } } };
}

export function createStoryboardNode(id: string, position: CanvasPoint, scriptNodeIds: readonly string[] = []): StoryboardNode {
  return {
    id, type: 'plugin', title: '分镜', position, size: STORYBOARD_DEFAULT_SIZE, z_index: 0,
    data: {
      plugin_id: STORYBOARD_PLUGIN_ID, node_type: STORYBOARD_NODE_TYPE, plugin_version: '1', data_schema_version: 1,
      payload: normalizeStoryboardPayload({ script_node_ids: [...scriptNodeIds] }) as unknown as JsonValue,
      generation_draft: null,
    },
  };
}

export function emptyStoryboardShot(id: string): StoryboardShot {
  return { id, scene: '', shot_size: '', camera: '', duration_s: DEFAULT_DURATION_S, visual: '', dialogue: '',
    entity_ids: [], image_prompt: '', video_prompt: '', image_node_id: null, video_node_id: null };
}

export function emptyStoryboardEntity(id: string, kind: StoryboardEntityKind = 'character'): StoryboardEntity {
  return { id, kind, name: '', description: '', reference_node_id: null };
}

export function storyboardShotLabel(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function storyboardTotalDuration(payload: StoryboardPayload): number {
  return payload.shots.reduce((sum, shot) => sum + shot.duration_s, 0);
}

/** 时长显示：不足一分钟写秒，否则「分:秒」。 */
export function formatStoryboardDuration(seconds: number): string {
  const rounded = Math.round(seconds);
  if (rounded < 60) return `${Number(seconds.toFixed(1))} 秒`;
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}

/** 在 afterId 之后插入；afterId 为空时加到末尾。到上限时原样返回。 */
export function addStoryboardShot(payload: StoryboardPayload, shot: StoryboardShot, afterId: string | null = null): StoryboardPayload {
  if (payload.shots.length >= STORYBOARD_MAX_SHOTS || payload.shots.some(item => item.id === shot.id)) return payload;
  const index = afterId === null ? -1 : payload.shots.findIndex(item => item.id === afterId);
  const at = index < 0 ? payload.shots.length : index + 1;
  return { ...payload, shots: [...payload.shots.slice(0, at), shot, ...payload.shots.slice(at)] };
}

/** 复制出的镜头不带图片与视频绑定：那两个节点仍属于原镜头。 */
export function duplicateStoryboardShot(payload: StoryboardPayload, shotId: string, newId: string): StoryboardPayload {
  const source = payload.shots.find(shot => shot.id === shotId);
  if (!source) return payload;
  return addStoryboardShot(payload, { ...source, id: newId, entity_ids: [...source.entity_ids],
    image_node_id: null, video_node_id: null }, shotId);
}

/** 只移出镜头表；它的图片与视频节点留在画布上。 */
export function removeStoryboardShot(payload: StoryboardPayload, shotId: string): StoryboardPayload {
  return { ...payload, shots: payload.shots.filter(shot => shot.id !== shotId) };
}

export function moveStoryboardShot(payload: StoryboardPayload, shotId: string, toIndex: number): StoryboardPayload {
  const from = payload.shots.findIndex(shot => shot.id === shotId);
  const to = Math.min(payload.shots.length - 1, Math.max(0, toIndex));
  if (from < 0 || from === to) return payload;
  const shots = payload.shots.filter(shot => shot.id !== shotId);
  shots.splice(to, 0, payload.shots[from]);
  return { ...payload, shots };
}

export function updateStoryboardShot(payload: StoryboardPayload, shotId: string, patch: Partial<Omit<StoryboardShot, 'id'>>): StoryboardPayload {
  return { ...payload, shots: payload.shots.map(shot => shot.id === shotId ? { ...shot, ...patch } : shot) };
}

export function addStoryboardEntity(payload: StoryboardPayload, entity: StoryboardEntity): StoryboardPayload {
  if (payload.entities.length >= STORYBOARD_MAX_ENTITIES || payload.entities.some(item => item.id === entity.id)) return payload;
  return { ...payload, entities: [...payload.entities, entity] };
}

export function updateStoryboardEntity(payload: StoryboardPayload, entityId: string, patch: Partial<Omit<StoryboardEntity, 'id'>>): StoryboardPayload {
  return { ...payload, entities: payload.entities.map(entity => entity.id === entityId ? { ...entity, ...patch } : entity) };
}

export function removeStoryboardEntity(payload: StoryboardPayload, entityId: string): StoryboardPayload {
  return {
    ...payload,
    entities: payload.entities.filter(entity => entity.id !== entityId),
    shots: payload.shots.map(shot => shot.entity_ids.includes(entityId)
      ? { ...shot, entity_ids: shot.entity_ids.filter(id => id !== entityId) } : shot),
  };
}

/** payload 里的节点 id 只在当前文档内解析：不存在或类型不符一律当作没有绑定。 */
export function resolveStoryboardBinding<T extends CanvasNode['type']>(
  findNode: (id: string) => CanvasNode | undefined, id: string | null, type: T,
): Extract<CanvasNode, { type: T }> | null {
  if (id === null) return null;
  const node = findNode(id);
  return node && node.type === type ? node as Extract<CanvasNode, { type: T }> : null;
}

/** 复制粘贴：绑定的节点一同被复制则改指新节点，否则清空（原节点仍归原分镜）。 */
export function remapStoryboardPayload(raw: unknown, idMap: ReadonlyMap<string, string>): JsonValue {
  const payload = normalizeStoryboardPayload(raw);
  const mapped = (id: string | null) => (id === null ? null : idMap.get(id) ?? null);
  return {
    ...payload,
    entities: payload.entities.map(entity => ({ ...entity, reference_node_id: mapped(entity.reference_node_id) })),
    shots: payload.shots.map(shot => ({
      ...shot, image_node_id: mapped(shot.image_node_id), video_node_id: mapped(shot.video_node_id),
    })),
    script_node_ids: payload.script_node_ids.flatMap(id => idMap.get(id) ?? []),
  } as unknown as JsonValue;
}
