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
  expires_at: string;
  credential_path: string;
}
export function fetchAgentGrants() {
  return requestJson<{ grants: AgentGrant[]; python: string }>('/api/connection/agent-grants', '读取 Agent 授权');
}
export function createAgentGrant(input: { name: string; project_ids: string[]; canvas_project_ids: string[]; capabilities: AgentCapability[]; days: number }) {
  return requestJson<AgentGrant>('/api/connection/agent-grants', '创建 Agent 授权', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
}
export async function revokeAgentGrant(id: string) {
  await request(`/api/connection/agent-grants/${encodeURIComponent(id)}`, '撤销 Agent 授权', { method: 'DELETE' });
}
