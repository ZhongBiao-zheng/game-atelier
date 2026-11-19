// CI only (Windows): the title bar with its caption buttons in dark and light — plus where a full-window overlay's top-right control lands (the `desktop-clear-top` rule),
// and the loading page's runtime-download states drawn in the same window (values fed to the page).
// Real screen captures, so the system-drawn caption buttons are in them.
// usage: node window-shots.mjs <app-folder> <out-dir>
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [appDir, out] = process.argv.slice(2);
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const product = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).productName;
const exe = path.join(appDir, `${product}.exe`);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-shots-'));
const env = {
  ...process.env, LOCALAPPDATA: path.join(work, 'local'), GAME_ATELIER_DATA_ROOT: path.join(work, 'data'),
  GAME_ATELIER_NO_UPDATE_CHECK: '1',
};
const PORT = 9340;
const MB = 1024 * 1024;
const TOTAL = Math.round(142.9 * MB);
// The loading page in the packaged app, with the state the shell would put in its query.
const LOADING = path.join(appDir, 'resources', 'app.asar', 'ui', 'index.html');
const loadingStates = [
  ['download', { stage: 'download' },
    `(async () => { for (let i = 0; i <= 40; i += 1) { window.atelierDownload(Math.round((12 + i * 0.42) * ${MB}), ${TOTAL});
      await new Promise((r) => { setTimeout(r, 100); }); } return true; })()`],
  ['paused', { stage: 'paused', done: 56 * MB, total: TOTAL }, 'true'],
  ['preparing', { stage: 'preparing' }, 'window.atelierProgress(6200, 13452), true'],
  ['fail-network', { error: 'download', detail: '网络连接失败' }, 'true'],
  ['fail-checksum', { error: 'download', detail: '文件校验未通过' }, 'true'],
];
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
fs.mkdirSync(out, { recursive: true });

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0; const pending = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
    ws.onerror = reject;
    ws.onopen = () => resolve({
      eval: (expression) => new Promise((r) => {
        id += 1; pending.set(id, (d) => r(d.result?.result?.value));
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
      close: () => ws.close(),
    });
  });
}
async function page() {
  for (let i = 0; i < 240; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const p = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
      if (p) return connect(p.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('no Atelier page');
}
function capture(rect, file) {
  const [x, y, w, h] = rect.map(Math.round);
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = New-Object System.Drawing.Bitmap ${w}, ${h}
    [System.Drawing.Graphics]::FromImage($b).CopyFromScreen(${x}, ${y}, 0, 0, $b.Size)
    $b.Save('${file.replace(/'/g, "''")}')`]);
}

const prepared = spawnSync(exe, ['--prepare-runtime'], { env, encoding: 'utf8' });
console.log('prepare-runtime', prepared.status, prepared.stdout.trim().split('\n').at(-1));
for (const theme of ['dark', 'light']) {
  const app = spawn(exe, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' });
  const cdp = await page();
  await sleep(3000);
  await cdp.eval(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '稍后'); if (b) b.click(); return !!b; })()`);
  await sleep(1500);
  const toggle = theme === 'light' ? '切换到浅色主题' : '切换到深色主题';
  await cdp.eval(`(() => { const b = document.querySelector('[aria-label="${toggle}"]'); if (b) b.click(); return !!b; })()`);
  await sleep(2000);
  const rect = await cdp.eval('[screenX, screenY, outerWidth, outerHeight]');
  // First with whatever dialog the empty data root opens (its dimming layer runs under the
  // caption buttons), then without it.
  capture(rect, path.join(out, `titlebar-${theme}-dialog.png`));
  await cdp.eval(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
  await sleep(1000);
  capture(rect, path.join(out, `titlebar-${theme}.png`));
  if (theme === 'dark') {
    // Stand-in for the Lightbox close button (fixed, right-6 top-6) with the same class.
    await cdp.eval(`(() => { const b = document.createElement('div'); b.className = 'desktop-clear-top';
      Object.assign(b.style, { position: 'fixed', right: '24px', top: '24px', width: '40px', height: '40px', borderRadius: '20px', background: '#e5484d', zIndex: 60 });
      document.body.appendChild(b); return true; })()`);
    await sleep(500);
    capture(rect, path.join(out, 'overlay-top-right-dark.png'));
  }
  // Switching state must not move the mark or the title (they hang from a fixed point).
  const positions = [];
  for (const [state, query, feed] of loadingStates) {
    const url = pathToFileURL(LOADING);
    for (const [key, value] of Object.entries({ name: product, theme, ...query })) url.searchParams.set(key, String(value));
    await cdp.eval(`location.href = ${JSON.stringify(url.href)}, true`);
    await sleep(1500);
    await cdp.eval(feed);
    await sleep(300);
    capture(rect, path.join(out, `loading-${theme}-${state}.png`));
    positions.push([state, await cdp.eval(`[document.querySelector('.mark').getBoundingClientRect().top,
      document.getElementById('title').getBoundingClientRect().top]`)]);
  }
  const moved = positions.filter(([, at]) => at[0] !== positions[0][1][0] || at[1] !== positions[0][1][1]);
  console.log(`loading ${theme}: mark / title top`, JSON.stringify(positions));
  if (moved.length) throw new Error(`the mark or title moved between loading states: ${JSON.stringify(positions)}`);
  cdp.close();
  spawnSync(exe, ['--quit'], { env, timeout: 60000 });
  await new Promise((resolve) => { if (app.exitCode !== null) resolve(); else app.once('exit', resolve); });
  console.log(`titlebar ${theme}: captured`, rect);
}
