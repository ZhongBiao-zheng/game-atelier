/**
 * 宿主侧的 capability broker：沙箱发来的每一条消息都先过这里（ADR-0012）。
 *
 * 一个 broker 实例绑定一个界面实例，也就绑定了一个插件、一个项目、一个节点。协议里没有
 * 「节点 id」「项目 id」「路径」这类参数：插件指不到别的节点、别的项目、别的插件的数据。
 * 这里不信任消息的任何部分——形状、大小、频率、方法名、句柄都要验。
 */
import {
  PAYLOAD_MAX_BYTES, PAYLOAD_MAX_DEPTH, PAYLOAD_MAX_KEYS,
  type PluginErrorCode, type PluginInput, type PluginMethod, type PluginNodeView, type PluginRpcResponse,
} from '../../../plugins/sdk/protocol';

export interface BrokerInput {
  versionId: string;
  kind: PluginInput['kind'];
  title: string;
  width: number | null;
  height: number | null;
}

export interface BrokerOptions {
  /** 本项目批准给这个插件的能力。 */
  capabilities: ReadonlySet<string>;
  readNode: () => PluginNodeView | null;
  writePayload: (payload: unknown) => void;
  listInputs: () => readonly BrokerInput[];
  readInput: (versionId: string, as: 'bitmap' | 'bytes' | 'text') => Promise<ImageBitmap | ArrayBuffer | string>;
  loadFonts: (ids: readonly string[]) => Promise<Array<{ id: string; bytes: ArrayBuffer }>>;
  /** 调用本插件声明的服务端路由。`versionIds` 是已由 broker 核对过的、当前连在节点上的素材。 */
  callServer: (path: string, params: Record<string, unknown>, versionIds: string[]) => Promise<unknown>;
  now?: () => number;
}

export interface BrokerReply { response: PluginRpcResponse; transfer: Transferable[] }

/** 方法 → 需要的能力。null 表示不需要（字体是宿主自带的公开资源）。表外的方法一律拒绝。 */
const REQUIRED_CAPABILITY: Record<PluginMethod, string | null> = {
  'node.readSelf': 'node.read_self',
  'node.writeSelf': 'node.write_self',
  'inputs.list': 'resource.read_inputs',
  'inputs.read': 'resource.read_inputs',
  'fonts.request': null,
  'server.call': 'server.call',
};

/** 与清单里路由 path 的格式一致；不含 `.`，所以拼不出 `..`。 */
const SERVER_PATH = /^\/[a-z0-9][a-z0-9/_-]{0,79}$/;
const MAX_SERVER_INPUTS = 64;

/** `callServer` 抛它时，原因会原样转给插件界面（服务端给用户看的那句话）；其他报错一律不透出细节。 */
export class PluginServerError extends Error {}

const RATE_WINDOW_MS = 1000;
const RATE_MAX_CALLS = 60;
const MAX_CONCURRENT = 8;
const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_FONT_IDS = 32;

class BrokerError extends Error {
  constructor(readonly code: PluginErrorCode, message: string) { super(message); }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
);

/** 只接受纯 JSON：超深、超多键、非 JSON 类型（函数、Map、二进制、循环引用）都拒绝。返回规范化后的副本。 */
export function normalizePayload(payload: unknown): unknown {
  let keys = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > PAYLOAD_MAX_DEPTH) throw new BrokerError('PAYLOAD_TOO_LARGE', '数据层级过深');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new BrokerError('BAD_REQUEST', '数据里有无效数字');
      return value;
    }
    if (Array.isArray(value)) {
      keys += value.length;
      if (keys > PAYLOAD_MAX_KEYS) throw new BrokerError('PAYLOAD_TOO_LARGE', '数据条目过多');
      return value.map(item => visit(item, depth + 1));
    }
    if (isPlainObject(value)) {
      const copy: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new BrokerError('BAD_REQUEST', '数据里有不允许的键');
        }
        keys += 1;
        if (keys > PAYLOAD_MAX_KEYS) throw new BrokerError('PAYLOAD_TOO_LARGE', '数据条目过多');
        copy[key] = visit(item, depth + 1);
      }
      return copy;
    }
    throw new BrokerError('BAD_REQUEST', '数据必须是纯 JSON');
  };
  const normalized = visit(payload, 0);
  if (new TextEncoder().encode(JSON.stringify(normalized)).length > PAYLOAD_MAX_BYTES) {
    throw new BrokerError('PAYLOAD_TOO_LARGE', '数据超过 256 KiB');
  }
  return normalized;
}

function paramsSize(params: unknown): number {
  try {
    return JSON.stringify(params)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function createBroker(options: BrokerOptions) {
  const now = options.now ?? (() => Date.now());
  const handleByVersion = new Map<string, string>();
  const versionByHandle = new Map<string, string>();
  let recent: number[] = [];
  let running = 0;
  let closed = false;

  const handleFor = (versionId: string) => {
    let handle = handleByVersion.get(versionId);
    if (!handle) {
      handle = crypto.randomUUID();
      handleByVersion.set(versionId, handle);
      versionByHandle.set(handle, versionId);
    }
    return handle;
  };

  async function dispatch(method: PluginMethod, params: unknown): Promise<{ result: unknown; transfer: Transferable[] }> {
    switch (method) {
      case 'node.readSelf': {
        const node = options.readNode();
        if (!node) throw new BrokerError('UNAVAILABLE', '节点已不存在');
        return { result: node, transfer: [] };
      }
      case 'node.writeSelf': {
        if (!isPlainObject(params) || !('payload' in params)) throw new BrokerError('BAD_REQUEST', '缺少 payload');
        if (!options.readNode()) throw new BrokerError('UNAVAILABLE', '节点已不存在');
        options.writePayload(normalizePayload(params.payload));
        return { result: { ok: true }, transfer: [] };
      }
      case 'inputs.list': {
        const inputs: PluginInput[] = options.listInputs().map(input => ({
          handle: handleFor(input.versionId), kind: input.kind, title: input.title,
          width: input.width, height: input.height,
        }));
        return { result: inputs, transfer: [] };
      }
      case 'inputs.read': {
        if (!isPlainObject(params) || typeof params.handle !== 'string'
          || (params.as !== 'bitmap' && params.as !== 'bytes' && params.as !== 'text')) {
          throw new BrokerError('BAD_REQUEST', '参数不对');
        }
        // 句柄必须是本实例发出去的，而且对应的素材此刻仍连在这个节点上。
        const versionId = versionByHandle.get(params.handle);
        const input = versionId ? options.listInputs().find(item => item.versionId === versionId) : undefined;
        if (!versionId || !input) throw new BrokerError('INVALID_HANDLE', '素材句柄无效');
        if ((params.as === 'text') !== (input.kind === 'text')) throw new BrokerError('BAD_REQUEST', '读取方式与素材类型不符');
        const result = await options.readInput(versionId, params.as);
        return { result, transfer: typeof result === 'string' ? [] : [result] };
      }
      case 'fonts.request': {
        if (!isPlainObject(params) || !Array.isArray(params.ids) || params.ids.length > MAX_FONT_IDS
          || !params.ids.every(id => typeof id === 'string')) {
          throw new BrokerError('BAD_REQUEST', '参数不对');
        }
        const fonts = await options.loadFonts(params.ids as string[]);
        return { result: fonts, transfer: fonts.map(font => font.bytes) };
      }
      case 'server.call': {
        if (!isPlainObject(params) || typeof params.path !== 'string' || !SERVER_PATH.test(params.path)
          || (params.params !== undefined && !isPlainObject(params.params))
          || (params.inputs !== undefined && (!Array.isArray(params.inputs) || params.inputs.length > MAX_SERVER_INPUTS
            || !params.inputs.every(handle => typeof handle === 'string')))) {
          throw new BrokerError('BAD_REQUEST', '参数不对');
        }
        const connected = new Set(options.listInputs().map(input => input.versionId));
        const versionIds = ((params.inputs as string[] | undefined) ?? []).map(handle => {
          const versionId = versionByHandle.get(handle);
          if (!versionId || !connected.has(versionId)) throw new BrokerError('INVALID_HANDLE', '素材句柄无效');
          return versionId;
        });
        const body = normalizePayload(params.params ?? {}) as Record<string, unknown>;
        try {
          return { result: await options.callServer(params.path, body, versionIds), transfer: [] };
        } catch (error) {
          if (error instanceof PluginServerError) throw new BrokerError('SERVER_ERROR', error.message);
          throw error;
        }
      }
    }
  }

  /** 处理一条来自沙箱的消息。连 id 都读不出的消息直接丢弃（返回 null），不给任何回应。 */
  async function handle(raw: unknown): Promise<BrokerReply | null> {
    if (closed || !isPlainObject(raw) || typeof raw.id !== 'number' || !Number.isSafeInteger(raw.id)) return null;
    const id = raw.id;
    const fail = (code: PluginErrorCode, message: string): BrokerReply => (
      { response: { id, ok: false, error: { code, message } }, transfer: [] }
    );
    const moment = now();
    recent = recent.filter(time => moment - time < RATE_WINDOW_MS);
    if (recent.length >= RATE_MAX_CALLS || running >= MAX_CONCURRENT) return fail('RATE_LIMITED', '调用过于频繁');
    recent.push(moment);
    if (typeof raw.method !== 'string' || !Object.hasOwn(REQUIRED_CAPABILITY, raw.method)) {
      return fail('UNKNOWN_METHOD', '不支持的方法');
    }
    const method = raw.method as PluginMethod;
    const capability = REQUIRED_CAPABILITY[method];
    if (capability !== null && !options.capabilities.has(capability)) {
      return fail('CAPABILITY_DENIED', '本项目没有允许这项能力');
    }
    if (method !== 'node.writeSelf' && paramsSize(raw.params) > MAX_PARAMS_BYTES) {
      return fail('PAYLOAD_TOO_LARGE', '参数过大');
    }
    running += 1;
    try {
      const { result, transfer } = await dispatch(method, raw.params);
      return closed ? null : { response: { id, ok: true, result }, transfer };
    } catch (error) {
      if (error instanceof BrokerError) return fail(error.code, error.message);
      // 宿主内部的报错（路径、接口地址、堆栈）不透给插件。
      return fail('INTERNAL', '宿主处理失败');
    } finally {
      running -= 1;
    }
  }

  return { handle, close: () => { closed = true; } };
}
