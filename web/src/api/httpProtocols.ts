import { request, requestJson } from './http';
import type { HttpProtocolRow, HttpProtocolValidation } from '@/schema/httpProtocols';

const BASE = '/api/http-protocols';

function json(method: string, body: unknown) {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export type HttpProtocolDetail = HttpProtocolRow & { document: Record<string, unknown> };

export function listHttpProtocols() {
  return requestJson<{ protocols: HttpProtocolRow[] }>(BASE, '读取自定义接口');
}

export function getHttpProtocol(id: string) {
  return requestJson<HttpProtocolDetail>(`${BASE}/${encodeURIComponent(id)}`, '读取自定义接口');
}

export function createHttpProtocol(document: unknown) {
  return requestJson<HttpProtocolDetail>(BASE, '保存自定义接口', json('POST', { document }));
}

export function updateHttpProtocol(id: string, document: unknown) {
  return requestJson<HttpProtocolDetail>(`${BASE}/${encodeURIComponent(id)}`, '保存自定义接口',
    json('PUT', { document }));
}

export function deleteHttpProtocol(id: string) {
  return request(`${BASE}/${encodeURIComponent(id)}`, '删除自定义接口', { method: 'DELETE' });
}

export function validateHttpProtocol(document: unknown, options: { baseUrl?: string; model?: string } = {}) {
  return requestJson<HttpProtocolValidation>(`${BASE}/validate`, '检查自定义接口', json('POST', {
    document, base_url: options.baseUrl || null, model: options.model || null,
  }));
}

/** 「AI 帮我配置」可用的对话模型；max_cost_cny 是按资料上限估的最高花费，null 为未计价。 */
export interface AssistModel { alias: string; model_id: string; name: string; max_cost_cny: number | null }

export interface AssistDraft {
  document: Record<string, unknown>;
  notices: string[];
  usage: { input_tokens: number | null; output_tokens: number | null; cost_cny: number | null; job_id: string };
}

export function listAssistModels() {
  return requestJson<{ models: AssistModel[] }>(`${BASE}/assist/models`, '读取对话模型');
}

/** 计费调用：用对话模型按文档起草模板，只返回草稿。 */
export function draftHttpProtocol(body: { kind: string; alias: string; model_id: string; text: string; urls: string[] }) {
  return requestJson<AssistDraft>(`${BASE}/assist`, 'AI 帮我配置', json('POST', body));
}
