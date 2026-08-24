import type { Job, JobParams } from './jobs';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CanvasPoint { x: number; y: number }
export interface CanvasSize { width: number; height: number }
export interface CanvasViewport { x: number; y: number; zoom: number }

export interface CanvasSettings {
  background: 'lines' | 'dots' | 'grid' | 'none';
  show_image_info: boolean;
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
  | 'angle';

export interface CanvasImageToolbarPreferences {
  tool_ids: CanvasImageQuickToolId[];
  show_labels: boolean;
}

export interface CanvasUiPreferences {
  schema_version: 1;
  revision: number;
  image_toolbar: CanvasImageToolbarPreferences;
  updated_at: string | null;
}

export interface CanvasGenerationDraft {
  mode: 'text' | 'image' | 'video' | 'audio';
  prompt: string;
  input_policy: 'all_connected' | 'mentions_only';
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
}

export interface CanvasTextNode extends CanvasNodeBase {
  type: 'text';
  data: CanvasContentNodeData;
}

export interface CanvasImageNode extends CanvasNodeBase {
  type: 'image';
  data: CanvasContentNodeData & { display: CanvasMediaDisplay };
}

export interface CanvasVideoNode extends CanvasNodeBase {
  type: 'video';
  data: CanvasContentNodeData & { display: CanvasMediaDisplay };
}

export interface CanvasAudioNode extends CanvasNodeBase {
  type: 'audio';
  data: CanvasContentNodeData;
}

export interface CanvasConfigNode extends CanvasNodeBase {
  type: 'config';
  data: { draft: CanvasGenerationDraft };
}

export interface CanvasGroupNode extends CanvasNodeBase {
  type: 'group';
  data: { member_node_ids: string[] };
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

export type CanvasContentNode = CanvasTextNode | CanvasImageNode | CanvasVideoNode | CanvasAudioNode;
export type CanvasNode = CanvasContentNode | CanvasConfigNode | CanvasGroupNode | CanvasPluginNode;

export interface CanvasInputConnection {
  id: string;
  role: 'input';
  source_node_id: string;
  target_node_id: string;
}

export interface CanvasDerivationConnection {
  id: string;
  role: 'derivation';
  source_node_id: string;
  target_node_id: string;
  origin:
    | { kind: 'generation_run'; run_id: string }
    | { kind: 'local_tool'; operation_id: string };
}

export type CanvasConnection = CanvasInputConnection | CanvasDerivationConnection;

export type CanvasContentOrigin =
  | { kind: 'user_edit' }
  | { kind: 'upload'; upload_id: string }
  | { kind: 'user_mask'; source_version_id: string }
  | { kind: 'job_output'; job_id: string; candidate_id: string }
  | {
      kind: 'local_tool';
      operation_id: string;
      source_version_id: string;
      operation:
        | { kind: 'crop'; rect: { x: number; y: number; width: number; height: number } }
        | { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[]; row: number; column: number }
        | { kind: 'upscale'; target_long_edge: number; algorithm: 'nearest' | 'bilinear' | 'lanczos' };
    }
  | { kind: 'import'; package_id: string };

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

export interface CanvasProject {
  schema_version: 2;
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export interface CanvasProjectSummary extends CanvasProject {
  cover: { version_id: string } | null;
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

export interface CanvasTrashEntry {
  trash_id: string;
  original_project_id: string;
  project_name: string;
  deleted_at: string;
  expires_at: string;
  restored_at: string | null;
  restored_project_id: string | null;
}

export interface CanvasUpload {
  version: CanvasMediaVersion;
  filename: string;
  document: CanvasDocument;
}

export type CanvasMediaOperation =
  | { kind: 'crop'; rect: { x: number; y: number; width: number; height: number } }
  | { kind: 'split'; horizontal_lines: number[]; vertical_lines: number[] }
  | {
      kind: 'upscale';
      target_long_edge: 1024 | 2048 | 3072 | 4096;
      algorithm: 'nearest' | 'bilinear' | 'lanczos';
    };

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

export interface RevisionedSidecar<T> {
  schema_version: 1;
  revision: number;
  updated_at: string;
  items: T[];
}

export interface CanvasLibraryAsset {
  asset_id: string;
  version_id: string;
  title: string;
  tags: string[];
}

export interface CanvasPrompt {
  prompt_id: string;
  title: string;
  content: string;
  tags: string[];
  source: 'local' | 'public';
}

export interface CanvasPluginState {
  schema_version: number;
  revision: number;
  plugin_id: string;
  plugin_version: string;
  data: JsonValue;
}
