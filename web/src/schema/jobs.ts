export type JobStatus = 'pending_confirm' | 'pending' | 'done' | 'failed';

// 2026-05-25 重构: 原 JobKind 改名为 AssetSlot
export type AssetSlot = 'portrait' | 'promo' | 'turnaround';

// 新 JobKind: 媒体类型
export type JobKind = 'image' | 'video';

export type Namespace = 'character' | 'studio';

export interface JobParams {
  size?: string;
  steps?: number;
  cfg_scale?: number;
  vendor?: string;
  n?: number;
  reference_images?: string[];
  requested_size?: string;
  actual_size?: string;
  warnings?: string[];
  // 图片参数 —— 与 schemas.py::JobParams 同步（ratio 如 "16:9"；quality: low|medium|high|auto）
  ratio?: string;
  quality?: string;
  // 视频参数（kind=video）—— 与 schemas.py::JobParams 同步
  duration?: number;
  resolution?: string;
  mode?: string; // kling 生成档位 std|pro（≠ frame_mode）
  frame_mode?: 'auto' | 'first' | 'last' | 'firstlast';
  generate_audio?: boolean;
  reference_videos?: string[];
  reference_audios?: string[];
  [key: string]: unknown;
}

export interface Job {
  job_id: string;
  character_id: string;
  prompt: string;
  submitted_at: string;
  model: string;
  params: JobParams;
  seed: number | null;
  output_paths: string[];
  status: JobStatus;
  error: string | null;
  asset_slot?: AssetSlot;
  kind?: JobKind;
  namespace?: Namespace;
  source_image?: string | null;
  alias?: string | null;
  provider?: string | null;
  // 2026-06-10: retry-job 克隆 failed job 时指回原 job_id — 与 schemas.py 同步
  retry_of?: string | null;
  // 2026-06-12: 出图进度真实卡点（视频 caller 回写；Web 只读）— 与 schemas.py 同步
  progress_phase?: 'sent' | 'downloading' | null;
}

export const WEB_EDITABLE_FIELDS = ['prompt', 'model', 'params', 'seed'] as const;
export type WebEditableField = (typeof WEB_EDITABLE_FIELDS)[number];

export interface WebEditableJobPatch {
  prompt?: string;
  model?: string;
  params?: JobParams;
  seed?: number | null;
}

export interface CharacterEntry {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  latest_job_id: string | null;
}

export interface ActiveCharacterFile {
  active_id: string | null;
  updated_at: string;
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  created_at: string;
}

export interface ProjectsFile {
  projects: Project[];
  assignments: Record<string, string>;  // character_id → project_id
}
