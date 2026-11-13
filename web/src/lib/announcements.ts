/** 新模型公告 —— 启动后弹一次的宣传弹窗的数据源，随版本发布。
 *
 * **发公告时怎么加**：在数组**开头**插一条（新的在前）。`models[].ids` 写该模型的官方模型 ID
 * （可写多个别名），「快速添加」拿它去各供应商实际开通的模型列表里找同名 / 相似项。
 * 能被快速添加的模型，必须已在代码里登记过能力（imageSizeCatalog / imageControlCaps 等），
 * 公告和能力登记放在同一个版本里发。图片用外链（官方或自有 OSS）。
 * `version` 写随哪一版发出（与 changelog.ts 的条目一致，有测试校验）；同一版的多条公告在弹窗里可翻页。
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
  /** 随哪一版发出。同一天可能连发两版，只按日期分不清，所以显式写版本号。 */
  version: string;
  title: string;
  summary: string;
  imageUrl: string;
  models: AnnouncedModel[];
}

export const ANNOUNCEMENTS: Announcement[] = [
  {
    id: '2026-11-seedream-5-5',
    date: '2026-11-13',
    version: '5.136.0',
    title: 'Seedream 5.5 上线',
    summary: '字节 11 月 9 日发布：多轮修改时没动的地方保持不变，光影、皮肤和小字更真实。提示词里写「透明背景」就直接出透明 PNG，做图标、贴纸、道具不用再抠图。火山方舟与 TokenDance 0.13–0.23 元 / 张，不到 5.0 Pro 一半；Tuzi、OpenRouter 也已上线。',
    // 火山方舟「Doubao Seedream 5.5 教程」的透明贴纸示例输出（官方页没有 og:image）。
    imageUrl: 'https://arkdocs.tos-cn-beijing.volces.com/images/image-generation/seedream-5-5-transparent-stickers-output-20261103.png',
    models: [{
      name: 'Seedream 5.5',
      ids: ['doubao-seedream-5-5-261028', 'seedream-5.5', 'bytedance-seed/seedream-5-5', 'doubao-seedream-5.5'],
    }],
  },
  {
    id: '2026-11-kling-4-0',
    date: '2026-11-10',
    version: '5.135.0',
    title: '可灵 4.0 上线',
    summary: '可灵 4.0 单次最长 30 秒，音画同出，可用最多 10 张参考图和参考视频驱动；4.0 Flash 更快更便宜，720p、最长 20 秒。TokenDance 与 EvoLink 已上线，TokenDance 720p 价格 4.0 每秒 1 元、Flash 每秒 0.6 元。同版补齐可灵 3.0 / 3.0 Turbo / 3.0 Omni。',
    // klingai.com 首页 Kling 4.0 主视觉（发布页 og:image 只是 logo）。
    imageUrl: 'https://p1-kling.klingai.com/kcdn/cdn-kcdn112452/kling-homepage-aio/assets/images/hero-v4-ocean-pianist-BJN4qEvR.jpg',
    models: [
      { name: 'Kling 4.0', ids: ['kling-4.0', 'kling-v4-text-to-video'] },
      { name: 'Kling 4.0 Flash', ids: ['kling-4.0-flash', 'kling-v4-flash-text-to-video'] },
    ],
  },
  {
    id: '2026-11-gpt-image-2-6',
    date: '2026-11-05',
    version: '5.134.0',
    title: 'GPT Image 2.6 上线',
    summary: 'OpenAI 11 月 4 日发布：Flare 主打速度（低档约 6 秒出图），Sunburst 主打细节与多轮编辑一致性。新增「规划」强度与 GIF 动图输出（文生图，2–64 帧）。API 价格与 2.5 相同；OpenRouter 已上线，OpenAI-HK / Tuzi 待配价。',
    // openai.com/index/introducing-images-2-6 的 og:image。
    imageUrl: 'https://images.ctfassets.net/kftzwdyauwt9/6EYvL2y5CLXFr8E1pqoVUK/064e0d73b10087e20967b69ef0a06678/images-2-6-social.png?w=1600&h=900&fit=fill',
    models: [
      { name: 'GPT Image 2.6 Sunburst', ids: ['gpt-image-2.6-sunburst', 'openai/gpt-image-2.6-sunburst'] },
      { name: 'GPT Image 2.6 Flare', ids: ['gpt-image-2.6-flare', 'openai/gpt-image-2.6-flare'] },
    ],
  },
  {
    id: '2026-10-flux-3-image',
    date: '2026-10-12',
    version: '5.128.0',
    title: 'FLUX 3 Image 上线',
    summary: 'Black Forest Labs 新一代图像生成与编辑模型：多轮编辑时不改动没提到的部分，复杂提示词和多语言文字渲染更准，官方支持最多 10 张参考图和原生 4K。Tuzi default 分组已上线，0.15¥ / 次。',
    // BFL 官方模型页（bfl.ai/models/flux-3-image）的 og:image。
    imageUrl: 'https://cdn.sanity.io/images/2gpum2i6/production/486fe8dbe090c31226c868dac01a1f5d918eb756-1200x630.jpg',
    models: [{ name: 'FLUX 3 Image', ids: ['flux-3-image'] }],
  },
  {
    id: '2026-10-nano-banana-2-1',
    date: '2026-10-08',
    version: '5.128.0',
    title: 'Nano Banana 2.1 上线',
    summary: 'Google 最新的 Flash 档图像模型：画面质量、文字排版和多轮编辑的一致性全面提升，最多 14 张参考图，支持 1K / 2K / 4K，官方 API 单价约为 Nano Banana 2 的一半。',
    // Google 未为 2.1 单独出宣传图，用 DeepMind Gemini Image 官方页主图。
    imageUrl: 'https://lh3.googleusercontent.com/IQrKmeotvku7oU92ImkQ4h74TbS7A695HU4Zq633YsuNW0hvjZlndcmzyhh5-CqxFntzW6K9J1pgaTUayRTYgK93laVGdPBp2uDAdJASSm4CZprKE3Q=w1440-h810-n-nu',
    models: [{ name: 'Nano Banana 2.1', ids: ['gemini-nano-banana-2.1', 'nano-banana-2.1'] }],
  },
];

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

/** 与 `target` 随同一个版本发布的公告（新的在前，含自身），公告弹窗在这组内翻页。 */
export function announcementsInSameRelease(
  target: Announcement,
  announcements: readonly Announcement[] = ANNOUNCEMENTS,
): Announcement[] {
  return announcements.filter(item => item.version === target.version);
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
