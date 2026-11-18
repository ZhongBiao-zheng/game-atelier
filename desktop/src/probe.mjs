// Smoke-only check (ATELIER_SMOKE=1) that pages other than the Atelier main frame get no shell
// interface: a sandboxed srcdoc iframe built like the plugin host's, and non-local pages loaded with
// the same webPreferences. Returns a list of problems; empty means the probe passed.
import { BrowserWindow } from 'electron';

const IN_MAIN = `({
  keys: Object.keys(window.atelierShell || {}),
  loading: typeof window.atelierLoading,
  require: typeof require,
  process: typeof process,
  shell: document.documentElement.dataset.shell || '',
})`;

const ADD_FRAME = `new Promise((resolve) => {
  const frame = document.createElement('iframe');
  frame.name = 'atelier-probe';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.srcdoc = '<!doctype html><p>probe</p>';
  frame.onload = () => resolve(true);
  document.body.appendChild(frame);
})`;

const IN_FRAME = `(() => {
  let parentShell;
  try { parentShell = typeof parent.atelierShell; } catch { parentShell = 'blocked'; }
  let opened;
  try { opened = window.open('http://127.0.0.1:1/probe') === null ? 'null' : 'window'; } catch { opened = 'threw'; }
  return { shell: typeof window.atelierShell, loading: typeof window.atelierLoading, origin: String(window.origin), parentShell, opened };
})()`;

const IN_OTHER = `({ host: location.protocol + '//' + location.hostname, shell: typeof window.atelierShell, loading: typeof window.atelierLoading })`;

async function otherPage(url, webPreferences) {
  const win = new BrowserWindow({ show: false, webPreferences });
  try {
    await win.loadURL(url).catch(() => {});
    return await win.webContents.executeJavaScript(IN_OTHER);
  } finally {
    win.destroy();
  }
}

export async function securityProbe(win, port, webPreferences) {
  const problems = [];
  const wc = win.webContents;
  const main = await wc.executeJavaScript(IN_MAIN);
  if (JSON.stringify(main.keys) !== '["setTheme"]') problems.push(`main frame exposes ${JSON.stringify(main.keys)}`);
  if (main.loading !== 'undefined' || main.require !== 'undefined' || main.process !== 'undefined') {
    problems.push(`main frame sees loading=${main.loading} require=${main.require} process=${main.process}`);
  }
  if (!main.shell) problems.push('main frame has no data-shell');

  await wc.executeJavaScript(ADD_FRAME);
  const frame = wc.mainFrame.frames.find((f) => f.name === 'atelier-probe');
  if (!frame) {
    problems.push('probe iframe not found');
  } else {
    const sub = await frame.executeJavaScript(IN_FRAME);
    if (sub.shell !== 'undefined' || sub.loading !== 'undefined') problems.push(`iframe sees shell=${sub.shell} loading=${sub.loading}`);
    if (sub.origin !== 'null') problems.push(`iframe origin ${sub.origin}`);
    if (sub.parentShell !== 'blocked') problems.push(`iframe reaches parent.atelierShell (${sub.parentShell})`);
    if (sub.opened === 'window') problems.push('iframe opened a window');
  }
  await wc.executeJavaScript("document.querySelector('iframe[name=\"atelier-probe\"]')?.remove()");

  // The main frame cannot stay on a page outside the allowed set (about:blank skips will-navigate).
  await wc.executeJavaScript(`location.href = 'about:blank'; true`).catch(() => {});
  let back = false;
  for (let i = 0; i < 40 && !back; i += 1) {
    await new Promise((r) => { setTimeout(r, 250); });
    back = wc.getURL().startsWith(`http://127.0.0.1:${port}/`);
  }
  if (!back) problems.push(`main frame stayed on ${wc.getURL()}`);

  for (const [url, host] of [[`http://localhost:${port}/api/connection/status`, 'http://localhost'], ['data:text/html,<p>probe</p>', 'data://']]) {
    const other = await otherPage(url, webPreferences);
    if (other.host !== host) problems.push(`${url} did not load (${other.host})`);
    if (other.shell !== 'undefined' || other.loading !== 'undefined') problems.push(`${url} sees shell=${other.shell} loading=${other.loading}`);
  }
  return problems;
}
