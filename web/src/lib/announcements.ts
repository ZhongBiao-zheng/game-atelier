/** 新模型公告 —— 启动后弹一次的宣传弹窗的数据源，随版本发布。
 *
 * **发公告时怎么加**：在数组**开头**插一条（新的在前）。`models[].ids` 写该模型的官方模型 ID
 * （可写多个别名），「快速添加」拿它去各供应商实际开通的模型列表里找同名 / 相似项。
 * 能被快速添加的模型，必须已在代码里登记过能力（imageSizeCatalog / imageControlCaps 等），
 * 公告和能力登记放在同一个版本里发。图片用外链（官方或自有 OSS）。
 */
import type { KeyModel, KeyView, RemoteModel } from '@/api/keys';

export interface AnnouncedModel {
  name: string;
  ids: string[];
}

export interface Announcement {
  /** 稳定标识，已读记录按它存；发出后不要改。 */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  title: string;
  summary: string;
  imageUrl: string;
  models: AnnouncedModel[];
}

export const ANNOUNCEMENTS: Announcement[] = [];

export const OPEN_ANNOUNCEMENT_EVENT = 'atelier:open-announcement';
export const KEYS_CHANGED_EVENT = 'atelier:keys-changed';

const SEEN_KEY = 'atelier:announcements-seen';

export function loadSeenAnnouncements(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/** 弹过一次就把当前所有公告记为已读：积了多条未读时只弹最新一条，旧的不再补弹。 */
export function markAnnouncementsSeen(announcements: readonly Announcement[] = ANNOUNCEMENTS): void {
  try {
    const seen = new Set(loadSeenAnnouncements());
    for (const item of announcements) seen.add(item.id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // 存储不可用时最多下次再弹一次，不影响使用
  }
}

export function latestUnseenAnnouncement(
  announcements: readonly Announcement[] = ANNOUNCEMENTS,
  seen: readonly string[] = loadSeenAnnouncements(),
): Announcement | null {
  const latest = announcements[0];
  return latest && !seen.includes(latest.id) ? latest : null;
}

export type ModelMatchKind = 'exact' | 'similar';

export interface ModelCandidate {
  model: RemoteModel;
  announced: AnnouncedModel;
  kind: ModelMatchKind;
  /** 该密钥的模型列表里已经有它。 */
  added: boolean;
}

function lastSegment(id: string) {
  return id.toLowerCase().split('/').pop() ?? '';
}

function compact(id: string) {
  return lastSegment(id).replace(/[^a-z0-9]/g, '');
}

/** 同名：忽略大小写，聚合商的 `厂商/模型` 前缀也算同名。
 *  相似：去掉符号后一方包含另一方（日期后缀、-preview 之类），较短一方至少 4 个字符。 */
export function matchModel(remoteId: string, announcedId: string): ModelMatchKind | null {
  const remote = remoteId.toLowerCase();
  const target = announcedId.toLowerCase();
  if (remote === target || lastSegment(remote) === lastSegment(target)) return 'exact';
  const a = compact(remote);
  const b = compact(target);
  if (Math.min(a.length, b.length) < 4) return null;
  return a.includes(b) || b.includes(a) ? 'similar' : null;
}

/** 在一个供应商实际开通的模型里找公告模型；同一个远端模型只归到匹配度最高的那条。 */
export function findCandidates(
  remote: readonly RemoteModel[],
  announced: readonly AnnouncedModel[],
  existing: readonly KeyModel[],
): ModelCandidate[] {
  const existingIds = new Set(existing.map(model => model.id));
  const candidates: ModelCandidate[] = [];
  for (const model of remote) {
    let best: { announced: AnnouncedModel; kind: ModelMatchKind } | null = null;
    for (const item of announced) {
      for (const id of item.ids) {
        const kind = matchModel(model.id, id);
        if (kind === 'exact') best = { announced: item, kind };
        else if (kind && !best) best = { announced: item, kind };
      }
      if (best?.kind === 'exact') break;
    }
    if (best) candidates.push({ model, ...best, added: existingIds.has(model.id) });
  }
  return candidates.sort((left, right) => Number(left.kind === 'similar') - Number(right.kind === 'similar'));
}

export function toKeyModel(model: RemoteModel): KeyModel {
  return {
    name: model.name,
    id: model.id,
    modality: model.modality,
    protocol: model.protocol,
    input_modalities: model.input_modalities,
  };
}

export function withAddedModels(key: KeyView, models: readonly RemoteModel[]): KeyModel[] {
  const existingIds = new Set(key.models.map(model => model.id));
  return [...key.models, ...models.filter(model => !existingIds.has(model.id)).map(toKeyModel)];
}
