import { requestJson } from './http';
import type { AssetSlot, Project } from '@/schema/jobs';
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

export type ProjectGalleryCategory = 'all' | 'art' | 'ui' | 'video';

export type ProjectGalleryTarget =
  | { kind: 'art'; character_id: string; asset_slot: AssetSlot }
  | { kind: 'ui'; scheme_id: string; screen_id: string }
  | {
    kind: 'video';
    production_id: string;
    output_kind: 'version';
  };

export interface ProjectGalleryMedia {
  path: string;
  media_type: 'image' | 'video';
  produced_at: string;
  title: string;
  detail: string;
  job_id: string | null;
  target: ProjectGalleryTarget;
}

export interface ProjectGalleryPage {
  items: ProjectGalleryMedia[];
  next_cursor: string | null;
}

export async function fetchProjectGallery(
  projectId: string,
  category: ProjectGalleryCategory = 'all',
  cursor?: string | null,
  limit = 40,
): Promise<ProjectGalleryPage> {
  const query = new URLSearchParams({ category, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return requestJson<ProjectGalleryPage>(
    `/api/projects/${encodeURIComponent(projectId)}/gallery?${query}`,
    '读取项目画廊',
  );
}

export async function fetchProjectGalleryMedia(
  projectId: string,
  path: string,
): Promise<ProjectGalleryMedia> {
  return requestJson<ProjectGalleryMedia>(
    `/api/projects/${encodeURIComponent(projectId)}/gallery/media?path=${encodeURIComponent(path)}`,
    '读取项目作品',
  );
}

export interface ProjectIndexItem {
  project: Project;
  cover_paths: string[];
  activity_at: string;
}

export async function fetchProjectIndex(): Promise<ProjectIndexItem[]> {
  const data = await requestJson<{ items?: ProjectIndexItem[] }>(
    '/api/projects/index',
    '读取项目目录',
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 项目 UI 页面图：projects/<slug>/ui/<scheme-id>/screens/<screen-id>/ 下的版本图，最新在前。 */
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

export async function fetchGalleryScreens(
  projectId: string,
  schemeId: string,
): Promise<ProjectScreenItem[]> {
  const data = await requestJson<{ items?: ProjectScreenItem[] }>(
    `/api/gallery/screens?project=${encodeURIComponent(projectId)}&scheme=${encodeURIComponent(schemeId)}`,
    '读取项目页面图',
  );
  return Array.isArray(data.items) ? data.items : [];
}

/** 画廊类界面的隐藏清单（data_root 相对路径）；不删除资产文件或历史。 */
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
