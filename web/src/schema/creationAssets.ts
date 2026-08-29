export type CreationAssetKind = 'prompt' | 'image';

export type CreationPromptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; name: string; default_value: string };

export interface CreationPromptAssetContent {
  kind: 'prompt';
  segments: CreationPromptSegment[];
}

export interface CreationImageAssetContent {
  kind: 'image';
  path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  filename: string;
}

export type CreationAssetContent = CreationPromptAssetContent | CreationImageAssetContent;

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
}

export interface CreationAssetList {
  revision: number;
  assets: CreationAsset[];
  recent_tags: string[];
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
