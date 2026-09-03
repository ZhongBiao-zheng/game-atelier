import { requestJson } from './http';
import type { CanvasBatchRun } from '@/schema/canvasBatch';

const base = (projectId: string) => `/api/canvas/projects/${encodeURIComponent(projectId)}/batch-runs`;

export const listCanvasBatches = (projectId: string) => (
  requestJson<CanvasBatchRun[]>(base(projectId), '读取批量执行')
);

export const prepareCanvasBatch = (projectId: string, nodeId: string, revision: number, repeat: number) => (
  requestJson<CanvasBatchRun>(`${base(projectId)}/prepare`, '检查批量执行', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scope_node_id: nodeId, expected_revision: revision, repeat_count: repeat }),
  })
);

export const startCanvasBatch = (projectId: string, batchId: string) => (
  requestJson<CanvasBatchRun>(`${base(projectId)}/${encodeURIComponent(batchId)}/start`, '开始批量执行', { method: 'POST' })
);

export const cancelCanvasBatch = (projectId: string, batchId: string) => (
  requestJson<CanvasBatchRun>(`${base(projectId)}/${encodeURIComponent(batchId)}/cancel`, '停止批量执行', { method: 'POST' })
);
