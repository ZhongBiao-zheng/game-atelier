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
  lovart_attachments?: string[];
  lovart_thread_id?: string;
  lovart_final_status?: string;
  warnings?: string[];
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
  name: string;
  created_at: string;
}

export interface ProjectsFile {
  projects: Project[];
  assignments: Record<string, string>;  // character_id → project_id
}
