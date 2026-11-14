/** 自定义接口模板（ADR-0036）—— 与 src/character_workflow/lib/http_protocol_schema.py 一一对应。
 *
 * 结构校验以服务端为准（POST /api/http-protocols/validate）；前端只持有类型与能力声明，
 * 两端共用夹具 tests/fixtures/http_protocol_cases.json。 */

export type HttpProtocolKind = 'image' | 'video';

export interface HttpProtocolResult {
  urls?: string[];
  base64?: string[];
  error?: string | null;
}

export interface HttpProtocolDocument {
  version: 1;
  name: string;
  kind: HttpProtocolKind;
  auth: { type: 'bearer' | 'header' | 'query' | 'none'; name?: string | null; prefix?: string | null };
  submit: {
    path: string;
    format?: 'json' | 'multipart';
    headers?: Record<string, string>;
    body?: unknown;
  };
  inputs?: { images?: { max: number; encode?: 'data_url' | 'base64' | 'file' | 'url' } | null };
  options?: { ratio?: string[] | null; resolution?: string[] | null; duration?: number[] | null; count?: number };
  derive?: Record<string, { from: string | string[]; map: Record<string, unknown> }>;
  result?: HttpProtocolResult;
  poll?: {
    path: string;
    method?: 'GET' | 'POST';
    body?: unknown;
    task_id: string;
    status: string;
    success: string[];
    failure?: string[];
    interval_seconds?: number;
    timeout_seconds?: number | null;
    result: HttpProtocolResult;
  } | null;
  /** 目录发现：只发一次 GET，读模型 id / 名称 / 类别；价格类字段不读。 */
  catalog?: {
    path: string;
    items?: string | null;
    id?: string;
    name?: string | null;
    kind?: { field: string; map: Record<string, 'image' | 'video' | 'text' | 'audio' | 'excluded'> } | null;
  } | null;
}

/** 服务端按模板算出的能力声明：控件只显示非 null 的项，提交时服务端按同一份再校验。 */
export interface DeclaredCapabilities {
  kind: HttpProtocolKind;
  ratios: string[] | null;
  resolutions: string[] | null;
  durations: number[] | null;
  max_count: number;
  reference_images: number;
  frames: 0 | 1 | 2;
}

/** 随 GET /api/keys 的模型返回；模板缺失或损坏时只有 available=false + error。 */
export type ModelDeclared =
  | ({ available: true; error: null; name: string } & DeclaredCapabilities)
  | { available: false; error: string | null; name: null };

export interface HttpProtocolIssue {
  path: string;
  message: string;
}

export interface HttpProtocolRow {
  id: string;
  name: string;
  kind: HttpProtocolKind | null;
  available: boolean;
  error: string | null;
  declared: DeclaredCapabilities | null;
  /** 模板写了 catalog，可用于按目录发现模型。 */
  catalog: boolean;
  used_by: { alias: string; model: string }[];
}

export interface HttpProtocolCallPreview {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface HttpProtocolValidation {
  valid: boolean;
  issues: HttpProtocolIssue[];
  declared: DeclaredCapabilities | null;
  preview: { submit: HttpProtocolCallPreview; poll?: HttpProtocolCallPreview } | null;
}

export function availableDeclared(declared?: ModelDeclared | null): DeclaredCapabilities | null {
  return declared?.available ? declared : null;
}
