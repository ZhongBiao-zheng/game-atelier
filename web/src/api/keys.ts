import { request, requestJson } from './http';
export type ApiModality = 'image' | 'video' | 'audio' | 'llm' | string;
export type ModelModality = 'image' | 'video';

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
  /** 模型级图片/视频分类；缺省时按 key 级 modalities 兜底（见 modelModality）。 */
  modality?: ModelModality | null;
  /** 调用协议 id —— 视频 seedance/kling/dashscope、图片 ark/openai；不可解析时 null。 */
  protocol?: string | null;
}

/** 模型分类的统一判定：模型级标注优先，未标注按 key 级 modalities 兜底
 *（仅声明 video 的 key 视为视频模型，其余一律图片）。 */
export function modelModality(
  model: Pick<KeyModel, 'modality'> | undefined,
  key: { modalities?: ApiModality[] } | undefined,
): ModelModality {
  if (model?.modality) return model.modality;
  const km = key?.modalities ?? [];
  return km.includes('video') && !km.includes('image') ? 'video' : 'image';
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

/** 上游模型分类（后端 _classify_model 的四级瀑布结果）：
 * - `image` / `video`：能直接当 modality 用
 * - `unknown`：认不出（协议词汇各厂自造，词表追不完）——**不等于垃圾**，要画师自己确认
 * - `excluded`：明确非视觉（对话 / 语音 / 搜索），默认不返回，只在 include_all 逃生舱下出现 */
export type ModelCategory = 'image' | 'video' | 'unknown' | 'excluded';

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
  /** 判定为「明确非视觉」而未返回的条数；include_all 下恒为 0（全部都返回了）。 */
  excluded: number;
}

export async function previewModels(payload: {
  alias?: string | null;
  provider?: string | null;
  base_url?: string | null;
  access_key?: string | null;
  /** 逃生舱：连明确非视觉的模型也一并返回（deny 词表判过头时让画师自己绕过去）。 */
  include_all?: boolean;
}): Promise<ModelsPreview> {
  // 这条报错直接贴在密钥表单里给画师看，detail 已是中文（routes.py 的 502/422 分支）。
  return requestJson<ModelsPreview>('/api/keys/models-preview', '拉取模型列表', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
