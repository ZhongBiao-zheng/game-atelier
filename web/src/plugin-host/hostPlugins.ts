/**
 * 宿主插件（ADR-0039）：界面是宿主代码的官方插件，启用后才按需加载它的前端分块。
 *
 * 这张表同时是前端的白名单：只有登记在这里、且服务端注册表判为 host 的插件才会走宿主渲染。
 * 插件关闭时不 import 它的分块，画布上它的节点显示占位、数据原样保留。
 */
import { useEffect, useMemo, useSyncExternalStore, type ComponentType } from 'react';

import type { KeyView } from '@/api/keys';
import type {
  CanvasContentNode, CanvasContentVersion, CanvasDocument, CanvasGenerationDefault, CanvasGenerationSlot, CanvasNode,
  CanvasPluginNode, JsonValue,
} from '@/schema/canvas';

import { enabledPlugins, usePlugins } from './registry';

/** 提交一次 Run 的结果：submitted 已受理；not_sent / conflict 确定没有发出（可以再提交）；
 *  error 结果不明或被拒绝（不要自动再提交，可能已经在计费）。 */
export type HostSubmitRunOutcome =
  | { status: 'submitted'; resultNodeId?: string }
  | { status: 'not_sent' | 'conflict' | 'error' };

/** 画布交给宿主插件的能力。插件代码与宿主同源可信，这里给的是画布编辑与提交生成的原语。 */
export interface HostPluginApi {
  projectId: string;
  findNode: (id: string) => CanvasNode | undefined;
  listNodes: () => readonly CanvasNode[];
  resolveVersion: (versionId: string | null | undefined) => CanvasContentVersion | undefined;
  updateNode: (id: string, updater: (node: CanvasNode) => CanvasNode) => void;
  recordHistory: () => void;
  selectNode: (id: string) => void;
  reportError: (message: string) => void;
  clearError: () => void;
  /** 画布顶部的一行提示（几秒后消失），用于操作成功等不需要用户处理的结果。 */
  announce: (message: string) => void;
  /** 把页面上还没保存的编辑落盘（服务端只读已保存的文档）。 */
  savePendingEdits: () => Promise<void>;
  lastRunFailed: (nodeId: string) => boolean;
  /** 本地最新文档（包含还没保存的编辑）。 */
  currentDocument: () => CanvasDocument | null;
  commitDocument: (updater: (document: CanvasDocument) => CanvasDocument, record: boolean) => void;
  /** 提交一个节点的生成，与节点上的「生成」按钮同一条路径（Canvas Run）。 */
  submitRun: (nodeId: string) => Promise<HostSubmitRunOutcome>;
  /** 等本地文档满足条件（画布状态经 React 更新后才可见）；超时返回 false。 */
  waitForDocument: (ready: (document: CanvasDocument) => boolean) => Promise<boolean>;
  providers: () => readonly KeyView[];
  generationDefault: (slot: CanvasGenerationSlot) => CanvasGenerationDefault | undefined;
  newId: (prefix: string) => string;
}

export interface SharedPluginNodeProps {
  node: CanvasPluginNode;
  document: CanvasDocument;
  projectId: string;
  mediaUrl: (versionId: string) => string;
  editable: boolean;
  onPayloadChange: (payload: JsonValue, basePayload: JsonValue) => void;
}

export interface HostPluginNodeProps {
  node: CanvasPluginNode;
  api: HostPluginApi;
}

/** 节点工具条上的一个按钮；按钮由宿主画，与其他节点的工具条一致。 */
export interface HostPluginToolbarAction {
  id: string;
  label: string;
  text: string;
  Icon: ComponentType;
  onClick: () => void;
}

export interface HostPluginNodeType {
  /** 节点外壳由宿主按清单建好（id、标题、位置、尺寸），这里只填 payload；sourceNodeId 是工具栏动作的来源节点。 */
  create: (shell: CanvasPluginNode, sourceNodeId?: string) => CanvasPluginNode;
  Body: ComponentType<HostPluginNodeProps>;
  SharedBody?: ComponentType<SharedPluginNodeProps>;
  toolbar: (node: CanvasPluginNode) => readonly HostPluginToolbarAction[];
  /** 工具栏动作声明 open_panel 时，新建节点后打开它的编辑界面。 */
  openPanel?: (nodeId: string) => void;
  /** 复制粘贴时把 payload 里指向别的节点的 id 改成粘贴出的新 id；没跟着复制的置空。 */
  remapPayload?: (payload: JsonValue, idMap: ReadonlyMap<string, string>) => JsonValue;
  /** 隐藏时按文字内容处理（弱模糊）。 */
  textContent?: boolean;
}

/** host_call 动作正在处理时为 true：宿主把这个插件的入口置灰，避免重复提交（ADR-0041）。 */
export interface HostPluginBusy {
  subscribe: (listener: () => void) => () => void;
  get: () => boolean;
}

export interface HostPluginModule {
  nodeTypes: Readonly<Record<string, HostPluginNodeType>>;
  /** 清单 image_actions 里 host_call 动作的处理函数，按动作 id 登记。 */
  imageActions?: Readonly<Record<string, (node: CanvasContentNode, api: HostPluginApi) => void>>;
  /** 清单 canvas_actions 的处理函数；position 是画布坐标里的建议落点。 */
  canvasActions?: Readonly<Record<string, (api: HostPluginApi, position: { x: number; y: number }) => void>>;
  busy?: HostPluginBusy;
  /** 设置 → 插件里这个插件下方的区域（状态、检测按钮）；插件启用时才渲染。不在项目里，路由调用不带项目。 */
  Settings?: ComponentType;
}

const noBusySubscription = () => () => undefined;
const notBusy = () => false;

/** 宿主插件是否有 host_call 动作在处理中；插件没加载或不提供时为 false。 */
export function useHostPluginBusy(module: HostPluginModule | null | undefined): boolean {
  return useSyncExternalStore(module?.busy?.subscribe ?? noBusySubscription, module?.busy?.get ?? notBusy);
}

const LOADERS: Readonly<Record<string, () => Promise<HostPluginModule>>> = {
  storyboard: () => import('../../../plugins/storyboard/host/storyboard').then(module => module.plugin),
  'ps-bridge': () => import('../../../plugins/ps-bridge/host/psBridge').then(module => module.plugin),
};

export function isHostPluginId(pluginId: string): boolean {
  return Object.hasOwn(LOADERS, pluginId);
}

const loaded = new Map<string, HostPluginModule>();
const pending = new Map<string, Promise<HostPluginModule | null>>();
const listeners = new Set<() => void>();
let version = 0;

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

/** 加载一个宿主插件的分块。调用方负责只在插件启用时调用。 */
export function loadHostPlugin(pluginId: string): Promise<HostPluginModule | null> {
  const ready = loaded.get(pluginId);
  if (ready) return Promise.resolve(ready);
  if (!isHostPluginId(pluginId)) return Promise.resolve(null);
  let promise = pending.get(pluginId);
  if (!promise) {
    promise = LOADERS[pluginId]()
      .then(module => { loaded.set(pluginId, module); notify(); return module; })
      .catch(() => null)
      .finally(() => { pending.delete(pluginId); });
    pending.set(pluginId, promise);
  }
  return promise;
}

/** 已加载的宿主插件；插件关闭时不返回（即使分块已在内存里）。 */
export function loadedHostPlugin(pluginId: string, enabled: boolean): HostPluginModule | null {
  return enabled ? loaded.get(pluginId) ?? null : null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 已启用的宿主插件在画布打开时加载；关闭的不加载。返回已加载、已启用的模块表。 */
export function useHostPlugins(): ReadonlyMap<string, HostPluginModule> {
  const plugins = usePlugins();
  const loadedVersion = useSyncExternalStore(subscribe, () => version);
  const key = enabledPlugins(plugins)
    .filter(plugin => plugin.runtime === 'host' && isHostPluginId(plugin.id)).map(plugin => plugin.id).join('\n');
  useEffect(() => {
    for (const id of key ? key.split('\n') : []) void loadHostPlugin(id);
  }, [key]);
  // 只在启用列表或加载状态变化时换引用：它会进画布的 context。
  return useMemo(() => new Map((key ? key.split('\n') : []).flatMap(id => {
    const module = loadedVersion >= 0 ? loaded.get(id) : undefined;
    return module ? [[id, module] as const] : [];
  })), [key, loadedVersion]);
}

/** 这个节点由哪个宿主插件节点类型渲染；插件关闭、未加载或不是宿主插件时为 null。 */
export function hostNodeType(
  modules: ReadonlyMap<string, HostPluginModule>, node: CanvasNode,
): HostPluginNodeType | null {
  if (node.type !== 'plugin') return null;
  return modules.get(node.data.plugin_id)?.nodeTypes[node.data.node_type] ?? null;
}

/** 同步取：画布里不在 React 渲染路径上的代码（复制粘贴）用。插件关闭或分块没加载时为 null。 */
export function currentHostNodeType(node: CanvasNode): HostPluginNodeType | null {
  if (node.type !== 'plugin') return null;
  const enabled = enabledPlugins().some(plugin => plugin.id === node.data.plugin_id && plugin.runtime === 'host');
  return enabled ? loaded.get(node.data.plugin_id)?.nodeTypes[node.data.node_type] ?? null : null;
}
