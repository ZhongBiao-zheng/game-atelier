import { requestJson } from './http';
import type { ModelModality } from './keys';

export interface ModelRouteMember {
  alias: string;
  provider: string;
  base_url: string | null;
  billing_group?: string | null;
  model_id: string;
  name: string;
  protocol: string | null;
  /** 成员是局域网 Atelier 时：网关那边的成员快照。 */
  via?: ModelRouteMember[];
}

/** 路由组：同一模型在多个 KEY 下的成员，按出图顺序排列（第一个就是「自动」时实际使用的）。 */
export interface ModelRoute {
  id: string;
  name: string;
  modality: ModelModality;
  members: ModelRouteMember[];
}

export async function listModelRoutes(): Promise<ModelRoute[]> {
  const body = await requestJson<{ models?: ModelRoute[] }>('/api/models', '读取模型列表');
  if (!Array.isArray(body.models)) throw new Error('读取模型列表失败：返回格式不对');
  return body.models;
}

export async function setModelRouteOrder(
  modality: ModelModality, id: string, aliases: string[],
): Promise<ModelRoute> {
  return requestJson<ModelRoute>('/api/models/order', `调整「${id}」的供应商顺序`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modality, id, aliases }),
  });
}
