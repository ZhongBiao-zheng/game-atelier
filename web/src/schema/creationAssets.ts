export type CreationAssetKind = 'prompt' | 'media' | 'generation';

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

export type RecipeInputRole = 'reference' | 'mask' | 'mj_sref' | 'mj_cref' | 'mj_oref';

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
  adopted_from?: AdoptionOrigin | null;
}

/** 把 Studio 某次出图的第 output_index 张（Job.output_paths 下标）存成生成资产。 */
export interface CreationGenerationFromJob {
  job_id: string;
  output_index: number;
  title: string;
  tags: string[];
  project_id?: string | null;
}

/** 把画布节点的一个生成版本存成生成资产；项目归属取 canvas_project_id。 */
export interface CreationGenerationFromCanvas {
  canvas_project_id: string;
  node_id: string;
  version_id: string;
  title: string;
  tags: string[];
}

export type CreationAssetStaleness = 'fresh' | 'stale' | 'withdrawn' | 'unknown';

export interface CreationAssetList {
  revision: number;
  assets: CreationAsset[];
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
