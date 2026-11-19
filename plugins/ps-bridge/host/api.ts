import { ApiError, requestJson } from '@/api/http';

/** PS 联动的服务端路由（宿主插件，ADR-0041）：服务端仍核对插件已启用、路由已声明与读写类别。
 *  projectId 为 null 时不带项目（设置页的状态区）；这时服务端的 ctx 不能读写项目。 */
async function route<T>(projectId: string | null, path: string, action: string, params: unknown): Promise<T> {
  try {
    const body = await requestJson<{ result: T }>(`/api/plugins/ps-bridge/routes${path}`, action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(projectId === null ? { params } : { project_id: projectId, params }),
    });
    return body.result;
  } catch (error) {
    // 服务端给的是一句给用户看的话（「Photoshop 未启动」），直接用它，不再套「xx 失败：…（HTTP 409）」。
    if (error instanceof ApiError && error.reason) throw new Error(error.reason);
    throw error;
  }
}

export interface PsBridgeStatus {
  supported: boolean;
  installed: boolean;
  running: boolean;
  /** macOS 的自动化授权会记在这个应用名下。 */
  responsible_app: string | null;
  version: string | null;
  active_document: string | null;
}

export type PsImportScope = 'merged' | 'layer';

/** probe 为假时不和 Photoshop 说话；为真时读版本（第一次会触发系统的自动化授权弹窗）。 */
export function fetchPsStatus(probe: boolean) {
  return route<PsBridgeStatus>(null, '/status', '检测 Photoshop', { probe });
}

export function importFromPhotoshop(projectId: string, scope: PsImportScope) {
  return route<{ node_id: string; title: string }>(projectId, '/import', '从 Photoshop 取图', { scope });
}

export function placeInPhotoshop(projectId: string, nodeId: string) {
  return route<{ document: string | null; layer: string; returned_to_origin: boolean }>(
    projectId, '/place', '发到 Photoshop', { node_id: nodeId });
}

export interface PsExecuteLogEntry {
  at: string;
  caller: string;
  project_id: string | null;
  document_id: number;
  code: string;
  ok: boolean;
  error: string | null;
  duration_ms: number;
}

/** 脚本开关（ADR-0043）：allowScripts 省略时只读当前值。 */
export function psScriptSettings(allowScripts?: boolean) {
  return route<{ allow_scripts: boolean }>(null, '/settings', '保存 PS 联动设置',
    allowScripts === undefined ? {} : { allow_scripts: allowScripts });
}

export function fetchPsExecuteLog() {
  return route<{ entries: PsExecuteLogEntry[] }>(null, '/execute-log', '读取执行记录', {});
}
