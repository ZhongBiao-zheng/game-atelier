import { requestJson } from './http';
export interface GalleryItem {
  /** studio 来源的图无角色归属，两字段为 null。 */
  character_id: string | null;
  /** 角色所属游戏项目；Studio 或未分类角色为 null。 */
  project_id?: string | null;
  asset_slot: 'portrait' | 'promo' | 'turnaround' | null;
  source?: 'character' | 'studio';
  filename: string;
  path: string;
  job_id: string | null;
  mtime: number;
  rating?: number;
}

export async function fetchGalleryRecent(limit = 24): Promise<GalleryItem[]> {
  const data = await requestJson<{ items?: GalleryItem[] }>(
    `/api/gallery/recent?limit=${limit}`,
    '读取最近作品',
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 项目作品：该项目名下全部角色三槽的图（已隐藏的不出，最新在前）。 */
export interface ProjectGalleryItem {
  character_id: string;
  character_name: string;
  asset_slot: 'portrait' | 'promo' | 'turnaround';
  filename: string;
  path: string;
  job_id: string | null;
  mtime: number;
}

export async function fetchGalleryProject(projectId: string): Promise<ProjectGalleryItem[]> {
  const data = await requestJson<{ items?: ProjectGalleryItem[] }>(
    `/api/gallery/project?project=${encodeURIComponent(projectId)}`,
    '读取项目作品',
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 项目 UI 页面图（B2）：projects/<slug>/screens/<screen-id>/ 下的版本图，最新在前。 */
export interface ProjectScreenItem {
  screen_id: string;
  filename: string;
  path: string;
  job_id: string | null;
  /** B3 风格候选来源关系（无标签的普通版本为 null）。 */
  style_variant: string | null;
  base_version: string | null;
  model: string | null;
  provider: string | null;
  prompt: string | null;
  mtime: number;
}

export async function fetchGalleryScreens(projectId: string): Promise<ProjectScreenItem[]> {
  const data = await requestJson<{ items?: ProjectScreenItem[] }>(
    `/api/gallery/screens?project=${encodeURIComponent(projectId)}`,
    '读取项目页面图',
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 首页作品展示的隐藏清单（data_root 相对路径）。工坊里仍正常可见。 */
export async function fetchGalleryHidden(): Promise<string[]> {
  const data = await requestJson<{ paths?: unknown }>('/api/gallery/hidden', '读取隐藏清单');
  return Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
}

export async function setGalleryHidden(path: string, hidden: boolean): Promise<string[]> {
  const data = await requestJson<{ paths: string[] }>(
    '/api/gallery/hidden',
    hidden ? '隐藏这张图' : '取消隐藏',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, hidden }),
    },
  );
  return data.paths;
}

/** sidecar 存相对路径、job.output_paths 是绝对路径——后缀比对两态通吃。 */
export function isGalleryHidden(path: string, hiddenPaths: string[]): boolean {
  return hiddenPaths.some((h) => path === h || path.endsWith(`/${h}`));
}

/** 收藏清单（data_root 相对路径）。仅作标记 + 筛选，不影响首页作品展示。 */
export async function fetchGalleryFavorites(): Promise<string[]> {
  const data = await requestJson<{ paths?: unknown }>('/api/gallery/favorites', '读取收藏清单');
  return Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
}

export async function setGalleryFavorite(path: string, favorite: boolean): Promise<string[]> {
  const data = await requestJson<{ paths: string[] }>(
    '/api/gallery/favorites',
    favorite ? '收藏这张图' : '取消收藏',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, favorite }),
    },
  );
  return data.paths;
}

/** sidecar 存相对路径、job.output_paths 是绝对路径——后缀比对两态通吃（同 isGalleryHidden）。 */
export function isGalleryFavorited(path: string, favoritePaths: string[]): boolean {
  return favoritePaths.some((f) => path === f || path.endsWith(`/${f}`));
}

/** 评分清单（data_root 相对路径 → 0.5~5.0）。驱动首页高分优先排序 + 详情页展示。 */
export async function fetchGalleryRatings(): Promise<Record<string, number>> {
  const data = await requestJson<{ ratings?: unknown }>('/api/gallery/ratings', '读取评分');
  return isRatingMap(data.ratings) ? data.ratings : {};
}

export async function setGalleryRating(path: string, rating: number): Promise<Record<string, number>> {
  const data = await requestJson<{ ratings: Record<string, number> }>(
    '/api/gallery/ratings',
    '保存评分',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, rating }),
    },
  );
  return data.ratings;
}

/** sidecar 存相对路径、job.output_paths 是绝对路径——后缀比对两态通吃（同 isGalleryFavorited）。 */
export function getGalleryRating(path: string, ratings: Record<string, number>): number {
  for (const [k, v] of Object.entries(ratings)) {
    if (path === k || path.endsWith(`/${k}`)) return v;
  }
  return 0;
}

function isRatingMap(x: unknown): x is Record<string, number> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
    && Object.values(x).every((v) => typeof v === 'number');
}
