/**
 * 插件清单与列表接口的类型。与 src/character_workflow/lib/plugin_manifest.py 手工同步，
 * 改一边必须改另一边（ADR-0037）。
 */
export type PluginModality = 'text' | 'image' | 'video' | 'audio';
export type PluginSurfaceKind = 'node' | 'panel';
export type PluginCapability =
  | 'node.read_self' | 'node.write_self' | 'resource.read_inputs' | 'resource.create'
  | 'storage.project' | 'server.call';

export interface PluginSize { width: number; height: number }

export interface PluginNodeContribution {
  type: string;
  title: string;
  icon: string;
  default_size: PluginSize;
  min_size: PluginSize | null;
  payload_schema_version: number;
  input_modalities: PluginModality[];
  max_inputs: number | null;
  surfaces: PluginSurfaceKind[];
}

export type PluginImageActionTarget =
  | { kind: 'create_node'; node_type: string; open_panel: boolean }
  | { kind: 'open_panel'; panel: string };

export interface PluginImageAction {
  id: string;
  label: string;
  icon: string;
  action: PluginImageActionTarget;
}

export interface PluginServerRoute {
  method: 'GET' | 'POST';
  path: string;
  access: 'read' | 'edit';
  long_running: boolean;
}

export interface PluginAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  read_only: boolean;
  route: string;
}

export interface PluginAsset {
  id: string;
  title: string;
  urls: string[];
  bytes: number;
  sha256: string;
  required: boolean;
}

export interface PluginPackageFile { path: string; sha256: string; bytes: number }

/** 服务端返回的是包锁文件：源清单 + 文件摘要 + 包摘要。 */
export interface PluginPackageLock {
  manifest_version: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  icon: string;
  publisher: { id: string; name: string };
  sdk_version: string;
  app_version: { min: string; max: string | null };
  ui: { entry: 'ui/index.html' } | null;
  capabilities: string[];
  contributes: {
    nodes: PluginNodeContribution[];
    image_actions: PluginImageAction[];
    server: { module: 'server'; routes: PluginServerRoute[] } | null;
    agent_tools: PluginAgentTool[];
  };
  assets: PluginAsset[];
  state_schema_version: number;
  files: PluginPackageFile[];
  digest: string;
  source: 'bundled';
}

/** ok 可启用；incompatible 清单合法但当前版本不能运行；invalid 清单读不出（manifest 为 null）。 */
export type PluginAvailability = 'ok' | 'incompatible' | 'invalid';

export interface PluginEntry {
  id: string;
  availability: PluginAvailability;
  reason: string | null;
  enabled: boolean;
  manifest: PluginPackageLock | null;
}

export interface PluginListing {
  app_version: string;
  plugins: PluginEntry[];
}
