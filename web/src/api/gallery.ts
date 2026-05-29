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
