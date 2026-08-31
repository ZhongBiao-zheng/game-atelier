export interface CanvasBatchRun {
  batch_id: string;
  project_id: string;
  scope_node_id: string;
  title: string;
  source_node_id: string | null;
  expected_revision: number;
  repeat_count: number;
  items: { id: string; image_version_ids: string[] }[];
  steps: { node_id: string; title: string; mode: 'text' | 'image' | 'video' | 'audio'; model: string }[];
  executions: {
    item_index: number;
    round_index: number;
    step_index: number;
    job_id: string;
    run_id: string;
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
    version_id: string | null;
    error: string | null;
  }[];
  status: 'ready' | 'running' | 'stopping' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  created_at: string;
  updated_at: string;
  error: string | null;
}

export const isCanvasBatchActive = (run: CanvasBatchRun) => (
  run.status === 'running' || run.status === 'stopping'
);

export const CANVAS_BATCH_STATUS: Record<CanvasBatchRun['status'], string> = {
  ready: '待确认', running: '执行中', stopping: '停止中', completed: '已完成',
  failed: '已停止 · 有失败', canceled: '已停止', interrupted: '已中断',
};
