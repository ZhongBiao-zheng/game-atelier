/**
 * 插件界面（沙箱内）与宿主之间的消息协议，v1。宿主 broker 与沙箱内 SDK 共用这一份类型。
 *
 * 通道：宿主在沙箱页面加载完成后，把一个 MessagePort 连同握手消息发给它；之后双方只在这个 port 上通信。
 * 沙箱页面没有网络、没有宿主会话，拿到的每样东西都来自这里定义的方法。
 */
export const PLUGIN_PROTOCOL = 'atelier-plugin/1';
export const HANDSHAKE_TYPE = 'atelier-plugin:init';

export type PluginSurfaceKind = 'node' | 'panel';

export interface PluginTheme {
  mode: 'dark' | 'light';
  /** 设计 token 名（不带 `--`）→ 当前值。SDK 原样写到沙箱页面的 :root 上。 */
  tokens: Record<string, string>;
}

/** 宿主字体的一个分片。字节按需通过 `fonts.request` 取，握手时只给表。 */
export interface PluginFontSlice {
  id: string;
  family: string;
  weight: string;
  style: string;
  unicodeRange: string;
}

export interface PluginHandshake {
  type: typeof HANDSHAKE_TYPE;
  protocol: typeof PLUGIN_PROTOCOL;
  nonce: string;
  plugin_id: string;
  digest: string;
  surface: PluginSurfaceKind;
  theme: PluginTheme;
  fonts: PluginFontSlice[];
}

export interface PluginNodeView {
  node_type: string;
  title: string;
  size: { width: number; height: number };
  payload_schema_version: number;
  payload: unknown;
}

export interface PluginInput {
  /** 只在本次界面实例里有效的句柄；不是文件路径，也不是版本 id。 */
  handle: string;
  kind: 'text' | 'image' | 'video' | 'audio';
  title: string;
  width: number | null;
  height: number | null;
}

export type PluginMethod =
  | 'node.readSelf' | 'node.writeSelf' | 'inputs.list' | 'inputs.read' | 'fonts.request' | 'server.call';

export type PluginErrorCode =
  | 'BAD_REQUEST' | 'UNKNOWN_METHOD' | 'CAPABILITY_DENIED' | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE' | 'INVALID_HANDLE' | 'UNAVAILABLE' | 'INTERNAL'
  /** 插件自己的服务端路由拒绝了请求；`message` 是给用户看的原因。 */
  | 'SERVER_ERROR';

export interface PluginRpcRequest { id: number; method: string; params?: unknown }
export type PluginRpcResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: PluginErrorCode; message: string } };

export interface PluginHostEvents {
  'theme.changed': PluginTheme;
  /** 节点被宿主或别处改了（撤销、同步）。插件应重新 `node.readSelf`。 */
  'node.changed': null;
  'inputs.changed': null;
}
export type PluginHostEventName = keyof PluginHostEvents;
export interface PluginHostEventMessage { event: PluginHostEventName; data: unknown }

/** 写入节点的 payload 上限，与服务端 `CanvasPluginNodeData` 一致。 */
export const PAYLOAD_MAX_BYTES = 256 * 1024;
export const PAYLOAD_MAX_DEPTH = 32;
export const PAYLOAD_MAX_KEYS = 10_000;
