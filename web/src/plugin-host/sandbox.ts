/**
 * 插件界面的沙箱装载：取包、核对摘要、注入内容安全策略，以及给沙箱的主题与字体数据。
 *
 * 沙箱页面是 opaque origin（iframe 只有 `allow-scripts`）：读不到宿主的 DOM、cookie、存储，
 * 发出的请求不带宿主会话。下面的策略再把它的网络访问全部关掉。
 */
import { request } from '@/api/http';
import type { PluginPackageLock } from '@/schema/plugins';
import type { PluginFontSlice, PluginTheme } from '../../../plugins/sdk/protocol';

/** iframe 的 sandbox 属性。只开脚本：不给同源、表单、弹窗、顶层跳转、下载。 */
export const SANDBOX_ATTRIBUTE = 'allow-scripts';

/**
 * 沙箱页面的内容安全策略。没有任何网络来源：脚本与样式只能是包内联的，
 * 图片、媒体、Worker 只能来自页面自己创建的 blob / data。
 */
export const SANDBOX_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  'img-src blob: data:',
  'media-src blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "font-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** 把策略放在 <head> 的第一个位置。包自带的 meta 只能在此基础上收紧，放宽不了。 */
export function buildSrcdoc(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (!head) throw new Error('插件界面缺少 <head>，无法装载');
  const at = head.index + head[0].length;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${SANDBOX_CSP}">`;
  return html.slice(0, at) + meta + html.slice(at);
}

const srcdocByDigest = new Map<string, Promise<string>>();

/** 取界面包并按清单核对字节数与 SHA-256；不一致就拒绝，不把内容交给 iframe。 */
export function loadPluginSrcdoc(plugin: PluginPackageLock): Promise<string> {
  const cached = srcdocByDigest.get(plugin.digest);
  if (cached) return cached;
  const loading = (async () => {
    const entry = plugin.ui?.entry;
    const listed = plugin.files.find(file => file.path === entry);
    if (!entry || !listed) throw new Error('插件没有界面');
    const response = await request(`/api/plugins/${encodeURIComponent(plugin.id)}/package/${entry}`, '加载插件');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== listed.bytes || await sha256Hex(bytes) !== listed.sha256) {
      throw new Error('插件界面与清单里的摘要不一致，已拒绝加载');
    }
    return buildSrcdoc(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  })();
  srcdocByDigest.set(plugin.digest, loading);
  loading.catch(() => srcdocByDigest.delete(plugin.digest));
  return loading;
}

/** 传给沙箱的设计 token。只有这张表里的名字会出去。 */
const THEME_TOKENS = [
  'background', 'panel', 'card', 'muted', 'popover', 'secondary', 'accent',
  'foreground', 'muted-foreground', 'subtle-foreground', 'border', 'input', 'glass', 'scrim',
  'primary', 'primary-foreground', 'ring', 'destructive', 'brand-2', 'brand-3', 'brand-4',
  'status-pending', 'status-running', 'status-done', 'status-failed', 'media-edge',
  'font-sans', 'font-mono', 'font-display',
] as const;

export function readTheme(): PluginTheme {
  const root = document.documentElement;
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = computed.getPropertyValue(`--${name}`).trim();
    if (value) tokens[name] = value;
  }
  return { mode: root.classList.contains('light') ? 'light' : 'dark', tokens };
}

/** 主题或主色变化时回调（两者都落在 <html> 的 class / style 上）。 */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  return () => observer.disconnect();
}

/** 只把界面正文与等宽两族字体交给插件；衬线标题字体插件界面用不到。 */
const SHARED_FONT_FAMILIES = /^(Inter|Noto Sans SC|JetBrains Mono)\b/;
const FONT_URL = /url\((['"]?)([^'")]+\.woff2)\1\)/;

interface FontSource extends PluginFontSlice { url: string }
let fontSources: FontSource[] | null = null;

function collectFontSources(): FontSource[] {
  const sources: FontSource[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const family = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();
      const url = FONT_URL.exec(rule.style.getPropertyValue('src'))?.[2];
      if (!url || !SHARED_FONT_FAMILIES.test(family)) continue;
      sources.push({
        id: `f${sources.length}`, family, url: new URL(url, sheet.href ?? document.baseURI).href,
        weight: rule.style.getPropertyValue('font-weight') || '400',
        style: rule.style.getPropertyValue('font-style') || 'normal',
        unicodeRange: rule.style.getPropertyValue('unicode-range'),
      });
    }
  }
  return sources;
}

export function fontSlices(): PluginFontSlice[] {
  fontSources ??= collectFontSources();
  return fontSources.map(({ id, family, weight, style, unicodeRange }) => ({ id, family, weight, style, unicodeRange }));
}

/** 按分片 id 取字体字节。id 只认握手时给出的那张表，取不到的直接略过。 */
export async function loadFontBytes(ids: readonly string[]): Promise<Array<{ id: string; bytes: ArrayBuffer }>> {
  fontSources ??= collectFontSources();
  const wanted = fontSources.filter(source => ids.includes(source.id));
  const loaded = await Promise.all(wanted.map(async source => {
    try {
      const response = await fetch(source.url, { credentials: 'omit' });
      return response.ok ? { id: source.id, bytes: await response.arrayBuffer() } : null;
    } catch {
      return null;
    }
  }));
  return loaded.filter((item): item is { id: string; bytes: ArrayBuffer } => item !== null);
}
