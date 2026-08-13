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
  const r = await fetch('/api/keys');
  if (!r.ok) throw new Error(`listKeys: ${r.status}`);
  return r.json();
}

export async function createKey(payload: KeyCreatePayload): Promise<{ alias: string }> {
  const r = await fetch('/api/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`createKey ${r.status}: ${body}`);
  }
  return r.json();
}

export async function patchKey(alias: string, patch: Partial<KeyCreatePayload>): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`patchKey ${r.status}`);
}

export async function deleteKey(alias: string): Promise<void> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}`, { method: 'DELETE' });
  if (!r.ok) throw new Error(`deleteKey ${r.status}`);
}

/** 按需取某个已存密钥的明文（编辑表单查看用）；列表/创建接口仍只回掩码。 */
export async function revealKey(alias: string): Promise<{ access_key: string }> {
  const r = await fetch(`/api/keys/${encodeURIComponent(alias)}/reveal`);
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`revealKey ${r.status}: ${body}`);
  }
  return r.json();
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
  const r = await fetch('/api/keys/models-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    let detail = body;
    try { detail = JSON.parse(body).detail ?? body; } catch { /* keep raw */ }
    throw new Error(String(detail));
  }
  return r.json();
}
