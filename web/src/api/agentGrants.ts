import { requestJson, request } from '@/api/http';

export type AgentCapability =
  | 'read' | 'edit_documents' | 'create_targets' | 'prepare_generation' | 'execute_generation'
  | 'canvas_read' | 'canvas_edit' | 'canvas_generate';
export interface AgentGrant {
  grant_id: string;
  name: string;
  project_ids: string[];
  canvas_project_ids: string[];
  capabilities: AgentCapability[];
  /** 「连接本机 Agent」创建的默认授权：凭据在固定位置，插件自带的 MCP 不写路径就能读到。 */
  default?: boolean;
  credential_path: string;
  /** 本次服务运行期间各宿主最近一次连上的时间（ISO）；服务重启后清空。 */
  connections: Partial<Record<AgentClient, string>>;
}
export type AgentClient = 'claude-code' | 'codex';
export type CodexConfigStatus = 'missing' | 'current' | 'outdated';
export function fetchAgentGrants() {
  return requestJson<{ grants: AgentGrant[]; python: string }>('/api/connection/agent-grants', '读取 Agent 授权');
}
export function createAgentGrant(input: { name: string; project_ids: string[]; canvas_project_ids: string[]; capabilities: AgentCapability[]; default: boolean }) {
  return requestJson<AgentGrant>('/api/connection/agent-grants', '创建 Agent 授权', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}
export async function revokeAgentGrant(id: string) {
  await request(`/api/connection/agent-grants/${encodeURIComponent(id)}`, '撤销 Agent 授权', { method: 'DELETE' });
}
export function fetchCodexConfig() {
  return requestJson<{ status: CodexConfigStatus; path: string }>('/api/connection/codex-config', '读取 Codex 配置');
}
export function writeCodexConfig() {
  return requestJson<{ status: CodexConfigStatus; path: string }>('/api/connection/codex-config', '写入 Codex 配置', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
}
