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
