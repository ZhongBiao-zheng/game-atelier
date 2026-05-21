export type JobStatus = 'pending_confirm' | 'pending' | 'done' | 'failed';

export type JobKind = 'portrait' | 'promo' | 'turnaround';

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
  // Skill 套件扩展（2026-05-19）：旧 json 无字段时后端 Pydantic 默认 portrait。
  kind?: JobKind;
  source_image?: string | null;
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
