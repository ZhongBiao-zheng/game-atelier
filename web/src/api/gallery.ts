export interface GalleryItem {
  /** studio 来源的图无角色归属，两字段为 null。 */
  character_id: string | null;
  asset_slot: 'portrait' | 'promo' | 'turnaround' | null;
  source?: 'character' | 'studio';
  filename: string;
  path: string;
  job_id: string | null;
  mtime: number;
  rating?: number;
}

export async function fetchGalleryRecent(limit = 24): Promise<GalleryItem[]> {
  const resp = await fetch(`/api/gallery/recent?limit=${limit}`);
  if (!resp.ok) throw new Error(`gallery fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { items?: GalleryItem[] };
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
  const resp = await fetch(`/api/gallery/project?project=${encodeURIComponent(projectId)}`);
  if (!resp.ok) throw new Error(`project gallery fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { items?: ProjectGalleryItem[] };
  return Array.isArray(data.items) ? data.items : [];
}

/** 首页作品展示的隐藏清单（data_root 相对路径）。工坊里仍正常可见。 */
export async function fetchGalleryHidden(): Promise<string[]> {
  const resp = await fetch('/api/gallery/hidden');
  if (!resp.ok) throw new Error(`gallery hidden fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { paths?: unknown };
  return Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
}

export async function setGalleryHidden(path: string, hidden: boolean): Promise<string[]> {
  const resp = await fetch('/api/gallery/hidden', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, hidden }),
  });
  if (!resp.ok) throw new Error(`gallery hidden update failed: ${resp.status}`);
  const data = (await resp.json()) as { paths: string[] };
  return data.paths;
}

/** sidecar 存相对路径、job.output_paths 是绝对路径——后缀比对两态通吃。 */
export function isGalleryHidden(path: string, hiddenPaths: string[]): boolean {
  return hiddenPaths.some((h) => path === h || path.endsWith(`/${h}`));
}

/** 收藏清单（data_root 相对路径）。仅作标记 + 筛选，不影响首页作品展示。 */
export async function fetchGalleryFavorites(): Promise<string[]> {
  const resp = await fetch('/api/gallery/favorites');
  if (!resp.ok) throw new Error(`gallery favorites fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { paths?: unknown };
  return Array.isArray(data.paths) ? data.paths.filter((p): p is string => typeof p === 'string') : [];
}

export async function setGalleryFavorite(path: string, favorite: boolean): Promise<string[]> {
  const resp = await fetch('/api/gallery/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, favorite }),
  });
  if (!resp.ok) throw new Error(`gallery favorite update failed: ${resp.status}`);
  const data = (await resp.json()) as { paths: string[] };
  return data.paths;
}

/** sidecar 存相对路径、job.output_paths 是绝对路径——后缀比对两态通吃（同 isGalleryHidden）。 */
export function isGalleryFavorited(path: string, favoritePaths: string[]): boolean {
  return favoritePaths.some((f) => path === f || path.endsWith(`/${f}`));
}

/** 评分清单（data_root 相对路径 → 0.5~5.0）。驱动首页高分优先排序 + 详情页展示。 */
export async function fetchGalleryRatings(): Promise<Record<string, number>> {
  const resp = await fetch('/api/gallery/ratings');
  if (!resp.ok) throw new Error(`gallery ratings fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { ratings?: unknown };
  return isRatingMap(data.ratings) ? data.ratings : {};
}

export async function setGalleryRating(path: string, rating: number): Promise<Record<string, number>> {
  const resp = await fetch('/api/gallery/ratings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, rating }),
  });
  if (!resp.ok) throw new Error(`gallery rating update failed: ${resp.status}`);
  const data = (await resp.json()) as { ratings: Record<string, number> };
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
