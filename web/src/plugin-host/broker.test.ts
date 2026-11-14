import { describe, expect, it, vi } from 'vitest';

import { createBroker, isReadyProof, normalizePayload, PluginServerError, type BrokerInput, type BrokerOptions } from './broker';

const ALL = ['node.read_self', 'node.write_self', 'resource.read_inputs', 'server.call'];
const NODE = { node_type: 'sheet', title: '精灵表', size: { width: 320, height: 240 }, payload_schema_version: 1, payload: { frames: [] } };
const IMAGE: BrokerInput = { versionId: 'version-secret-1', kind: 'image', title: '角色', width: 64, height: 64 };
const TEXT: BrokerInput = { versionId: 'version-text-1', kind: 'text', title: '备注', width: null, height: null };

function setup(overrides: Partial<BrokerOptions> = {}, capabilities: string[] = ALL) {
  const options: BrokerOptions = {
    capabilities: new Set(capabilities),
    readNode: vi.fn(() => NODE),
    writePayload: vi.fn(),
    listInputs: vi.fn(() => [IMAGE, TEXT]),
    readInput: vi.fn(async (_versionId, as) => as === 'text' ? '文字' : new ArrayBuffer(8)),
    loadFonts: vi.fn(async (ids: readonly string[]) => ids.map(id => ({ id, bytes: new ArrayBuffer(4) }))),
    callServer: vi.fn(async (path: string, params: Record<string, unknown>, versionIds: string[]) => ({ path, params, versionIds })),
    ...overrides,
  };
  return { options, broker: createBroker(options) };
}

async function call(broker: ReturnType<typeof createBroker>, method: unknown, params?: unknown, id = 1) {
  const reply = await broker.handle({ id, method, params });
  if (!reply) throw new Error('no reply');
  return reply;
}
const errorCode = (reply: Awaited<ReturnType<typeof call>>) => (reply.response.ok ? null : reply.response.error.code);

describe('插件 broker：消息形状', () => {
  it.each([
    null, undefined, 'node.readSelf', 42, [], { method: 'node.readSelf' }, { id: '1', method: 'node.readSelf' },
    { id: 1.5, method: 'node.readSelf' }, { id: Number.NaN, method: 'node.readSelf' }, new Map(),
  ])('读不出 id 的消息直接丢弃：%j', async raw => {
    const { broker, options } = setup();
    expect(await broker.handle(raw)).toBeNull();
    expect(options.readNode).not.toHaveBeenCalled();
  });

  it.each(['nope', 'node.deleteAll', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '', 7, null, {}])(
    '表外的方法一律拒绝：%j', async method => {
      const { broker } = setup();
      expect(errorCode(await call(broker, method))).toBe('UNKNOWN_METHOD');
    });

  it('关闭后不再回应', async () => {
    const { broker } = setup();
    broker.close();
    expect(await broker.handle({ id: 1, method: 'node.readSelf' })).toBeNull();
  });

  it('宿主内部报错不把细节透给插件', async () => {
    const { broker } = setup({ readInput: async () => { throw new Error('/Users/someone/canvases/p1/uploads/secret.png'); } });
    const [image] = (await call(broker, 'inputs.list')).response.ok
      ? ((await call(broker, 'inputs.list', undefined, 2)).response as { result: Array<{ handle: string }> }).result : [];
    const reply = await call(broker, 'inputs.read', { handle: image.handle, as: 'bytes' }, 3);
    expect(reply.response).toEqual({ id: 3, ok: false, error: { code: 'INTERNAL', message: '宿主处理失败' } });
  });

  it('参数过大被拒', async () => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'fonts.request', { ids: ['x'.repeat(70 * 1024)] }))).toBe('PAYLOAD_TOO_LARGE');
    expect(options.loadFonts).not.toHaveBeenCalled();
  });
});

describe('插件 broker：能力校验', () => {
  it.each([
    ['node.readSelf', undefined, 'node.read_self'],
    ['node.writeSelf', { payload: {} }, 'node.write_self'],
    ['inputs.list', undefined, 'resource.read_inputs'],
    ['inputs.read', { handle: 'h', as: 'bytes' }, 'resource.read_inputs'],
    ['server.call', { path: '/detect' }, 'server.call'],
  ])('%s 没有对应能力时被拒', async (method, params, capability) => {
    const { broker, options } = setup({}, ALL.filter(item => item !== capability));
    expect(errorCode(await call(broker, method, params))).toBe('CAPABILITY_DENIED');
    expect(options.readNode).not.toHaveBeenCalled();
    expect(options.writePayload).not.toHaveBeenCalled();
    expect(options.listInputs).not.toHaveBeenCalled();
    expect(options.readInput).not.toHaveBeenCalled();
    expect(options.callServer).not.toHaveBeenCalled();
  });

  it('没有任何批准时只有字体可用', async () => {
    const { broker } = setup({}, []);
    expect((await call(broker, 'fonts.request', { ids: ['f0'] })).response.ok).toBe(true);
    expect(errorCode(await call(broker, 'node.readSelf', undefined, 2))).toBe('CAPABILITY_DENIED');
  });

  it('能力集合在创建后被替换不影响已有判定以外的任何东西', async () => {
    const capabilities = new Set(['node.read_self']);
    const { broker } = setup({ capabilities });
    expect(errorCode(await call(broker, 'node.writeSelf', { payload: {} }))).toBe('CAPABILITY_DENIED');
  });
});

describe('插件 broker：节点读写', () => {
  it('读自己的节点', async () => {
    const { broker } = setup();
    expect((await call(broker, 'node.readSelf')).response).toEqual({ id: 1, ok: true, result: NODE });
  });

  it('节点不在了就不可读也不可写', async () => {
    const { broker, options } = setup({ readNode: () => null });
    expect(errorCode(await call(broker, 'node.readSelf'))).toBe('UNAVAILABLE');
    expect(errorCode(await call(broker, 'node.writeSelf', { payload: {} }, 2))).toBe('UNAVAILABLE');
    expect(options.writePayload).not.toHaveBeenCalled();
  });

  it('写入的是规范化后的纯 JSON 副本', async () => {
    const { broker, options } = setup();
    const payload = { frames: [{ x: 0, y: 0 }], name: '跑' };
    expect((await call(broker, 'node.writeSelf', { payload })).response.ok).toBe(true);
    const written = vi.mocked(options.writePayload).mock.calls[0][0];
    expect(written).toEqual(payload);
    expect(written).not.toBe(payload);
  });

  it('协议里没有节点 id：多带的字段不会让它写到别的节点', async () => {
    const { broker, options } = setup();
    await call(broker, 'node.writeSelf', { payload: { a: 1 }, node_id: 'other-node', project_id: 'other-project', plugin_id: 'other' });
    expect(options.writePayload).toHaveBeenCalledTimes(1);
    expect(options.writePayload).toHaveBeenCalledWith({ a: 1 });
  });

  const deep = (levels: number) => { let value: unknown = 1; for (let i = 0; i < levels; i++) value = { v: value }; return value; };
  it.each([
    ['超过 256 KiB', { blob: 'x'.repeat(256 * 1024) }, 'PAYLOAD_TOO_LARGE'],
    ['多字节字符按字节算', { blob: '汉'.repeat(90 * 1024) }, 'PAYLOAD_TOO_LARGE'],
    ['层级过深', deep(40), 'PAYLOAD_TOO_LARGE'],
    ['条目过多', Array.from({ length: 10_001 }, () => 0), 'PAYLOAD_TOO_LARGE'],
    ['函数', { run: () => 1 }, 'BAD_REQUEST'],
    ['Map', new Map([['a', 1]]), 'BAD_REQUEST'],
    ['Date', new Date(0), 'BAD_REQUEST'],
    ['二进制', new Uint8Array(4), 'BAD_REQUEST'],
    ['NaN', { n: Number.NaN }, 'BAD_REQUEST'],
    ['undefined', { n: undefined }, 'BAD_REQUEST'],
    ['__proto__ 键', JSON.parse('{"__proto__": {"polluted": true}}'), 'BAD_REQUEST'],
    ['constructor 键', { constructor: { prototype: {} } }, 'BAD_REQUEST'],
  ])('拒绝写入：%s', async (_name, payload, code) => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'node.writeSelf', { payload }))).toBe(code);
    expect(options.writePayload).not.toHaveBeenCalled();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  // B2 安全验收 M1：孤立代理字符编不成 UTF-8，写进节点会让整份画布保存失败。
  it.each([
    ['值里的高位代理', { name: '\ud800' }], ['值里的低位代理', { name: 'a\udc00b' }],
    ['键里的代理', { ['k\ud83d']: 1 }], ['数组里的', ['ok', '\udfff']], ['颠倒的一对', { s: '\udc00\ud800' }],
  ])('拒绝无效字符：%s', async (_name, payload) => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'node.writeSelf', { payload }))).toBe('BAD_REQUEST');
    expect(options.writePayload).not.toHaveBeenCalled();
  });

  it('成对的代理字符（表情、生僻字）照常写入', async () => {
    const { broker, options } = setup();
    expect((await call(broker, 'node.writeSelf', { payload: { name: '🙂𠮷' } })).response.ok).toBe(true);
    expect(options.writePayload).toHaveBeenCalledWith({ name: '🙂𠮷' });
  });

  // M3：超限时立刻停，不把剩下的数据走完。
  it('超大数据在遍历途中就被拒，后面的内容不再被读取', () => {
    let touched = 0;
    const tail = new Proxy({}, { ownKeys() { touched += 1; return []; }, getPrototypeOf: () => Object.prototype });
    expect(() => normalizePayload(['x'.repeat(300 * 1024), tail])).toThrow();
    expect(touched).toBe(0);
  });

  it('大小按 UTF-8 字节算，不按字符数', () => {
    expect(() => normalizePayload({ s: '汉'.repeat(80 * 1024) })).not.toThrow();   // 240 KiB
    expect(() => normalizePayload({ s: '汉'.repeat(90 * 1024) })).toThrow();       // 270 KiB，字符数只有 90K
  });

  it('循环引用被拒而不是卡死', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => normalizePayload(loop)).toThrow();
  });

  it('缺少 payload 字段', async () => {
    const { broker } = setup();
    expect(errorCode(await call(broker, 'node.writeSelf', {}))).toBe('BAD_REQUEST');
    expect(errorCode(await call(broker, 'node.writeSelf', undefined, 2))).toBe('BAD_REQUEST');
  });
});

describe('插件 broker：素材句柄', () => {
  const list = async (broker: ReturnType<typeof createBroker>, id = 1) => (
    (await call(broker, 'inputs.list', undefined, id)).response as { result: Array<{ handle: string; kind: string }> }
  ).result;

  it('列表给的是句柄，不含版本 id 与路径', async () => {
    const { broker } = setup();
    const inputs = await list(broker);
    expect(inputs).toHaveLength(2);
    expect(JSON.stringify(inputs)).not.toContain('version-');
    expect(inputs[0].handle).not.toBe(inputs[1].handle);
    expect((await list(broker, 2))[0].handle).toBe(inputs[0].handle);
  });

  it('用句柄读取，位图与字节走转移', async () => {
    const { broker, options } = setup();
    const [image, text] = await list(broker);
    const bytes = await call(broker, 'inputs.read', { handle: image.handle, as: 'bytes' }, 2);
    expect(bytes.response.ok).toBe(true);
    expect(bytes.transfer).toHaveLength(1);
    expect(options.readInput).toHaveBeenCalledWith('version-secret-1', 'bytes');
    const words = await call(broker, 'inputs.read', { handle: text.handle, as: 'text' }, 3);
    expect(words.response).toEqual({ id: 3, ok: true, result: '文字' });
    expect(words.transfer).toEqual([]);
  });

  it.each(['version-secret-1', 'version-other-project', '../../../etc/passwd', '', 'f0'])(
    '直接拿版本 id 或路径当句柄读不到东西：%s', async handle => {
      const { broker, options } = setup();
      await list(broker);
      expect(errorCode(await call(broker, 'inputs.read', { handle, as: 'bytes' }, 2))).toBe('INVALID_HANDLE');
      expect(options.readInput).not.toHaveBeenCalled();
    });

  it('别的界面实例发出的句柄在这里无效', async () => {
    const first = setup();
    const second = setup();
    const [image] = await list(first.broker);
    expect(errorCode(await call(second.broker, 'inputs.read', { handle: image.handle, as: 'bytes' }))).toBe('INVALID_HANDLE');
    expect(second.options.readInput).not.toHaveBeenCalled();
  });

  it('素材断开连接后，旧句柄立即失效', async () => {
    let connected: BrokerInput[] = [IMAGE];
    const { broker, options } = setup({ listInputs: () => connected });
    const [image] = await list(broker);
    connected = [];
    expect(errorCode(await call(broker, 'inputs.read', { handle: image.handle, as: 'bytes' }, 2))).toBe('INVALID_HANDLE');
    expect(options.readInput).not.toHaveBeenCalled();
  });

  it.each([
    [{ as: 'bytes' }], [{ handle: 1, as: 'bytes' }], [{ handle: 'h', as: 'path' }], [{ handle: 'h' }], ['h'], [undefined],
  ])('参数形状不对：%j', async params => {
    const { broker } = setup();
    expect(errorCode(await call(broker, 'inputs.read', params))).toBe('BAD_REQUEST');
  });

  it('读取方式要与素材类型一致', async () => {
    const { broker, options } = setup();
    const [image, text] = await list(broker);
    expect(errorCode(await call(broker, 'inputs.read', { handle: image.handle, as: 'text' }, 2))).toBe('BAD_REQUEST');
    expect(errorCode(await call(broker, 'inputs.read', { handle: text.handle, as: 'bitmap' }, 3))).toBe('BAD_REQUEST');
    expect(options.readInput).not.toHaveBeenCalled();
  });
});

describe('插件 broker：频率与字体', () => {
  it('一秒内超过 60 次调用被限流，窗口过后恢复', async () => {
    let clock = 0;
    const { broker } = setup({ now: () => clock });
    for (let id = 1; id <= 60; id++) expect((await call(broker, 'node.readSelf', undefined, id)).response.ok).toBe(true);
    expect(errorCode(await call(broker, 'node.readSelf', undefined, 61))).toBe('RATE_LIMITED');
    clock = 1001;
    expect((await call(broker, 'node.readSelf', undefined, 62)).response.ok).toBe(true);
  });

  it('同时在途的调用有上限', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { broker } = setup({ loadFonts: async () => { await gate; return []; } });
    const pending = Array.from({ length: 8 }, (_, index) => broker.handle({ id: index + 1, method: 'fonts.request', params: { ids: [] } }));
    expect(errorCode(await call(broker, 'fonts.request', { ids: [] }, 9))).toBe('RATE_LIMITED');
    release();
    expect((await Promise.all(pending)).every(reply => reply?.response.ok)).toBe(true);
  });

  it('字体一次最多要 32 个分片，id 必须是字符串', async () => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'fonts.request', { ids: Array.from({ length: 33 }, (_, i) => `f${i}`) }))).toBe('BAD_REQUEST');
    expect(errorCode(await call(broker, 'fonts.request', { ids: [1, 2] }, 2))).toBe('BAD_REQUEST');
    expect(errorCode(await call(broker, 'fonts.request', { ids: 'f0' }, 3))).toBe('BAD_REQUEST');
    expect(options.loadFonts).not.toHaveBeenCalled();
    const ok = await call(broker, 'fonts.request', { ids: ['f0', 'f1'] }, 4);
    expect(ok.transfer).toHaveLength(2);
  });
});

describe('插件 broker：调用服务端路由', () => {
  const handles = async (broker: ReturnType<typeof createBroker>) => (
    (await call(broker, 'inputs.list', undefined, 90)).response as { result: Array<{ handle: string }> }
  ).result.map(item => item.handle);

  it('把句柄换成版本 id 后转给宿主，界面拿不到版本 id', async () => {
    const { broker, options } = setup();
    const [image] = await handles(broker);
    const reply = await call(broker, 'server.call', { path: '/detect', params: { columns: 4 }, inputs: [image] });
    expect(reply.response.ok).toBe(true);
    expect(options.callServer).toHaveBeenCalledWith('/detect', { columns: 4 }, ['version-secret-1']);
  });

  it.each([
    '../../keys', '/../keys', '/a/../../b', 'detect', '/Detect', '/detect?x=1', '/detect#x', '//evil.example/x',
    'https://evil.example/x', '/a b', '/' + 'a'.repeat(90), '', '/',
  ])('路径只能是清单格式的相对路径：%s', async path => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'server.call', { path }))).toBe('BAD_REQUEST');
    expect(options.callServer).not.toHaveBeenCalled();
  });

  it.each(['version-secret-1', 'version-other-project', '../../.config/keys.json'])(
    '素材只能用本实例发出的句柄：%s', async handle => {
      const { broker, options } = setup();
      await handles(broker);
      expect(errorCode(await call(broker, 'server.call', { path: '/detect', inputs: [handle] }))).toBe('INVALID_HANDLE');
      expect(options.callServer).not.toHaveBeenCalled();
    });

  it('素材断开后句柄失效', async () => {
    let connected: BrokerInput[] = [IMAGE];
    const { broker, options } = setup({ listInputs: () => connected });
    const [image] = await handles(broker);
    connected = [];
    expect(errorCode(await call(broker, 'server.call', { path: '/detect', inputs: [image] }))).toBe('INVALID_HANDLE');
    expect(options.callServer).not.toHaveBeenCalled();
  });

  it.each([
    [{ path: '/detect', params: [] }], [{ path: '/detect', params: 'x' }], [{ path: '/detect', inputs: 'h' }],
    [{ path: '/detect', inputs: [1] }], [{ path: 7 }], [undefined],
    [{ path: '/detect', inputs: Array.from({ length: 65 }, () => 'h') }],
  ])('参数形状不对：%j', async params => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'server.call', params))).toBe('BAD_REQUEST');
    expect(options.callServer).not.toHaveBeenCalled();
  });

  it('参数同样只收纯 JSON 且有大小上限', async () => {
    const { broker, options } = setup();
    expect(errorCode(await call(broker, 'server.call', { path: '/detect', params: { blob: 'x'.repeat(300 * 1024) } }))).toBe('PAYLOAD_TOO_LARGE');
    expect(errorCode(await call(broker, 'server.call', { path: '/detect', params: JSON.parse('{"__proto__":{"a":1}}') }, 2))).toBe('BAD_REQUEST');
    expect(options.callServer).not.toHaveBeenCalled();
  });

  it('服务端给用户看的原因转给界面，其他报错不透出细节', async () => {
    const refused = setup({ callServer: async () => { throw new PluginServerError('列数必须大于 0'); } });
    expect((await call(refused.broker, 'server.call', { path: '/repack' })).response)
      .toEqual({ id: 1, ok: false, error: { code: 'SERVER_ERROR', message: '列数必须大于 0' } });
    const crashed = setup({ callServer: async () => { throw new Error('GET /api/plugins/x failed at /Users/a/b'); } });
    expect((await call(crashed.broker, 'server.call', { path: '/repack' })).response)
      .toEqual({ id: 1, ok: false, error: { code: 'INTERNAL', message: '宿主处理失败' } });
  });
});

describe('握手证明', () => {
  const NONCE = '0f8fad5b-d9cb-469f-a165-70867728950e';
  it('只有带回正确 nonce 的 ready 消息算数', () => {
    expect(isReadyProof({ type: 'atelier-plugin:ready', nonce: NONCE }, NONCE)).toBe(true);
  });
  it.each([
    null, undefined, 'atelier-plugin:ready', { type: 'atelier-plugin:ready' }, { type: 'atelier-plugin:ready', nonce: '' },
    { type: 'atelier-plugin:ready', nonce: 'guess' }, { type: 'atelier-plugin:ready', nonce: [NONCE] },
    { type: 'other', nonce: NONCE }, { id: 1, method: 'node.readSelf' }, { nonce: NONCE },
  ])('其余消息都不算：%j', message => {
    expect(isReadyProof(message, NONCE)).toBe(false);
    expect(isReadyProof(message, '')).toBe(false);
  });
});
