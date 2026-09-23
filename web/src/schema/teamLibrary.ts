import type { CreationAsset } from '@/schema/creationAssets';

export type TeamAssetKind = 'generation' | 'media' | 'prompt' | 'raw';

export interface TeamLibraryView {
  library_id: string;
  project_id: string;
  name: string;
  mount_path: string;
  mounted_at: string;
  reachable: boolean;
  asset_count: number;
  scanned_at: string | null;
}

export interface TeamLibraryIndexEntry {
  id: string;
  kind: TeamAssetKind;
  title: string;
  author: string | null;
  tags: string[];
  mime_type: string | null;
  bytes: number;
  relative_path: string;
  sha256: string | null;
  updated_at: string;
  reproducible: boolean;
  status: 'ready' | 'incomplete';
  /** 仅生成资产有值。 */
  model: string | null;
  cost_cny: number | null;
}

/** 分享来源：Studio 某次出图的第 output_index 张（Job.output_paths 下标），或一条本机创作资产。 */
export type TeamShareSource =
  | { kind: 'job_output'; job_id: string; output_index: number }
  | { kind: 'creation_asset'; asset_id: string };

export interface TeamShareRequest {
  source: TeamShareSource;
  title: string;
  tags: string[];
  allow_large?: boolean;
}

export interface TeamRelatedEntry {
  library_id: string;
  library_name: string;
  entry: TeamLibraryIndexEntry;
}

export interface TeamLibraryAssetPage {
  entries: TeamLibraryIndexEntry[];
  next_cursor: string | null;
}

export interface UserProfile {
  display_name: string | null;
}

export interface TeamAssetAdoptResponse {
  asset: CreationAsset;
  created: boolean;
}

/** 团队资产拖放的 dataTransfer 类型；载荷是 `TeamAssetDragPayload` 的 JSON。 */
export const TEAM_ASSET_DRAG_TYPE = 'application/x-game-atelier-team-asset';

export interface TeamAssetDragPayload {
  library_id: string;
  entry_id: string;
}

export function readTeamAssetDrag(transfer: DataTransfer): TeamAssetDragPayload | null {
  const raw = transfer.getData(TEAM_ASSET_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TeamAssetDragPayload>;
    return parsed.library_id && parsed.entry_id
      ? { library_id: parsed.library_id, entry_id: parsed.entry_id }
      : null;
  } catch { return null; }
}
