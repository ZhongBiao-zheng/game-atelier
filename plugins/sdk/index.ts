/**
 * 沙箱内使用的插件 SDK：等宿主握手、套用主题与字体、提供类型化的 RPC。
 * 不依赖任何框架；插件界面用什么渲染由插件自己决定。
 */
import {
  HANDSHAKE_TYPE, NONCE_GLOBAL, PLUGIN_PROTOCOL, READY_TYPE,
  type PluginErrorCode, type PluginFontSlice, type PluginHandshake, type PluginHostEventMessage,
  type PluginHostEventName, type PluginHostEvents, type PluginInput, type PluginNodeView,
  type PluginRpcResponse, type PluginSurfaceKind, type PluginTheme,
} from './protocol';

export * from './protocol';

export class PluginRpcError extends Error {
  readonly code: PluginErrorCode;
  constructor(code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginRpcError';
    this.code = code;
  }
}

export interface PluginClient {
  readonly pluginId: string;
  readonly surface: PluginSurfaceKind;
  readonly theme: PluginTheme;
  node: {
    readSelf(): Promise<PluginNodeView>;
    writeSelf(payload: unknown): Promise<void>;
  };
  inputs: {
    list(): Promise<PluginInput[]>;
    readBitmap(handle: string): Promise<ImageBitmap>;
    readBytes(handle: string): Promise<ArrayBuffer>;
    readText(handle: string): Promise<string>;
  };
  server: {
    /**
     * 调用本插件在清单里声明的服务端路由。`inputs` 传素材句柄，服务端拿到的是对应的文件；
     * 界面自己拿不到文件路径。
     */
    call<Result = unknown>(path: string, params?: Record<string, unknown>, inputs?: string[]): Promise<Result>;
  };
  on<Name extends PluginHostEventName>(event: Name, listener: (data: PluginHostEvents[Name]) => void): () => void;
}

function applyTheme(theme: PluginTheme) {
  const root = document.documentElement;
  root.classList.toggle('light', theme.mode === 'light');
  root.style.colorScheme = theme.mode;
  for (const [name, value] of Object.entries(theme.tokens)) root.style.setProperty(`--${name}`, value);
}

/** `U+4E00-9FFF, U+20` → 区间表。写法不认识的片段直接跳过。 */
function parseUnicodeRange(value: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const part of value.split(',')) {
    const match = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(part.trim());
    if (!match) continue;
    const low = parseInt(match[1].replace(/\?/g, '0'), 16);
    const high = match[2] ? parseInt(match[2], 16) : parseInt(match[1].replace(/\?/g, 'F'), 16);
    ranges.push([low, high]);
  }
  return ranges;
}

type FontLoader = (ids: string[]) => Promise<Array<{ id: string; bytes: ArrayBuffer }>>;

/** 宿主字体不走网络：按页面里实际出现的字，向宿主要对应分片的字节，再在本页注册。 */
function startFontLoader(slices: PluginFontSlice[], request: FontLoader) {
  const pending = new Map(slices.map(slice => [slice.id, { slice, ranges: parseUnicodeRange(slice.unicodeRange) }]));
  let scheduled = false;
  const schedule = () => {
    if (scheduled || pending.size === 0) return;
    scheduled = true;
    window.setTimeout(() => void scan(), 120);
  };
  const scan = async () => {
    scheduled = false;
    const points = new Set<number>();
    for (const char of document.body?.textContent ?? '') points.add(char.codePointAt(0)!);
    const wanted = [...pending.values()]
      .filter(({ ranges }) => ranges.length === 0
        || [...points].some(point => ranges.some(([low, high]) => point >= low && point <= high)))
      .slice(0, 16);
    if (wanted.length === 0) return;
    for (const { slice } of wanted) pending.delete(slice.id);
    try {
      for (const { id, bytes } of await request(wanted.map(({ slice }) => slice.id))) {
        const slice = wanted.find(item => item.slice.id === id)?.slice;
        if (!slice) continue;
        const face = new FontFace(slice.family, bytes, {
          weight: slice.weight, style: slice.style, unicodeRange: slice.unicodeRange || undefined,
        });
        document.fonts.add(await face.load());
      }
    } catch {
      // 字体取不到就用系统字体，界面功能不受影响。
    }
    schedule();
  };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule();
}

/** 等宿主握手。页面加载后调用一次；宿主没有在 `timeoutMs` 内握手就拒绝。 */
export function connect(timeoutMs = 10_000): Promise<PluginClient> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('宿主没有握手')), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      // 只认父窗口（宿主）发来的握手。同一页面里别的插件界面也能向这个窗口发消息，
      // 不校验来源的话，它可以抢先发一条伪造的握手，把本插件的通道接到自己手里。
      if (event.source !== window.parent) return;
      const hello = event.data as Partial<PluginHandshake> | null;
      const port = event.ports[0];
      if (!port || hello?.type !== HANDSHAKE_TYPE) return;
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
      if (hello.protocol !== PLUGIN_PROTOCOL || !hello.theme || !hello.plugin_id || !hello.surface) {
        reject(new Error('宿主协议版本不兼容'));
        return;
      }
      resolve(createClient(port, hello as PluginHandshake));
    };
    window.addEventListener('message', onMessage);
  });
}

function createClient(port: MessagePort, hello: PluginHandshake): PluginClient {
  let nextId = 1;
  let theme = hello.theme;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  const listeners = new Map<PluginHostEventName, Set<(data: unknown) => void>>();

  port.onmessage = (event: MessageEvent) => {
    const message = event.data as (PluginRpcResponse | PluginHostEventMessage) | null;
    if (!message || typeof message !== 'object') return;
    if ('event' in message) {
      if (message.event === 'theme.changed') {
        theme = message.data as PluginTheme;
        applyTheme(theme);
      }
      for (const listener of listeners.get(message.event) ?? []) listener(message.data);
      return;
    }
    const entry = waiting.get(message.id);
    if (!entry) return;
    waiting.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new PluginRpcError(message.error.code, message.error.message));
  };

  const call = <Result>(method: string, params?: unknown): Promise<Result> => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
    port.postMessage({ id, method, params });
  });

  // 第一条消息必须是握手证明：nonce 只在宿主拼出来的这份页面里，别的页面拿到 port 也过不了这一关。
  const nonce = (window as unknown as Record<string, unknown>)[NONCE_GLOBAL];
  port.postMessage({ type: READY_TYPE, nonce: typeof nonce === 'string' ? nonce : '' });

  applyTheme(theme);
  startFontLoader(hello.fonts ?? [], ids => call('fonts.request', { ids }));

  return {
    pluginId: hello.plugin_id,
    surface: hello.surface,
    get theme() { return theme; },
    node: {
      readSelf: () => call<PluginNodeView>('node.readSelf'),
      writeSelf: async payload => { await call('node.writeSelf', { payload }); },
    },
    inputs: {
      list: () => call<PluginInput[]>('inputs.list'),
      readBitmap: handle => call<ImageBitmap>('inputs.read', { handle, as: 'bitmap' }),
      readBytes: handle => call<ArrayBuffer>('inputs.read', { handle, as: 'bytes' }),
      readText: handle => call<string>('inputs.read', { handle, as: 'text' }),
    },
    server: {
      call: (path, params, inputs) => call('server.call', { path, params: params ?? {}, inputs: inputs ?? [] }),
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener as (data: unknown) => void);
      listeners.set(event, set);
      return () => { set.delete(listener as (data: unknown) => void); };
    },
  };
}
