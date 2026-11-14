import { describe, expect, it } from 'vitest';

import { connect, HANDSHAKE_TYPE, PLUGIN_PROTOCOL, type PluginHandshake } from '../../../plugins/sdk';

const hello = (patch: Partial<PluginHandshake> = {}): PluginHandshake => ({
  type: HANDSHAKE_TYPE, protocol: PLUGIN_PROTOCOL, plugin_id: 'demo', digest: 'sha256:x',
  surface: 'node', theme: { mode: 'dark', tokens: { foreground: '#fff' } }, fonts: [], ...patch,
});

function post(data: unknown, source: Window, withPort = true) {
  const channel = new MessageChannel();
  window.dispatchEvent(new MessageEvent('message', { data, source, ports: withPort ? [channel.port2] : [] }));
  return channel;
}

const settled = async (promise: Promise<unknown>) => Promise.race([
  promise.then(() => 'resolved', () => 'rejected'),
  new Promise(resolve => setTimeout(() => resolve('pending'), 30)),
]);

describe('插件 SDK 握手', () => {
  it('只接受父窗口发来的握手：别的窗口抢先发来的伪造握手被忽略', async () => {
    const sibling = document.createElement('iframe');
    document.body.appendChild(sibling);
    const pending = connect(500);
    post(hello({ plugin_id: 'attacker' }), sibling.contentWindow!);
    expect(await settled(pending)).toBe('pending');
    post(hello(), window.parent);
    const client = await pending;
    expect(client.pluginId).toBe('demo');
    sibling.remove();
  });

  it('握手后在 port 上先回报宿主放在页面里的 nonce', async () => {
    Object.defineProperty(window, '__atelierPluginNonce', { value: 'nonce-from-host', configurable: true });
    const pending = connect(500);
    const channel = post(hello(), window.parent);
    const first = new Promise(resolve => { channel.port1.onmessage = event => resolve(event.data); });
    await pending;
    expect(await first).toEqual({ type: 'atelier-plugin:ready', nonce: 'nonce-from-host' });
    delete (window as unknown as Record<string, unknown>).__atelierPluginNonce;
  });

  it('没有 port 或类型不对的消息被忽略，握手后套用主题', async () => {
    const pending = connect(500);
    post(hello(), window.parent, false);
    post({ type: 'something-else' }, window.parent);
    expect(await settled(pending)).toBe('pending');
    post(hello({ theme: { mode: 'light', tokens: { foreground: '#111' } } }), window.parent);
    await pending;
    expect(document.documentElement.classList.contains('light')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--foreground')).toBe('#111');
    document.documentElement.classList.remove('light');
  });

  it('面板里输入法组合期间的 Esc 不关面板，组合结束后的 Esc 才关', async () => {
    const pending = connect(500);
    const channel = post(hello({ surface: 'panel' }), window.parent);
    const methods: string[] = [];
    channel.port1.onmessage = event => { if (event.data?.method) methods.push(event.data.method); };
    await pending;
    const escape = (init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', ...init }));
    window.dispatchEvent(new CompositionEvent('compositionstart'));
    escape();                         // 有的路径送来的 Esc 不带 isComposing
    escape({ isComposing: true });
    window.dispatchEvent(new CompositionEvent('compositionend'));
    escape();                         // 同一轮里随后到的 Esc 仍算在组合里
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(methods.filter(method => method === 'ui.close')).toHaveLength(0);
    escape();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(methods.filter(method => method === 'ui.close')).toHaveLength(1);
  });

  it('协议版本不对时拒绝', async () => {
    const pending = connect(500);
    post({ ...hello(), protocol: 'atelier-plugin/99' }, window.parent);
    expect(await settled(pending)).toBe('rejected');
  });

  it('宿主一直不握手则超时', async () => {
    expect(await settled(connect(10))).toBe('rejected');
  });
});
