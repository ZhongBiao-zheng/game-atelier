import { requestJson } from './http';

export interface GroupPlan {
  order: string[];
  steps: {node_id: string; name: string; model: string; estimate_cny: number | null}[];
  total_cny: number;
  unpriced: number;
  cycle: boolean;
  blocked: {node_id: string; name: string; reason: string}[];
  needs_confirmation: boolean;
}

export interface GroupRun {
  run_id: string;
  group_id: string;
  status: 'running' | 'failed' | 'interrupted' | 'done' | 'cancelled';
  steps: {node_id: string; status: 'pending' | 'failed' | 'done'; error: string | null}[];
}

const base = (project: string) => `/api/canvas/projects/${encodeURIComponent(project)}`;
const group = (project: string, id: string) => `${base(project)}/groups/${encodeURIComponent(id)}`;
const post = {method: 'POST', headers: {'Content-Type': 'application/json'}};

export function listGroupRuns(project: string) {
  return requestJson<GroupRun[]>(base(project) + '/group-runs', '读取整体执行');
}
export function planGroupRun(project: string, id: string) {
  return requestJson<GroupPlan>(group(project, id) + '/run-plan', '读取执行计划', post);
}
export function startGroupRun(project: string, id: string, {order, total_cny}: GroupPlan) {
  return requestJson<GroupRun>(group(project, id) + '/group-runs', '开始执行',
    {...post, body: JSON.stringify({order, total_cny})});
}
export function updateGroupRun(project: string, runId: string, action: 'resume' | 'cancel') {
  return requestJson<GroupRun>(`${base(project)}/group-runs/${encodeURIComponent(runId)}/${action}`,
    action === 'resume' ? '继续执行' : '取消执行', post);
}
