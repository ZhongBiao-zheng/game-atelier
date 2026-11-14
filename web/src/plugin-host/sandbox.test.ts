import { afterEach, describe, expect, it, vi } from 'vitest';

import lockFixture from '../../../plugins/sprite-sheet/package/manifest.lock.json';
import type { PluginPackageLock } from '@/schema/plugins';
import { buildSrcdoc, loadPluginHtml, NONCE_GLOBAL, SANDBOX_ATTRIBUTE, SANDBOX_CSP, sha256Hex } from './sandbox';

const HTML = '<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>x</title></head>\n<body></body>\n</html>\n';
const NONCE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PREFIX = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}"><script>`;
const bytesOf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;

async function plugin(html: string, digest: string, patch: Partial<{ sha256: string; bytes: number }> = {}): Promise<PluginPackageLock> {
  const data = bytesOf(html);
  return { ...(lockFixture as unknown as PluginPackageLock), digest,
    files: [{ path: 'ui/index.html', sha256: await sha256Hex(data), bytes: data.byteLength, ...patch }] };
}
const serve = (body: string) => vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
afterEach(() => { vi.unstubAllGlobals(); });

describe('沙箱策略', () => {
  it('iframe 只开脚本：没有同源、表单、弹窗、顶层跳转、下载', () => {
    expect(SANDBOX_ATTRIBUTE).toBe('allow-scripts');
  });

  it('策略里没有任何网络来源', () => {
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "webrtc 'block'"]) {
      expect(SANDBOX_CSP).toContain(directive);
    }
    expect(SANDBOX_CSP).not.toMatch(/https?:|\*|'self'|'unsafe-eval'/);
  });

  // B2 安全验收 S1：这些写法都曾让「在包内容里找 <head> 再插策略」落到不生效的位置。
  it.each([
    ['注释里的 head', '<!-- <head> --><html><head></head><body><script>steal()</script></body></html>'],
    ['长得像 head 的标签', '<html><body><header>x</header><script>steal()</script></body></html>'],
    ['属性值里的 head', '<html data-x="<head>"><body><script>steal()</script></body></html>'],
    ['抢在 head 之前的脚本', '<script>steal()</script><html><head></head><body></body></html>'],
    ['自带一条宽松策略', '<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>'],
    ['根本没有 head', '<script>steal()</script>'],
    ['空内容', ''],
  ])('策略固定在最前面，与包内容无关：%s', (_name, html) => {
    const built = buildSrcdoc(html, NONCE);
    expect(built.startsWith(PREFIX)).toBe(true);
    expect(built.endsWith(html)).toBe(true);
    // 包内容整体排在前缀之后：策略与前缀脚本之前没有任何来自包的字符。
    const boundary = built.length - html.length;
    expect(built.indexOf(SANDBOX_CSP)).toBeLessThan(boundary);
    expect(built.slice(0, boundary)).not.toContain('steal');
    expect(built.slice(0, boundary).endsWith('</script>')).toBe(true);
  });

  it('前缀脚本放下本次实例的 nonce 并禁用 WebRTC 构造器', () => {
    const built = buildSrcdoc(HTML, NONCE);
    const script = built.slice(PREFIX.length, built.indexOf('</script>'));
    const fake: Record<string, unknown> = { RTCPeerConnection: class {}, webkitRTCPeerConnection: class {} };
    new Function('window', script)(fake);
    expect(fake[NONCE_GLOBAL]).toBe(NONCE);
    expect(fake.RTCPeerConnection).toBeUndefined();
    expect(fake.webkitRTCPeerConnection).toBeUndefined();
    expect(() => { fake[NONCE_GLOBAL] = 'x'; }).toThrow();
    expect(Object.keys(fake)).not.toContain(NONCE_GLOBAL);
  });

  it.each(['', 'short', 'a"b</script><script>alert(1)//', '<img>', 'x'.repeat(80)])(
    'nonce 只接受固定字符集，拼不出脚本：%j', nonce => {
      expect(() => buildSrcdoc(HTML, nonce)).toThrow();
    });

  it('每个实例的页面不同（nonce 不同）', () => {
    expect(buildSrcdoc(HTML, NONCE)).not.toBe(buildSrcdoc(HTML, '11111111-2222-3333-4444-555555555555'));
  });
});

describe('界面包核对', () => {
  it('摘要一致才交出内容', async () => {
    serve(HTML);
    expect(await loadPluginHtml(await plugin(HTML, 'sha256:ok'))).toBe(HTML);
  });

  it('内容被改过（摘要不一致）拒绝', async () => {
    serve(HTML.replace('<body>', '<body><script>steal()</script>'));
    await expect(loadPluginHtml(await plugin(HTML, 'sha256:tampered'))).rejects.toThrow('摘要不一致');
  });

  it('字节数不一致拒绝', async () => {
    serve(HTML);
    await expect(loadPluginHtml(await plugin(HTML, 'sha256:size', { bytes: 3 }))).rejects.toThrow('摘要不一致');
  });

  it('清单里没有登记界面文件时不发请求', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const broken = { ...(await plugin(HTML, 'sha256:nofile')), files: [] };
    await expect(loadPluginHtml(broken)).rejects.toThrow('没有界面');
    expect(network).not.toHaveBeenCalled();
  });

  it('失败的结果不缓存，修好后可以重试', async () => {
    const target = await plugin(HTML, 'sha256:retry');
    serve('garbage');
    await expect(loadPluginHtml(target)).rejects.toThrow();
    serve(HTML);
    await expect(loadPluginHtml(target)).resolves.toBe(HTML);
  });
});
