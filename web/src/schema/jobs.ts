export type JobStatus = 'pending_confirm' | 'pending' | 'done' | 'failed';

// 2026-05-25 重构: 原 JobKind 改名为 AssetSlot
export type AssetSlot = 'portrait' | 'promo' | 'turnaround';

// 新 JobKind: 媒体类型
export type JobKind = 'image' | 'video';

export type Namespace = 'character' | 'studio' | 'ui';

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
  // B3 UI 页面风格候选来源关系 —— 与 schemas.py::JobParams 同步
  style_variant?: string;
  base_version?: string;
  // Midjourney 专属（family=midjourney）—— 与 schemas.py::JobParams 同步。
  // MJ 的 body 没有 size / quality 字段，一切控制都在 prompt 尾部的 flag 里，由 caller 拼接：
  // prompt 保持画师原文，换模型时不残留。比例复用上面的 ratio 字段（拼成 --ar），
  // 速度档复用 mode（MJ: FAST|RELAX|TURBO，与 kling 的 std|pro 各读各的）。
  bot_type?: string; // MID_JOURNEY | NIJI_JOURNEY（niji 走 botType 不走 flag）
  mj_version?: string; // --v 7 / 6.1
  mj_stylize?: number; // --stylize 0-1000
  mj_chaos?: number; // --chaos 0-100
  mj_weird?: number; // --weird 0-3000
  mj_seed?: number; // --seed
  mj_no?: string; // --no 排除词，逗号分隔
  mj_tile?: boolean; // --tile 无缝平铺
  mj_iw?: number; // --iw 垫图权重 0-3
  // 三种参考图：本地路径或公网 URL（后端把本地文件经 OSS 转直链）。垫图走 reference_images。
  mj_sref?: string[]; // --sref 风格参考
  mj_sw?: number; // --sw 0-1000
  mj_cref?: string[]; // --cref 角色参考
  mj_cw?: number; // --cw 0-100
  mj_oref?: string[]; // --oref Omni Reference
  mj_ow?: number; // --ow 0-1000
  /** caller 回写：本次真实拼出的 flag 串。只读展示，前端不产生。 */
  mj_flags?: string;
  [key: string]: unknown;
}

export interface Job {
  job_id: string;
  character_id: string;
  prompt: string;
  submitted_at: string;
  model: string;
  params: JobParams;
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
  // 2026-07-08: 出图完成时间戳（DONE/FAILED 终态回写；Web 只读）— 与 schemas.py 同步
  completed_at?: string | null;
  // 2026-08-10 (B2): UI 页面 job（namespace='ui'）归项目不归角色；Web 只读 — 与 schemas.py 同步
  project_id?: string | null;
  screen_id?: string | null;
}

export const WEB_EDITABLE_FIELDS = ['prompt', 'params'] as const;
export type WebEditableField = (typeof WEB_EDITABLE_FIELDS)[number];

export interface WebEditableJobPatch {
  prompt?: string;
  params?: JobParams;
}

export interface CharacterEntry {
  id: string;
  name: string;
  status: 'idle' | 'running' | 'done' | 'failed';
  latest_job_id: string | null;
  // 名册缩略图：characters/<id>/portrait/ 最新图的 data-root 相对路径 — 与 schemas.py 同步
  thumbnail?: string | null;
}

// A2（2026-08-10）定稿 — 与 schemas.py::CanonicalStatusEntry/CanonicalStatusFile 同步
// spec_stale/style_stale 是 A3 的服务端计算态（存储指纹 vs 当前指纹），不落盘。
export interface CanonicalEntry {
  path: string; // data-root 相对路径
  set_at: string;
  spec_fingerprint?: string;
  style_fingerprint?: string;
  spec_stale?: boolean;
  style_stale?: boolean;
}

export interface CanonicalFile {
  portrait: CanonicalEntry | null;
  promo: CanonicalEntry | null;
  turnaround: CanonicalEntry | null;
}

// B3（2026-08-10）screen 定稿 — 与 schemas.py::ScreenCanonicalStatusEntry/File 同步
export interface ScreenCanonicalEntry {
  path: string; // data-root 相对路径
  set_at: string;
  style_variant?: string;
  style_fingerprint?: string;
  style_stale?: boolean; // A3 服务端计算态
}

export interface ScreenCanonicalFile {
  screens: Record<string, ScreenCanonicalEntry>;
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
