import { requestJson } from './http';
import type { ModelModality } from './keys';

export type RouteMode = 'order' | 'cheap' | 'round_robin';

export interface ModelRouteMember {
  alias: string;
  provider: string;
  base_url: string | null;
  billing_group?: string | null;
  estimate_cny?: number | null;
  model_id: string;
  name: string;
  protocol: string | null;
  /** 成员是局域网 Atelier 时：网关那边的成员快照。 */
  via?: ModelRouteMember[];
}

/** 路由组：成员按当前方式排列，实际提交会按当次参数冻结顺序。 */
export interface ModelRoute {
  id: string;
  name: string;
  modality: ModelModality;
  mode: RouteMode;
  candidate_alias: string | null;
  members: ModelRouteMember[];
}

export async function setModelRouteMode(modality: ModelModality, id: string, mode: RouteMode): Promise<ModelRoute> {
  return requestJson<ModelRoute>('/api/models/mode', `调整「${id}」的路由方式`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modality, id, mode }),
  });
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
