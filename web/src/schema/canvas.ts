import type { Job, JobParams } from './jobs';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CanvasPoint { x: number; y: number }
export interface CanvasSize { width: number; height: number }
/** Derived group bounds are finite and positive, without the media surface's 4000px cap. */
export type CanvasGroupSize = CanvasSize;
export interface CanvasViewport { x: number; y: number; zoom: number }

export interface CanvasSettings {
  background: 'lines' | 'dots' | 'none';
  show_image_info: boolean;
  show_minimap: boolean;
}

export type CanvasImageQuickToolId =
  | 'info'
  | 'delete'
  | 'saveAsset'
  | 'download'
  | 'copyPrompt'
  | 'reversePrompt'
  | 'replace'
  | 'resize'
  | 'maskEdit'
  | 'crop'
  | 'split'
  | 'upscale'
  | 'removeBackground'
  | 'angle';

export interface CanvasImageToolbarPreferences {
  tool_ids: CanvasImageQuickToolId[];
}

export interface CanvasUiPreferences {
  schema_version: 2;
  revision: number;
  image_toolbar: CanvasImageToolbarPreferences;
  generation_defaults: CanvasGenerationDefaults;
  upscale: CanvasUpscalePreferences;
  updated_at: string | null;
}

/** alias 为 null =「自动」：model 是路由 id，提交时服务端按组内顺序解析 KEY。 */
export interface CanvasGenerationModelSelection {
  alias: string | null;
  model: string;
}

export type CanvasUpscaleTarget = '2K' | '4K' | '8K';

/** 一个档位的「AI高清」配置：selection 为 null 时服务端自动选模（仅 2K / 4K 有自动路线）；
 *  quality 只对暴露质量档的模型生效，按像素出图的模型直接用档位长边；prompt 留空保存后服务端填回内置提示词。 */
export interface CanvasUpscaleTierPreferences {
  selection: CanvasGenerationModelSelection | null;
  quality: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto' | null;
  prompt: string;
}

export interface CanvasUpscalePreferences {
  tiers: Record<CanvasUpscaleTarget, CanvasUpscaleTierPreferences>;
}

export type CanvasGenerationMode = 'text' | 'image' | 'video' | 'audio';

export interface CanvasTextDefaultParams {
  n?: number;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: 'auto' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface CanvasImageDefaultParams {
  size_mode?: 'auto' | 'ratio' | 'custom';
  custom_size?: string;
  n?: number;
  ratio?: string;
  resolution?: string;
  size?: string;
  quality?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';
  complexity?: 'low' | 'medium' | 'high';
}

export interface CanvasVideoDefaultParams {
  duration?: number;
  ratio?: string;
  resolution?: string;
  frame_mode?: 'auto' | 'firstlast';
  mode?: 'std' | 'pro';
  generate_audio?: boolean;
  watermark?: boolean;
}

export interface CanvasAudioDefaultParams {
  /** 音色随模型协议变化（data/audio_caps.json），MiniMax 还接受自定义音色 ID。 */
  voice?: string;
  response_format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
  speed?: number;
  instructions?: string;
}

/** 音乐偏好只记纯音乐开关；歌词与首数是每次的决定。 */
export interface CanvasMusicDefaultParams {
  instrumental?: boolean;
}

/** 生成偏好的槽位：四种生成模式，外加音乐（音乐节点的生成模式仍是 audio，偏好单独存一份）。 */
export type CanvasGenerationSlot = CanvasGenerationMode | 'music';

export interface CanvasGenerationParamsByMode {
  text: CanvasTextDefaultParams;
  image: CanvasImageDefaultParams;
  video: CanvasVideoDefaultParams;
  audio: CanvasAudioDefaultParams;
  music: CanvasMusicDefaultParams;
}

export interface CanvasGenerationDefault<M extends CanvasGenerationSlot = CanvasGenerationSlot> {
  selection: CanvasGenerationModelSelection | null;
  params: CanvasGenerationParamsByMode[M];
}

export type CanvasGenerationDefaults = {
  [M in CanvasGenerationSlot]: CanvasGenerationDefault<M>;
};

export interface CanvasGenerationDraft {
  mode: CanvasGenerationMode;
  prompt: string;
  input_policy: 'all_connected';
  model: string;
  alias?: string | null;
  params: JobParams;
  updated_at: string;
}

export interface CanvasContentNodeData {
  current_version_id: string | null;
  generation_draft: CanvasGenerationDraft | null;
  active_run_id: string | null;
}

export interface CanvasTextDisplay {
  scale: 'xs' | 'sm' | 'base';
}

export interface CanvasTextNodeData extends CanvasContentNodeData {
  display: CanvasTextDisplay;
}

export interface CanvasMediaDisplay {
  fit: 'contain' | 'cover';
  free_resize: boolean;
}

interface CanvasNodeBase {
  created_by?: string | null;
  created_by_client?: string | null;
  id: string;
  title: string;
  position: CanvasPoint;
  size?: CanvasSize | null;
  z_index: number;
  /** 内容打码：只影响显示，连线 / 导出 / 参考照常。 */
  hidden?: boolean;
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  data: CanvasTextNodeData;
}

export interface CanvasImageNode extends CanvasNodeBase {
  type: 'image';
  data: CanvasContentNodeData & {
    display: CanvasMediaDisplay;
    annotation?: CanvasImageAnnotation | null;
    result_stack?: CanvasResultStack | null;
  };
}

/** 一次生成出多张时的结果组：封面（本节点）+ 其余结果各自的图片节点。
 *  `run_id` 是已拆成节点的那次生成；成员 id 读时按存在过滤。 */
export interface CanvasResultStack {
  run_id: string;
  member_node_ids: string[];
}

export type AnnotationColor = '#F04438' | '#FACC15' | '#22C55E' | '#3B82F6' | '#FFFFFF';
export type AnnotationPoint = [number, number];
interface AnnotationElementBase { id: string; color: AnnotationColor }
export interface AnnotationRect extends AnnotationElementBase {
  type: 'rect'; x: number; y: number; width: number; height: number; stroke_width: number;
}
export interface AnnotationArrow extends AnnotationElementBase {
  type: 'arrow'; start: AnnotationPoint; end: AnnotationPoint; stroke_width: number;
}
export interface AnnotationFreedraw extends AnnotationElementBase {
  type: 'freedraw'; points: AnnotationPoint[]; stroke_width: number;
}
export interface AnnotationText extends AnnotationElementBase {
  type: 'text'; x: number; y: number; text: string; font_size: number; background: boolean;
}
export type AnnotationElement = AnnotationRect | AnnotationArrow | AnnotationFreedraw | AnnotationText;
export interface CanvasImageAnnotation {
  version_id: string;
  elements: AnnotationElement[];
  visible: boolean;
  rendered_version_id: string | null;
  /** 只含标注、背景透明的同尺寸 PNG（GPT Image 2.6 markup）；与合成图各自独立失效。 */
  markup_version_id?: string | null;
}

export interface CanvasVideoNode extends CanvasNodeBase {
  type: 'video';
  data: CanvasContentNodeData & { display: CanvasMediaDisplay };
}

export interface CanvasAudioNode extends CanvasNodeBase {
  type: 'audio';
  data: CanvasContentNodeData;
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  size?: CanvasGroupSize | null;
  data: { member_node_ids: string[] };
}

export interface CanvasLayerBoundingBox {
  absolute: [number, number, number, number];
  normalized: [number, number, number, number];
}

export interface CanvasLayerStackLayer {
  id: string;
  version_id: string;
  z_index: number;
  name: string;
  description: string;
  bounding_box: CanvasLayerBoundingBox;
  visible: boolean;
  material_node_id?: string | null;
}

export interface CanvasLayerStackNode extends CanvasNodeBase {
  type: 'layer_stack';
  data: {
    source_version_id: string;
    alias: string | null;
    model: string | null;
    prompt: string;
    resolution: 'auto' | '1K' | '1.5K' | '2K';
    /** 最多输出张数（含底图），只有 Seedream 5.5 支持；缺省由厂商默认 30。 */
    max_images?: number | null;
    base_version_id: string | null;
    base_visible: boolean;
    base_z_index?: number;
    base_material_node_id?: string | null;
    layout_size?: CanvasSize | null;
    layers: CanvasLayerStackLayer[];
    active_run_id: string | null;
    error: string | null;
  };
}

export interface CanvasPluginNode extends CanvasNodeBase {
  type: 'plugin';
  data: {
    plugin_id: string;
    node_type: string;
    plugin_version: string;
    /** 创建节点时的包摘要；早于它的文档没有这个字段。 */
    package_digest?: string | null;
    data_schema_version: number;
    payload: JsonValue;
    shared_placeholder?: boolean;
    generation_draft: CanvasGenerationDraft | null;
  };
}

export interface CanvasImageEditSettings {
  mode: 'inpaint' | 'outpaint';
  width?: number; height?: number; x?: number; y?: number;
}

export interface CanvasImageEditEditorState {
  strokes: Array<{ tool: 'brush' | 'eraser' | 'rectangle'; size: number; points: CanvasPoint[] }>;
  frame: CanvasSize & CanvasPoint;
  frame_ratio: string;
}

export interface CanvasImageEditNode extends CanvasNodeBase {
  type: 'image_edit';
  data: {
    source_node_id: string | null;
    source_version_id: string;
    mask_version_id: string | null;
    reference_node_id: string | null;
    reference_version_id: string | null;
    generation_draft: CanvasGenerationDraft | null;
    options: CanvasImageEditSettings;
    editor_state: CanvasImageEditEditorState;
    active_run_id: string | null;
  };
}

export interface CanvasNormalizedFrame { x: number; y: number; width: number; height: number }

/** 对比的两张图由 before / after 两条输入连线决定，节点自身不存内容。 */
export interface CanvasCompareNode extends CanvasNodeBase {
  type: 'compare';
  data: Record<string, never>;
}

export type CanvasContentNode = CanvasTextNode | CanvasImageNode | CanvasVideoNode | CanvasAudioNode;
export type CanvasNode = CanvasContentNode | CanvasGroupNode | CanvasPluginNode | CanvasImageEditNode
  | CanvasLayerStackNode | CanvasCompareNode;

export type CanvasVideoFrameSlot = 'first_frame' | 'last_frame';
export type CanvasCompareSlot = 'before' | 'after';

export interface CanvasInputConnection {
  id: string;
  role: 'input';
  source_node_id: string;
  target_node_id: string;
  slot?: CanvasVideoFrameSlot | CanvasCompareSlot | null;
  annotated?: boolean;
  /** 带标注连线的发送形式：缺省 = 目标支持时发原图 + 标注层，否则合成图；'composite' 固定合成图。 */
  annotation_delivery?: CanvasAnnotationDelivery | null;
}

export type CanvasAnnotationDelivery = 'markup' | 'composite';

export interface CanvasMaterialConnection {
  id: string;
  role: 'material';
  source_node_id: string;
  target_node_id: string;
}

export type CanvasConnection = CanvasInputConnection | CanvasMaterialConnection;

export type CanvasContentOrigin =
  | { kind: 'user_edit' }
  | { kind: 'upload'; upload_id: string }
  | { kind: 'user_mask'; source_version_id: string; expanded_canvas?: boolean }
  | { kind: 'job_output'; job_id: string; candidate_id: string }
  | { kind: 'layer_decomposition'; job_id: string; output_index: number }
  | {
      kind: 'local_tool';
      operation_id: string;
      source_version_id: string;
      operation:
        | { kind: 'crop'; rect: { x: number; y: number; width: number; height: number } }
        | { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[]; row: number; column: number }
        | { kind: 'upscale'; target_long_edge: number; algorithm: 'nearest' | 'bilinear' | 'lanczos' }
        | { kind: 'remove_background'; model: string };
    }
  | { kind: 'import'; package_id: string }
  | { kind: 'creation_asset_snapshot'; title: string; asset_id?: string | null };

export interface CanvasFrozenInput {
  role: 'reference' | 'mask' | 'markup' | 'first_frame' | 'last_frame' | 'source' | 'mj_sref' | 'mj_cref' | 'mj_oref';
  kind: 'image' | 'video' | 'audio' | 'text';
  order: number;
  version_id?: string | null;
  text?: string | null;
}

export interface CanvasFrozenGeneration {
  schema_version: 1;
  source_kind: 'canvas' | 'studio' | 'shared_canvas';
  mode: 'image' | 'video' | 'audio' | 'text';
  prompt: string;
  model_id: string;
  model_name?: string | null;
  provider: string;
  provider_label?: string | null;
  provider_icon?: string | null;
  params: Record<string, string | number | boolean>;
  inputs: CanvasFrozenInput[];
  duration_s?: number | null;
  cost_cny?: number | null;
  created_by?: string | null;
  submitted_at?: string | null;
}

interface CanvasContentVersionBase {
  frozen_generation?: CanvasFrozenGeneration | null;
  version_id: string;
  created_at: string;
  sha256: string;
  origin: CanvasContentOrigin;
}

export interface CanvasTextVersion extends CanvasContentVersionBase {
  kind: 'text';
  text: string;
}

export interface CanvasMediaVersion extends CanvasContentVersionBase {
  pending_shared_original?: { host_id: string; project_id: string; version_id: string } | null;
  kind: 'image' | 'video' | 'audio';
  path: string;
  mime_type: string;
  bytes: number;
  width?: number | null;
  height?: number | null;
  duration_ms?: number | null;
}

export type CanvasContentVersion = CanvasTextVersion | CanvasMediaVersion;

export interface CanvasDocument {
  schema_version: 2;
  project_id: string;
  revision: number;
  viewport: CanvasViewport;
  settings: CanvasSettings;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  content_versions: Record<string, CanvasContentVersion>;
  updated_at: string;
}

export const DEFAULT_CANVAS_CATEGORIES = ['弹窗', '角色', '底图', '按钮', '图标', '字效'];

export interface CanvasProject {
  migrated_from_workshop: string | null;
  schema_version: 2;
  project_id: string;
  name: string;
  categories: string[];
  category_spec_files: Record<string, string>;
  created_at: string;
  updated_at: string;
}

export interface CanvasProjectSummary extends CanvasProject {
  cover: { version_id: string } | null;
  node_count: number;
  connection_count: number;
}

export interface CanvasAgentTokenUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface CanvasAgentReference {
  reference_id: string;
  kind: 'node' | 'content';
  node_id: string | null;
  version_id: string | null;
  title: string;
}

export interface CanvasAgentMessageCreate {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  title?: string | null;
  text?: string;
  reasoning_summary?: string | null;
  turn_id?: string | null;
  references?: CanvasAgentReference[];
}

export interface CanvasAgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool' | 'error';
  title: string | null;
  text: string;
  reasoning_summary: string | null;
  turn_id: string | null;
  references: CanvasAgentReference[];
  message_id: string;
  sequence: number;
  created_at: string;
}

export type CanvasAgentStatus = 'idle' | 'running' | 'awaiting_approval' | 'interrupted' | 'failed';
export type CanvasAgentPermissionMode = 'review' | 'auto';
/** 全能：按需求出图或出视频；图像 / 视频创作：只用对应类型的模型。 */
export type CanvasAgentCreationMode = 'all' | 'image' | 'video';

/** 模型偏好里的一项生成模型（别名 + 模型成对）。 */
/** alias 为 null =「自动」：model 是路由 id，生成时按组内顺序解析 KEY。 */
export interface CanvasAgentModelRef {
  alias: string | null;
  model: string;
}
export type CanvasAgentEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** 一次待确认的工具调用；会话停在 awaiting_approval，直到用户逐条执行或拒绝。 */
export interface CanvasAgentApproval {
  call_id: string;
  tool: string;
  arguments?: string;
  summary: string;
}

export interface CanvasAgentSession {
  schema_version: 1;
  revision: number;
  sequence: number;
  session_id: string;
  project_id: string;
  title: string;
  status: CanvasAgentStatus;
  model: string | null;
  model_alias: string | null;
  effort: CanvasAgentEffort | null;
  permission_mode: CanvasAgentPermissionMode;
  creation_mode: CanvasAgentCreationMode;
  /** 自动：Agent 从全部可用生成模型里挑；关掉后只能用 preferred_models（一个没选就不能生成）。 */
  auto_models: boolean;
  /** 用户勾选的模型；打开自动时保留，再关掉时恢复。 */
  preferred_models: CanvasAgentModelRef[];
  token_usage: CanvasAgentTokenUsage;
  messages: CanvasAgentMessage[];
  /** 发给模型的上下文（Agents SDK input items），页面不解析。 */
  history: Record<string, unknown>[];
  pending_approvals: CanvasAgentApproval[];
  created_node_ids: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CanvasAgentSessionUpdate {
  title?: string;
  model?: string;
  model_alias?: string;
  effort?: CanvasAgentEffort | 'off';
  permission_mode?: CanvasAgentPermissionMode;
  creation_mode?: CanvasAgentCreationMode;
  auto_models?: boolean;
  preferred_models?: CanvasAgentModelRef[];
}

export interface CanvasAgentTurnCreate {
  text: string;
  node_ids?: string[];
  /** 用户在输入框点选的 Skill：本轮把它的说明附在消息里。 */
  skill?: string;
}

export interface CanvasAgentSkill {
  name: string;
  description: string;
  /** 带脚本的 Skill 只用文字说明，脚本不执行。 */
  has_scripts: boolean;
  builtin: boolean;
}

/** 会话调对话模型的累计用量（服务端 agent_usage.session_totals）。cost_cny 只合计有价格的请求。 */
export interface CanvasAgentSessionUsage {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_cny: number | null;
  /** 没有价格的请求数；经局域网网关的请求由主机结算，本机都算这里。 */
  unpriced: number;
  source: 'local' | 'lan' | 'mixed';
}

/** Agent 发起的生成本轮累计估价超过 confirm_above_cny 时，Auto 下也先确认（服务端 canvas_agent_cost）。 */
export interface CanvasAgentSettings {
  confirm_above_cny: number;
}

export interface CanvasAgentApprovalDecision {
  call_id: string;
  approve: boolean;
  /** 批量生成（run_generations）里勾选执行的项（下标）；不给就是全部执行。 */
  items?: number[];
}

/** 确认卡上一项生成的参考图（画布节点的当前版本）。 */
export interface CanvasAgentBatchItemReference {
  node_id: string;
  version_id: string;
  title: string;
}

/** 生成确认卡的一项（服务端现算，不落盘）；estimate_cny 为 null = 未计价。画布单次生成也按一项返回。 */
export interface CanvasAgentBatchItem {
  index: number;
  node_id: string;
  title: string;
  model: string | null;
  count: number;
  estimate_cny: number | null;
  /** 截断后的提示词开头；创作台不给。 */
  prompt?: string | null;
  references?: CanvasAgentBatchItemReference[];
}

export interface CanvasAgentBatchItems {
  turn_estimate_cny?: number | null;
  confirm_above_cny: number;
  items: CanvasAgentBatchItem[];
}

export type CanvasAgentPlanStatus = 'pending' | 'in_progress' | 'completed';

export interface CanvasAgentPlanItem {
  title: string;
  status: CanvasAgentPlanStatus;
}

/** Agent 用 update_plan 写的待办（会话旁的 sidecar 文件，服务端 CanvasAgentPlan）。 */
export interface CanvasAgentPlan {
  schema_version: 1;
  items: CanvasAgentPlanItem[];
  updated_at: string;
}

export interface CanvasAgentChatModel {
  alias: string;
  provider?: string;
  base_url?: string | null;
  icon?: string | null;
  model: string;
  name: string;
  reasoning: boolean | null;
}

export interface CanvasAgentGenerationModel extends CanvasAgentModelRef {
  provider?: string | null;
  base_url?: string | null;
  icon?: string | null;
  name: string;
  kind: 'image' | 'video';
}

export interface CanvasAgentChatModelList {
  refresh_pending: boolean;
  models: CanvasAgentChatModel[];
  errors: { alias: string; message: string }[];
}

export interface CanvasAgentSessionSummary {
  session_id: string;
  project_id: string;
  title: string;
  status: CanvasAgentStatus;
  revision: number;
  sequence: number;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface CanvasAgentSessionList {
  sessions: CanvasAgentSessionSummary[];
  corrupt_session_ids: string[];
}

export interface CanvasPackageInspection {
  token: string;
  package_id: string;
  expires_at: string;
  projects: CanvasProject[];
  entry_count: number;
  extracted_bytes: number;
}

export interface CanvasPackageImport {
  projects: CanvasProject[];
}

export interface CanvasUpload {
  version: CanvasMediaVersion;
  filename: string;
  document: CanvasDocument;
}

export type CanvasMediaOperation =
  | { kind: 'crop'; rect: { x: number; y: number; width: number; height: number } }
  | { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[] }
  | { kind: 'remove_background' };

export interface CanvasMattingModelStatus {
  model_id: string;
  ready: boolean;
  bytes: number;
  provider: string;
  available: boolean;
  message: string | null;
}

export interface CanvasMediaOperationResult {
  operation_id: string;
  document: CanvasDocument;
  created_version_ids: string[];
  created_node_ids: string[];
}

export interface CanvasRun {
  job: Job;
  document: CanvasDocument;
}

/** 画布复刻的结果：与创作资产插入画布同样返回整份文档，另带没能带过来的内容说明。 */
export interface CanvasReproduceResponse extends CanvasDocument {
  warnings: string[];
}

export interface CanvasPluginState {
  schema_version: number;
  revision: number;
  plugin_id: string;
  plugin_version: string;
  data: JsonValue;
}

export type StudioAgentSessionSummary = Pick<CanvasAgentSessionSummary, 'session_id' | 'title' | 'updated_at' | 'status' | 'revision'>;

export interface StudioAgentStep {
  step_id: string;
  tool: string;
  summary: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'rejected';
}

export interface StudioAgentTurn {
  turn_id: string;
  client_message_id: string;
  status: CanvasAgentStatus;
  attachment_ids: string[];
  asset_ids: string[];
  steps: StudioAgentStep[];
}

export interface StudioAgentSession extends Omit<CanvasAgentSession, 'project_id' | 'history' | 'created_node_ids'> {
  turns: StudioAgentTurn[];
}
