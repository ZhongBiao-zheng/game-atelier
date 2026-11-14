// 把 plugins/<id>/ui 构建成单文件界面包，并生成 package/manifest.lock.json（ADR-0037）。
// 包是运行时唯一读取的东西：宿主按 lock 里的 SHA-256 核对后才把界面放进沙箱。
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginsDir = resolve(webDir, '..', 'plugins');
const hostAnchor = join(webDir, 'src', 'main.tsx');

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** 键排序、无空白的 JSON；与 plugin_manifest.package_digest 的 Python 实现逐字节一致。 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 插件源码在 web/ 之外，裸模块（react 等）改从宿主的 node_modules 解析。 */
function resolveFromHost() {
  return {
    name: 'atelier-plugin-resolve-from-host',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(pluginsDir + sep)) return null;
      if (/^[./\0]/.test(source) || source.startsWith('@/')) return null;
      return this.resolve(source, hostAnchor, { ...options, skipSelf: true });
    },
  };
}

/** 入口固定为 ui/src/main.tsx；页面外壳由这里生成，插件不提供自己的 HTML。 */
async function buildUi(uiDir, title) {
  const { output } = await build({
    configFile: false,
    // 根设在 web/：React 插件把 react 固定为从根目录解析，根在 web/ 之外会找不到依赖。
    root: webDir,
    logLevel: 'warn',
    plugins: [react(), resolveFromHost()],
    resolve: { alias: { '@': join(webDir, 'src') } },
    build: {
      write: false,
      modulePreload: false,
      cssCodeSplit: false,
      assetsInlineLimit: Number.MAX_SAFE_INTEGER,
      rollupOptions: { input: join(uiDir, 'src', 'main.tsx'), output: { inlineDynamicImports: true } },
    },
  });
  const scripts = output.filter((item) => item.type === 'chunk');
  const styles = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'));
  const others = output.filter((item) => item.type === 'asset' && !item.fileName.endsWith('.css'));
  if (scripts.length !== 1) throw new Error(`${uiDir}: 期望 1 个脚本，实际 ${scripts.length} 个`);
  if (others.length > 0) {
    throw new Error(`${uiDir}: 资源 ${others.map((item) => item.fileName).join(', ')} 没有内联，界面包不允许外部文件`);
  }
  const css = styles.map((item) => String(item.source).replace(/<\/style/gi, '<\\/style')).join('\n');
  const js = scripts[0].code.replace(/<\/script/gi, '<\\/script');
  const escaped = title.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
  const page = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    `<head><meta charset="UTF-8"><title>${escaped}</title>${css ? `<style>${css}</style>` : ''}</head>`,
    `<body><div id="root"></div><script type="module">${js}</script></body>`,
    '</html>',
    '',
  ].join('\n');
  // 与 normalize-dist 相同：去行尾空白，否则 git diff --check 会拦下入库产物。
  return page.replace(/[ \t]+$/gm, '');
}

async function buildPlugin(id) {
  const pluginDir = join(pluginsDir, id);
  const manifest = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8'));
  if (manifest.id !== id) throw new Error(`${id}: manifest.json 的 id 与目录名不一致`);
  const packageDir = join(pluginDir, 'package');
  await rm(packageDir, { recursive: true, force: true });
  const files = [];
  if (manifest.ui) {
    const page = Buffer.from(await buildUi(join(pluginDir, 'ui'), manifest.name), 'utf8');
    const target = join(packageDir, manifest.ui.entry);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, page);
    files.push({ path: manifest.ui.entry, sha256: sha256(page), bytes: page.length });
  }
  await mkdir(packageDir, { recursive: true });
  const body = { ...manifest, files, source: 'bundled' };
  const lock = { ...body, digest: `sha256:${sha256(Buffer.from(canonical(body), 'utf8'))}` };
  await writeFile(join(packageDir, 'manifest.lock.json'), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  console.log(`plugin ${id}: ${files.map((file) => `${file.path} ${file.bytes} bytes`).join(', ') || '无界面'}`);
}

if (existsSync(pluginsDir)) {
  for (const entry of (await readdir(pluginsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'manifest.json'))) {
      await buildPlugin(entry.name);
    }
  }
}
