import { request, requestJson } from './http';
export type ApiModality = 'image' | 'video' | 'audio' | 'llm' | string;
export type ModelModality = 'text' | 'image' | 'video' | 'audio';

export interface KeyView {
  alias: string;
  provider: string;
  base_url: string | null;
  access_key: string; // masked
  secret_key: null;
  capabilities: string[];
  models: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes: string;
  created_at: string;
}

export interface KeyCreatePayload {
  alias: string;
  provider: string;
  base_url?: string | null;
  access_key: string;
  secret_key?: string | null;
  capabilities: string[];
  models?: KeyModel[];
  homepage_url?: string | null;
  docs_url?: string | null;
  api_key_url?: string | null;
  modalities?: ApiModality[];
  notes?: string;
}

export interface KeyModel {
  name: string;
  id: string;
  /** 模型级生成模态；缺省时按 key 级 modalities 兜底（见 modelModality）。 */
  modality?: ModelModality | null;
  /** 调用协议 id —— 四模态均由后端解析；不可解析时 null。 */
  protocol?: string | null;
}

/** 模型分类的统一判定：模型级标注优先，未标注按 key 级 modalities 兜底。 */
export function modelModality(
  model: Pick<KeyModel, 'modality'> | undefined,
  key: { modalities?: ApiModality[] } | undefined,
): ModelModality {
  if (model?.modality) return model.modality;
  const km = key?.modalities ?? [];
  if (km.length === 1 && km[0] === 'video') return 'video';
  if (km.length === 1 && km[0] === 'audio') return 'audio';
  if (km.length === 1 && km[0] === 'llm') return 'text';
  return 'image';
}

export async function listKeys(): Promise<{ keys: KeyView[] }> {
  return requestJson<{ keys: KeyView[] }>('/api/keys', '读取密钥列表');
}

export async function createKey(payload: KeyCreatePayload): Promise<{ alias: string }> {
  return requestJson<{ alias: string }>('/api/keys', `新增密钥「${payload.alias}」`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function patchKey(alias: string, patch: Partial<KeyCreatePayload>): Promise<void> {
  await request(`/api/keys/${encodeURIComponent(alias)}`, `修改密钥「${alias}」`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export async function deleteKey(alias: string): Promise<void> {
  await request(`/api/keys/${encodeURIComponent(alias)}`, `删除密钥「${alias}」`, { method: 'DELETE' });
}

/** 按需取某个已存密钥的明文（编辑表单查看用）；列表/创建接口仍只回掩码。 */
export async function revealKey(alias: string): Promise<{ access_key: string }> {
  return requestJson<{ access_key: string }>(
    `/api/keys/${encodeURIComponent(alias)}/reveal`,
    `查看密钥「${alias}」明文`,
  );
}

/** 上游模型分类（后端 _classify_model 的瀑布结果）：
 * - `text` / `image` / `video` / `audio`：能直接当 modality 用
 * - `unknown`：认不出（协议词汇各厂自造，词表追不完）——**不等于垃圾**，要画师自己确认
 * - `excluded`：明确不能生成上述内容，默认不返回，只在 include_all 逃生舱下出现 */
export type ModelCategory = 'text' | 'image' | 'video' | 'audio' | 'unknown' | 'excluded';

/** 上游模型列表条目（/api/keys/models-preview 归一化结果）；modality null = 分类未定（见 category）。 */
export interface RemoteModel {
  id: string;
  name: string;
  modality: ModelModality | null;
  category: ModelCategory;
  protocol: string | null;
}

export interface ModelsPreview {
  models: RemoteModel[];
  /** 上游去重后的模型总数（含被过滤掉的那些）。 */
  total: number;
  /** 判定为「不可生成」而未返回的条数；include_all 下恒为 0。 */
  excluded: number;
}

export async function previewModels(payload: {
  alias?: string | null;
  provider?: string | null;
  base_url?: string | null;
  access_key?: string | null;
  /** 逃生舱：连判定为不可生成的模型也一并返回。 */
  include_all?: boolean;
}): Promise<ModelsPreview> {
  // 这条报错直接贴在密钥表单里给画师看，detail 已是中文（routes.py 的 502/422 分支）。
  return requestJson<ModelsPreview>('/api/keys/models-preview', '拉取模型列表', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
