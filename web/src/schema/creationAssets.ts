export type CreationAssetKind = 'prompt' | 'media';

export type CreationPromptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; name: string; default_value: string };

export interface CreationPromptAssetContent {
  kind: 'prompt';
  segments: CreationPromptSegment[];
}

export interface CreationMediaAssetContent {
  kind: 'media';
  path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  filename: string;
}

export type CreationAssetContent = CreationPromptAssetContent | CreationMediaAssetContent;

/** 提示词资产可选的推荐出图配置；model 是模型 id，不是本机别名。 */
export interface CreationAssetRecommendation {
  mode: 'image' | 'video';
  model: string;
  params: Record<string, string | number | boolean>;
}

/** 采用团队库资产时留下的来源：库 + 对方资产 id + 采用当时的源更新时间。 */
export interface AdoptionOrigin {
  library_id: string;
  asset_id: string;
  source_updated_at: string;
  raw_path: string | null;
}

export interface CreationAsset {
  asset_id: string;
  kind: CreationAssetKind;
  title: string;
  tags: string[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
  content: CreationAssetContent;
  project_ids: string[];
  recommendation?: CreationAssetRecommendation | null;
  adopted_from?: AdoptionOrigin | null;
}

export interface CreationAssetList {
  revision: number;
  assets: CreationAsset[];
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
