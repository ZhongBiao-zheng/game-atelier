import { requestJson } from './http';

export interface UiScheme {
  id: string;
  name: string;
  created_at: string;
}

export interface UiSchemesFile {
  default_scheme_id: string;
  schemes: UiScheme[];
}

export interface UiSchemeCreate {
  name: string;
  source_scheme_id: string | null;
  copy_style: boolean;
  copy_screen_map: boolean;
  screen_ids: string[];
}

function base(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/ui-schemes`;
}

export function fetchUiSchemes(projectId: string): Promise<UiSchemesFile> {
  return requestJson<UiSchemesFile>(base(projectId), '读取 UI 方案');
}

export function createUiScheme(
  projectId: string,
  payload: UiSchemeCreate,
): Promise<UiSchemesFile> {
  return requestJson<UiSchemesFile>(base(projectId), '新建 UI 方案', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function setDefaultUiScheme(
  projectId: string,
  schemeId: string,
): Promise<UiSchemesFile> {
  return requestJson<UiSchemesFile>(`${base(projectId)}/default`, '设置默认 UI 方案', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scheme_id: schemeId }),
  });
}
