import { afterEach, describe, expect, it, vi } from 'vitest';

import lockFixture from '../../../plugins/sprite-sheet/package/manifest.lock.json';
import type { PluginPackageLock } from '@/schema/plugins';
import { buildSrcdoc, loadPluginSrcdoc, SANDBOX_ATTRIBUTE, SANDBOX_CSP, sha256Hex } from './sandbox';

const HTML = '<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="UTF-8"><title>x</title></head>\n<body></body>\n</html>\n';
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
    expect(SANDBOX_CSP).toContain("default-src 'none'");
    expect(SANDBOX_CSP).toContain("connect-src 'none'");
    expect(SANDBOX_CSP).toContain("form-action 'none'");
    expect(SANDBOX_CSP).toContain("base-uri 'none'");
    expect(SANDBOX_CSP).toContain("frame-src 'none'");
    expect(SANDBOX_CSP).not.toMatch(/https?:|\*|'self'|'unsafe-eval'/);
  });

  it('策略插在 <head> 的最前面，排在包自带的任何 meta 之前', () => {
    const loose = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"><title>x</title></head><body></body></html>';
    const built = buildSrcdoc(loose);
    expect(built.indexOf(SANDBOX_CSP)).toBeGreaterThan(0);
    expect(built.indexOf(SANDBOX_CSP)).toBeLessThan(built.indexOf('default-src *'));
    expect(built.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')).toBe(true);
  });

  it('没有 <head> 的界面拒绝装载', () => {
    expect(() => buildSrcdoc('<script>alert(1)</script>')).toThrow();
  });
});

describe('界面包核对', () => {
  it('摘要一致才装载，结果带上策略', async () => {
    serve(HTML);
    const srcdoc = await loadPluginSrcdoc(await plugin(HTML, 'sha256:ok'));
    expect(srcdoc).toContain(SANDBOX_CSP);
    expect(srcdoc).toContain('<title>x</title>');
  });

  it('内容被改过（摘要不一致）拒绝装载', async () => {
    serve(HTML.replace('<body>', '<body><script>steal()</script>'));
    await expect(loadPluginSrcdoc(await plugin(HTML, 'sha256:tampered'))).rejects.toThrow('摘要不一致');
  });

  it('字节数不一致拒绝装载', async () => {
    serve(HTML);
    await expect(loadPluginSrcdoc(await plugin(HTML, 'sha256:size', { bytes: 3 }))).rejects.toThrow('摘要不一致');
  });

  it('清单里没有登记界面文件时不发请求', async () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const broken = { ...(await plugin(HTML, 'sha256:nofile')), files: [] };
    await expect(loadPluginSrcdoc(broken)).rejects.toThrow('没有界面');
    expect(network).not.toHaveBeenCalled();
  });

  it('失败的结果不缓存，修好后可以重试', async () => {
    const target = await plugin(HTML, 'sha256:retry');
    serve('garbage');
    await expect(loadPluginSrcdoc(target)).rejects.toThrow();
    serve(HTML);
    await expect(loadPluginSrcdoc(target)).resolves.toContain(SANDBOX_CSP);
  });
});
