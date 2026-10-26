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
  voice?: 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx'
    | 'sage' | 'shimmer' | 'verse' | 'marin' | 'cedar';
  response_format?: 'mp3' | 'wav' | 'opus' | 'aac' | 'flac' | 'pcm';
  speed?: number;
  instructions?: string;
}

export interface CanvasGenerationParamsByMode {
  text: CanvasTextDefaultParams;
  image: CanvasImageDefaultParams;
  video: CanvasVideoDefaultParams;
  audio: CanvasAudioDefaultParams;
}

export interface CanvasGenerationDefault<M extends CanvasGenerationMode = CanvasGenerationMode> {
  selection: CanvasGenerationModelSelection | null;
  params: CanvasGenerationParamsByMode[M];
}

export type CanvasGenerationDefaults = {
  [M in CanvasGenerationMode]: CanvasGenerationDefault<M>;
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
  batch_result?: {
    batch_id: string;
    template_node_id: string;
    source_node_id: string | null;
    item_id: string;
    image_version_ids: string[];
    round_index: number;
  } | null;
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
  data: CanvasContentNodeData & { display: CanvasMediaDisplay; annotation?: CanvasImageAnnotation | null };
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

export interface CanvasBatchMaterialItem {
  id: string;
  image_version_ids: string[];
}

export interface CanvasBatchMaterialNode extends CanvasNodeBase {
  type: 'batch_material';
  data: { items: CanvasBatchMaterialItem[] };
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
    data_schema_version: number;
    payload: JsonValue;
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
  | CanvasBatchMaterialNode | CanvasLayerStackNode | CanvasCompareNode;

export type CanvasVideoFrameSlot = 'first_frame' | 'last_frame';
export type CanvasCompareSlot = 'before' | 'after';

export interface CanvasInputConnection {
  id: string;
  role: 'input';
  source_node_id: string;
  target_node_id: string;
  slot?: CanvasVideoFrameSlot | CanvasCompareSlot | null;
  annotated?: boolean;
}

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

interface CanvasContentVersionBase {
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
  arguments: string;
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
}

export interface CanvasAgentApprovalDecision {
  call_id: string;
  approve: boolean;
}

export interface CanvasAgentChatModel {
  alias: string;
  model: string;
  name: string;
  reasoning: boolean | null;
}

export interface CanvasAgentGenerationModel extends CanvasAgentModelRef {
  name: string;
  kind: 'image' | 'video';
}

export interface CanvasAgentChatModelList {
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
