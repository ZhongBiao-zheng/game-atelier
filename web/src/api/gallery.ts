export interface GalleryItem {
  character_id: string;
  asset_slot: 'portrait' | 'promo' | 'turnaround';
  filename: string;
  path: string;
  job_id: string | null;
  mtime: number;
}

export async function fetchGalleryRecent(limit = 24): Promise<GalleryItem[]> {
  const resp = await fetch(`/api/gallery/recent?limit=${limit}`);
  if (!resp.ok) throw new Error(`gallery fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { items: GalleryItem[] };
  return data.items;
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
