export type CreationAssetKind = 'prompt' | 'image';

export type CreationPromptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; name: string; default_value: string };

export interface CreationPromptAssetVersion {
  kind: 'prompt';
  version_id: string;
  created_at: string;
  segments: CreationPromptSegment[];
}

export interface CreationImageAssetVersion {
  kind: 'image';
  version_id: string;
  created_at: string;
  path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  filename: string;
}

export type CreationAssetVersion = CreationPromptAssetVersion | CreationImageAssetVersion;

export interface CreationAsset {
  asset_id: string;
  kind: CreationAssetKind;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  archived_at: string | null;
  latest_version_id: string;
  versions: CreationAssetVersion[];
  project_ids: string[];
}

export interface CreationAssetList {
  revision: number;
  assets: CreationAsset[];
  recent_tags: string[];
}

export function latestCreationAssetVersion(asset: CreationAsset): CreationAssetVersion {
  const version = asset.versions.find(item => item.version_id === asset.latest_version_id);
  if (!version) throw new Error(`资产 ${asset.asset_id} 缺少最新版本`);
  return version;
}

export function renderCreationPrompt(
  segments: CreationPromptSegment[],
  values: Readonly<Record<string, string>> = {},
): string {
  return segments.map(segment => {
    if (segment.kind === 'text') return segment.text;
    const value = values[segment.name];
    return value?.trim() ? value : segment.default_value;
  }).join('');
}
