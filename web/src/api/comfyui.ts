import { requestJson, request } from './http';
import type { WorkflowInput } from './keys';

export interface ComfyWorkflow {
  id: string;
  name: string;
  source_filename: string;
  imported_at: string;
  api_workflow: Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;
  inputs: WorkflowInput[];
  timeout_seconds: number;
}
export interface WorkflowInspection {
  inputs: WorkflowInput[];
  candidates: WorkflowInput[];
  tagged: boolean;
  warnings: string[];
  unmapped: string[];
}
function json(body: unknown) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}
const base = (alias: string) => `/api/comfyui/${encodeURIComponent(alias)}`;
export function checkComfyUI(base_url: string) {
  return requestJson<{ devices: { name: string; vram_total: number }[] }>('/api/comfyui/connection', '测试 ComfyUI', json({ base_url }));
}
export function listWorkflows(alias: string) {
  return requestJson<{ workflows: ComfyWorkflow[] }>(`${base(alias)}/workflows`, '读取工作流');
}
export function inspectWorkflow(alias: string, api_workflow: ComfyWorkflow['api_workflow'], previous_id?: string) {
  return requestJson<WorkflowInspection>(`${base(alias)}/inspect`, '检查工作流', json({ api_workflow, previous_id }));
}
export function saveWorkflow(alias: string, workflow: ComfyWorkflow) {
  const { id, imported_at: _imported, ...body } = workflow;
  return requestJson<ComfyWorkflow>(`${base(alias)}/workflows`, '保存工作流', json({
    name: body.name, source_filename: body.source_filename, api_workflow: body.api_workflow,
    inputs: body.inputs, timeout_seconds: body.timeout_seconds, identifier: id || null,
  }));
}
export function deleteWorkflow(alias: string, id: string) {
  return request(`${base(alias)}/workflows/${encodeURIComponent(id)}`, '删除工作流', { method: 'DELETE' });
}
