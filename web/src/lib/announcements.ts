/** 新模型公告 —— 启动后弹一次的宣传弹窗。
 *
 * **数据不在这里**：公告存在 `src/character_workflow/data/announcements.json`（新的在前），本机服务
 * 打包一份兜底，启动后再从 main 分支拉最新的同一个文件（`announcement_feed.py`）。所以：
 * - 模型要改代码才能用（能力登记 imageSizeCatalog / imageControlCaps 等）→ 公告随那一版发，`version` 填那一版；
 * - 模型不用改代码 → 只改 JSON 推 main，不发版；`version` 填当时已发布的最新版本。
 * 服务端只返回 `version` 不高于本机版本的公告。`models[].ids` 写官方模型 ID 与常见别名，
 * 「快速添加」拿它去各供应商实际开通的模型列表里找同名 / 相似项。图片用 https 外链。
 */
import { useEffect, useState } from 'react';

import type { KeyModel, KeyView, RemoteModel } from '@/api/keys';
import { requestJson } from '@/api/http';

export interface AnnouncedModel {
  name: string;
  ids: string[];
}

export interface Announcement {
  /** 稳定标识，已读记录按它存；发出后不要改。 */
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** 能看到这条公告的最低版本：随版本发出的填那一版，只发公告填当时已发布的最新版本。 */
  version: string;
  title: string;
  summary: string;
  imageUrl: string;
  models: AnnouncedModel[];
}

let announcementsRequest: Promise<Announcement[]> | null = null;

/** 一个页面会话只拉一次；失败返回空列表（公告不该挡住任何功能），下次刷新页面再试。 */
export function loadAnnouncements(): Promise<Announcement[]> {
  announcementsRequest ??= requestJson<{ announcements: Announcement[] }>('/api/announcements', '读取模型公告')
    .then(body => (Array.isArray(body?.announcements) ? body.announcements : []))
    .catch(() => []);
  return announcementsRequest;
}

export function useAnnouncements(): Announcement[] {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  useEffect(() => {
    let alive = true;
    void loadAnnouncements().then(items => { if (alive) setAnnouncements(items); });
    return () => { alive = false; };
  }, []);
  return announcements;
}

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
export function markAnnouncementsSeen(announcements: readonly Announcement[]): void {
  try {
    const seen = new Set(loadSeenAnnouncements());
    for (const item of announcements) seen.add(item.id);
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // 存储不可用时最多下次再弹一次，不影响使用
  }
}

export function latestUnseenAnnouncement(
  announcements: readonly Announcement[],
  seen: readonly string[] = loadSeenAnnouncements(),
): Announcement | null {
  const latest = announcements[0];
  return latest && !seen.includes(latest.id) ? latest : null;
}

/** 与 `target` 同一批发出的公告（新的在前，含自身），公告弹窗在这组内翻页。
 *  同一批 = 同版本且同一天：只发公告时 `version` 填已发布的版本，按版本分组会把那一版早先的公告也翻进来。 */
export function announcementsInSameRelease(
  target: Announcement,
  announcements: readonly Announcement[],
): Announcement[] {
  return announcements.filter(item => item.version === target.version && item.date === target.date);
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

/** 同名：忽略大小写与符号，聚合商的 `厂商/模型` 前缀也算同名（`nano-banana-2-1` = `nano-banana-2.1`）。
 *  相似：远端 ID 包含公告 ID（多了日期后缀、-preview 之类）。反过来不算：远端更短往往是旧版本，
 *  `nano-banana-2` 是 `nano-banana-2.1` 的前缀，却是上一代模型。 */
export function matchModel(remoteId: string, announcedId: string): ModelMatchKind | null {
  const remote = compact(remoteId);
  const target = compact(announcedId);
  if (target.length < 4) return remote === target ? 'exact' : null;
  if (remote === target) return 'exact';
  return remote.includes(target) ? 'similar' : null;
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
