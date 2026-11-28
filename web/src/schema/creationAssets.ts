export type CreationAssetKind = 'prompt' | 'media' | 'generation';

export type CreationPromptSegment =
  | { kind: 'text'; text: string }
  | { kind: 'variable'; name: string; default_value: string };

export interface PromptPreviewImage {
  file: string;
  mime_type: string;
  width: number;
  height: number;
  source_job_id: string | null;
  source_model: string | null;
  added_at: string;
}

export interface CreationPromptAssetContent {
  kind: 'prompt';
  segments: CreationPromptSegment[];
  preview_images?: PromptPreviewImage[];
}

export interface CreationMediaAssetContent {
  kind: 'media';
  path: string;
  mime_type: string;
  bytes: number;
  sha256: string;
  filename: string;
  width?: number | null;
  height?: number | null;
}

export type RecipeInputRole = 'reference' | 'mask' | 'markup' | 'mj_sref' | 'mj_cref' | 'mj_oref';

/** 冻结快照里的一份参考内容；order 是提交时的序号（0..n-1），本体按 sha256 存在 blobs。 */
export interface RecipeInput {
  order: number;
  role: RecipeInputRole;
  kind: 'image' | 'video' | 'audio';
  sha256: string;
  mime_type: string;
}

/** 生成资产的冻结配方：模型用模型 id，alias 只是出图那台机器的 key 名。 */
export interface GenerationRecipe {
  mode: 'image' | 'video';
  model: string;
  provider: string | null;
  alias: string | null;
  final_prompt: string;
  draft_prompt: string | null;
  params: Record<string, unknown>;
  inputs: RecipeInput[];
  cost_cny: number | null;
  cost_basis: 'actual' | 'estimated' | null;
  submitted_at: string;
}

export interface CreationGenerationAssetContent {
  kind: 'generation';
  media: CreationMediaAssetContent;
  snapshot: GenerationRecipe;
}

export type CreationAssetContent =
  | CreationPromptAssetContent
  | CreationMediaAssetContent
  | CreationGenerationAssetContent;

/** 采用团队库资产时留下的来源：库 + 对方资产 id + 采用当时的源更新时间。 */
export interface AdoptionOrigin {
  library_id: string;
  asset_id: string;
  source_updated_at: string;
  source_preview_fingerprint?: string | null;
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
  use_count?: number;
  content: CreationAssetContent;
  project_ids: string[];
  category: string | null;
  adopted_from?: AdoptionOrigin | null;
}

export type CreationAssetStaleness = 'fresh' | 'stale' | 'withdrawn' | 'unknown';

export interface CreationAssetList {
  revision: number;
  assets: CreationAsset[];
}

/** 个人资产与参考库卡片拖进画布的 dataTransfer 类型；载荷是 `{asset_id}` 的 JSON。
 *  落点与「使用」一致：画布在落点插入这项资产（画布侧由 CanvasEditor 的 drop 处理接）。 */
export const CREATION_ASSET_DRAG_TYPE = 'application/x-game-atelier-creation-asset';

export function readCreationAssetDrag(transfer: DataTransfer): { asset_id: string } | null {
  const raw = transfer.getData(CREATION_ASSET_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { asset_id?: unknown };
    return typeof parsed.asset_id === 'string' && parsed.asset_id ? { asset_id: parsed.asset_id } : null;
  } catch { return null; }
}

/** 资产的媒体本体：媒体资产是它自己，生成资产是成片，提示词没有。 */
export function assetMediaContent(asset: CreationAsset): CreationMediaAssetContent | null {
  if (asset.content.kind === 'media') return asset.content;
  if (asset.content.kind === 'generation') return asset.content.media;
  return null;
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

export interface CategorySuggestion {
  asset_id: string;
  category: string | null;
  confidence: number;
}
