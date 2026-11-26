/**
 * 插件清单与列表接口的类型。与 src/character_workflow/lib/plugin_manifest.py 手工同步，
 * 改一边必须改另一边（ADR-0037）。
 */
export type PluginModality = 'text' | 'image' | 'video' | 'audio';
export type PluginSurfaceKind = 'node' | 'panel';
export type PluginCapability =
  | 'node.read_self' | 'node.write_self' | 'resource.read_inputs' | 'resource.create'
  | 'storage.project' | 'server.call' | 'generation.draft';

export interface PluginSize { width: number; height: number }

export interface PluginNodeContribution {
  type: string;
  title: string;
  icon: string;
  default_size: PluginSize;
  min_size: PluginSize | null;
  payload_schema_version: number;
  shared_fields?: string[];
  input_modalities: PluginModality[];
  max_inputs: number | null;
  surfaces: PluginSurfaceKind[];
  /** 连进来的是结果组封面时，按组内顺序把封面与成员都交给插件。 */
  expand_result_stack: boolean;
}

/** host_call 只有宿主插件可用、目前只在图片工具栏与画布入口实现：点击后交给插件分块里同 id 的处理函数（ADR-0041）。 */
export interface PluginHostCallTarget { kind: 'host_call' }

export type PluginMediaActionTarget =
  | { kind: 'create_node'; node_type: string; open_panel: boolean }
  | { kind: 'open_panel'; panel: string }
  | PluginHostCallTarget;

/** 图片 / 视频节点工具栏「更多」里的一项（清单 image_actions / video_actions）。 */
export interface PluginMediaAction {
  id: string;
  label: string;
  icon: string;
  action: PluginMediaActionTarget;
}

/** 画布添加菜单里的一项（清单 canvas_actions，只有宿主插件可用）。 */
export interface PluginCanvasAction {
  id: string;
  label: string;
  icon: string;
  action: PluginHostCallTarget;
}

export interface PluginServerRoute {
  method: 'POST';
  path: string;
  access: 'read' | 'edit';
  long_running: boolean;
  /** 只给 Agent 调（ADR-0043），浏览器经插件路由调不到；只有宿主插件可用。 */
  agent_only?: boolean;
}

export interface PluginAgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  read_only: boolean;
  route: string;
  /** 只有宿主插件可用（ADR-0043）：画布 Agent 每次调用都确认；确认卡显示 summary_field 参数的原文。 */
  always_confirm?: boolean;
  summary_field?: string | null;
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
  /** sandbox：界面在沙箱 iframe 里；host：界面是宿主代码、按需加载（ADR-0039）。
   *  是不是 host 以服务端注册表的白名单为准，前端只认 `plugin-host/hostPlugins.ts` 里登记过的 id。 */
  runtime?: 'sandbox' | 'host';
  ui: { entry: 'ui/index.html' } | null;
  capabilities: string[];
  contributes: {
    nodes: PluginNodeContribution[];
    image_actions: PluginMediaAction[];
    video_actions: PluginMediaAction[];
    /** 文本节点工具栏上的按钮。 */
    text_actions?: PluginMediaAction[];
    canvas_actions?: PluginCanvasAction[];
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
