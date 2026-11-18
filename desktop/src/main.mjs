// Desktop shell: a window, a tray icon and the viewer-server's lifetime. No business logic.
// Behaviour contract: docs/contracts/desktop-shell.md.
import {
  app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, powerMonitor, screen, session, shell, Tray,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMenu } from './menu.mjs';
import { securityProbe } from './probe.mjs';
import * as rt from './runtime.mjs';
import { allowedNavigation, externalAllowed, trustedSender } from './security.mjs';
import { unpackSeed } from './seed.mjs';
import { initialBounds, MIN_SIZE, saveBounds } from './window-state.mjs';

const { log } = rt;
const PROBE_INTERVAL = 3000;
/** About nine seconds without an answer before the window reports a stopped server. */
const FAILED_PROBES_BEFORE_ERROR = 3;
/** Extra time for a first start after the launcher's own 8 s check has given up. */
const SLOW_START_GRACE = 30_000;
const SMOKE_TIMEOUT = 180_000;
const DOWNLOAD_EVENT = 'atelier:download-saved';
const NAVIGATE_EVENT = 'atelier:navigate';
/** --background / --foreground in web/src/styles/tokens.css. */
const BACKGROUND = { dark: '#0A0A0B', light: '#F2F2F3' };
const FOREGROUND = { dark: '#EDEDEF', light: '#0A0A0B' };
/** Traffic lights centred in the page's 80 px top bar (lg:h-20). */
const TRAFFIC_LIGHTS = { x: 20, y: 33 };
/**
 * Height of the Windows caption buttons drawn over the page's top-right corner.
 * ATELIER_CAPTION_HEIGHT exists only for the 40 / 80 px comparison screenshots (batch 3).
 */
const CAPTION_HEIGHT = Number(process.env.ATELIER_CAPTION_HEIGHT) || 40;
/**
 * Transparent: the buttons are drawn over whatever the page shows there, so a dialog's dimming
 * layer or the canvas runs under them too. Only the symbols follow the theme.
 */
const CAPTION_BACKGROUND = '#00000000';
const ARGS = process.argv.slice(1);
/** Windows installer step: unpack the runtime from the seed, no window, then exit. */
const PREPARE_ONLY = ARGS.includes('--prepare-runtime');
/** Ask the running instance to go through its normal quit flow. */
const QUIT_REQUEST = ARGS.includes('--quit');
const SMOKE = process.env.ATELIER_SMOKE === '1';
const MAC = process.platform === 'darwin';
const LOCAL_PAGE = path.join(app.getAppPath(), 'ui', 'index.html');
const PRELOAD = path.join(app.getAppPath(), 'src', 'preload.cjs');
const TRAY_TEMPLATE = path.join(app.getAppPath(), 'stage', 'icons', 'trayTemplate.png');
const TRAY_ICON = path.join(process.resourcesPath, 'icon.ico');
/** macOS: inside the app bundle. Windows: next to the exe, where the installer puts it. */
const SEED_DIR = MAC ? path.join(process.resourcesPath, 'seed') : path.join(path.dirname(process.execPath), 'seed');

const localData = rt.localDataDir();
const parent = rt.runtimeParent(localData);
// Chromium profile (cookies, localStorage, single-instance lock) at a fixed place: renaming the
// product keeps it, and on Windows it stays out of the roaming profile.
app.setPath('userData', path.join(localData, rt.APP_DIR, 'desktop'));

const state = {
  win: null,
  tray: null,
  runtime: null,
  /** Fixed for the server this shell attached to (see Runtime.stop). */
  dataRoot: null,
  /** Server the window currently shows; null while the bundled page is up. */
  shown: null,
  currentUrl: null,
  booting: false,
  quitting: false,
  /** Shut down / log out / session end: quit without asking, never hold up the system. */
  systemEnding: false,
  /** Set once the seed was unpacked by this launch (a first start). */
  unpacked: false,
  progressAt: 0,
};

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const describe = (server) => `{ port: ${server.port}, instance: ${server.instance} }`;
const serverUrl = (server) => `http://127.0.0.1:${server.port}/`;
const theme = () => rt.savedTheme(parent) ?? 'dark';

function failure(kind, detail = '') {
  return Object.assign(new Error(detail), { kind, detail });
}

function exitNow(code) {
  state.quitting = true;
  app.exit(code);
}

function showMain() {
  const { win } = state;
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function localUrl(query = {}) {
  const url = pathToFileURL(LOCAL_PAGE);
  url.searchParams.set('name', app.getName());
  url.searchParams.set('theme', theme());
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** The server page is always reloaded: after an in-app update it is a new instance on the same URL. */
function navigate(url, server = null) {
  state.shown = server;
  if (!server && state.currentUrl === url) return;
  state.currentUrl = url;
  log(`navigate ${url}`);
  state.win?.loadURL(url).catch((error) => log(`load failed ${url}: ${error.message}`));
}

function showError(kind, detail = '') {
  navigate(localUrl(detail ? { error: kind, detail } : { error: kind }));
  if (SMOKE) {
    log(`smoke: failed: ${kind} ${detail}`);
    exitNow(1);
  }
}

function openExternal(url) {
  if (!externalAllowed(url)) {
    log(`refused to open ${url}`);
    return;
  }
  log(`open externally: ${url}`);
  shell.openExternal(url).catch((error) => log(`open externally failed: ${error.message}`));
}

function openLog() {
  const file = state.dataRoot
    ? path.join(state.dataRoot, '.runtime', 'server.log')
    : path.join(parent, 'shell.log');
  shell.openPath(file).then((error) => { if (error) log(`open log failed: ${error}`); });
}

/** A documented event the Atelier page may listen to (docs/contracts/desktop-shell.md). */
function dispatch(event, detail) {
  if (!state.shown || !state.win) return;
  const code = `window.dispatchEvent(new CustomEvent(${JSON.stringify(event)}, { detail: ${JSON.stringify(detail)} }))`;
  state.win.webContents.mainFrame.executeJavaScript(code).catch(() => {});
}

/** Unpacking progress is pushed to the loading page, at most every 100 ms. */
function pushProgress(done, total) {
  if (!state.unpacked) {
    state.unpacked = true;
    navigate(localUrl({ stage: 'preparing' }));
  }
  const now = Date.now();
  if (now - state.progressAt < 100) return;
  state.progressAt = now;
  state.win?.webContents
    .executeJavaScript(`window.atelierProgress && window.atelierProgress(${done}, ${total})`)
    .catch(() => {});
}

/** --prepare-runtime progress for the installer: one `progress <done> <total>` line at a time. */
let printedAt = 0;
function printProgress(done, total) {
  const now = Date.now();
  if (done < total && now - printedAt < 100) return;
  printedAt = now;
  process.stdout.write(`progress ${done} ${total}\n`);
}

/** Exit code for --prepare-runtime; on failure the last stderr line is the reason. */
async function prepareOnly() {
  log(`${app.getName()} ${app.getVersion()} --prepare-runtime`);
  try {
    await prepareRuntime();
    return 0;
  } catch (error) {
    const reason = error.detail || error.message || '安装运行环境失败';
    log(`prepare-runtime failed: ${reason}`);
    process.stderr.write(`${reason}\n`);
    return 1;
  }
}

async function confirm(title, message, ok) {
  showMain();
  const { response } = await dialog.showMessageBox(state.win, {
    type: 'warning', title, message, buttons: [ok, '取消'], defaultId: 1, cancelId: 1, noLink: true,
  });
  return response === 0;
}

function workMessage(work, action) {
  return work === null
    ? `无法确认是否有任务正在进行，${action}会中断进行中的任务。`
    : `还有 ${work} 项任务正在进行，${action}会中断它们。`;
}

/**
 * Before the runtime is replaced: stop the server this shell started from it, asking first while
 * work is in flight. False when the user keeps it running.
 */
async function releaseRuntime(root) {
  const old = new rt.Runtime(root);
  const dataRoot = await old.dataRoot().catch(() => null);
  const server = dataRoot && await rt.verifiedServer(dataRoot);
  if (!server || !rt.isOwned(dataRoot, server)) return true;
  const work = await rt.activeWork(dataRoot, server);
  // --prepare-runtime runs after the installer's --quit, which already asked.
  const ask = work !== 0 && !SMOKE && !PREPARE_ONLY;
  if (ask && !(await confirm(app.getName(), workMessage(work, '更新运行环境'), '仍然更新'))) {
    return false;
  }
  await old.stop(dataRoot).catch((error) => log(`stop failed: ${error.message}`));
  rt.clearOwned(dataRoot);
  return true;
}

async function prepareRuntime() {
  if (state.runtime) return state.runtime;
  let root = rt.runtimeRoot(parent);
  if (!process.env.ATELIER_RUNTIME_ROOT) {
    const seed = rt.readSeed(SEED_DIR);
    log(seed ? `seed ${path.basename(seed.file)} build=${seed.build}` : 'seed missing');
    const reason = seed ? rt.replacementReason(root, seed) : rt.installed(root) ? null : 'missing';
    if (reason) log(`runtime replacement: ${reason}`);
    if (reason && !seed) throw failure('install', '安装包里缺少运行环境');
    if (reason === 'too-old') throw failure('install', '安装包里的运行环境比已有的旧');
    if (reason === 'missing' || ((reason === 'contract' || reason === 'build') && await releaseRuntime(root))) {
      try {
        root = await unpackSeed(parent, seed, PREPARE_ONLY ? printProgress : pushProgress);
      } catch (error) {
        log(`runtime not ready: ${error.message}`);
        // A failed replacement leaves the old runtime in place; keep using it if it can serve.
        if (!(rt.installed(root) && rt.meetsContract(root))) throw failure('install', error.message);
      }
    } else if (reason) {
      log('runtime replacement postponed');
    }
  }
  log(`runtime current=${rt.meetsContract(root)}`);
  state.runtime = new rt.Runtime(root);
  return state.runtime;
}

async function waitForServer(dataRoot) {
  const started = Date.now();
  while (Date.now() - started <= SLOW_START_GRACE) {
    const server = await rt.verifiedServer(dataRoot);
    if (server) return server;
    await delay(500);
  }
  return null;
}

/** Attach to the recorded server, or start one through the fixed launcher. */
async function boot() {
  if (state.booting) return;
  state.booting = true;
  try {
    const runtime = await prepareRuntime();
    // A runtime unpacked just now still has to pass the system's first-load checks.
    navigate(localUrl(state.unpacked ? { stage: 'first' } : {}));
    let dataRoot = await runtime.dataRoot().catch((error) => { throw failure('start', error.message); });
    let server = await rt.verifiedServer(dataRoot);
    if (server) {
      log(`attached to ${describe(server)}, owned=${rt.isOwned(dataRoot, server)}`);
    } else {
      let reason = '';
      // The launcher reports the data root it started with (first start writes the config).
      dataRoot = await runtime.start().catch((error) => { reason = error.message; return dataRoot; });
      // The launcher gives up after 8 s, but a freshly unpacked runtime waits on the system's
      // first-load check of every native library: wait for the record instead of failing.
      server = await waitForServer(dataRoot);
      if (!server) {
        log('no verified server after the grace period');
        throw failure('start', reason);
      }
      rt.markOwned(dataRoot, server);
      log(`started ${describe(server)}`);
    }
    state.dataRoot = dataRoot;
    navigate(serverUrl(server), server);
  } catch (error) {
    if (!error.kind) log(`boot failed: ${error.stack || error.message}`);
    showError(error.kind || 'start', error.kind ? error.detail : '');
  } finally {
    state.booting = false;
  }
}

function watchdog() {
  let failures = 0;
  let busy = false;
  setInterval(async () => {
    const { shown, dataRoot, runtime } = state;
    if (busy || state.quitting || !shown || !dataRoot) return;
    busy = true;
    try {
      const server = await rt.verifiedServer(dataRoot);
      if (state.shown !== shown || state.quitting) return;
      if (server && rt.sameServer(server, shown)) {
        failures = 0;
      } else if (server) {
        // Restarted elsewhere (in-app update, another launcher): follow the record.
        failures = 0;
        log(`server moved ${describe(shown)} -> ${describe(server)}`);
        // An update restarts our server as a new instance; it is still ours to stop.
        if (rt.isOwned(dataRoot, shown)) rt.markOwned(dataRoot, server);
        navigate(serverUrl(server), server);
      } else if (runtime?.updateInProgress(dataRoot)) {
        failures = 0;
      } else {
        failures += 1;
        log(`status probe failed (${failures})`);
        if (failures >= FAILED_PROBES_BEFORE_ERROR) {
          failures = 0;
          showError('stopped');
        }
      }
    } finally {
      busy = false;
    }
  }, PROBE_INTERVAL);
}

/** Stop the server only if this shell started it; ask first while work is in flight. */
async function quit() {
  if (state.quitting) return;
  state.quitting = true;
  saveBounds(parent, state.win);
  const { runtime, dataRoot } = state;
  if (runtime && dataRoot) {
    const server = await rt.verifiedServer(dataRoot);
    if (server && rt.isOwned(dataRoot, server)) {
      const work = await rt.activeWork(dataRoot, server);
      const ask = work !== 0 && !SMOKE && !state.systemEnding;
      if (ask && !(await confirm(`退出 ${app.getName()}`, workMessage(work, '退出'), '仍然退出'))) {
        state.quitting = false;
        return;
      }
      await runtime.stop(dataRoot).catch((error) => log(`stop failed: ${error.message}`));
      rt.clearOwned(dataRoot);
    } else if (server) {
      log('server was not started by this shell; leaving it running');
    }
  }
  app.exit(0);
}

/** The system is going down: stop the server this shell started, without a question. */
function endSession(reason) {
  log(`system ending (${reason}): quitting without confirmation`);
  state.systemEnding = true;
  quit();
}

function setTheme(value) {
  if (value !== 'light' && value !== 'dark') return;
  if (rt.savedTheme(parent) === value) return;
  rt.saveTheme(parent, value);
  log(`theme ${value}`);
  const { win } = state;
  if (!win) return;
  win.setBackgroundColor(BACKGROUND[value]);
  if (!MAC) win.setTitleBarOverlay({ color: CAPTION_BACKGROUND, symbolColor: FOREGROUND[value], height: CAPTION_HEIGHT });
}

/** IPC from the pages, each checked against the sender frame first (src/security.mjs). */
function listen(channel, kind, handler) {
  ipcMain.on(channel, (event, ...args) => {
    const context = {
      serverOrigin: state.shown ? `http://127.0.0.1:${state.shown.port}` : null,
      localPagePath: LOCAL_PAGE,
    };
    if (!trustedSender(event.senderFrame, state.win?.webContents.mainFrame, kind, context)) {
      log(`ignored ${channel} from ${event.senderFrame?.url ?? 'unknown frame'}`);
      return;
    }
    handler(...args);
  });
}

function webPreferences() {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    devTools: process.env.ATELIER_DEVTOOLS === '1',
    // The page leaves room for the window controls (DESKTOP_CONTRACT 2, guaranteed by prepareRuntime).
    additionalArguments: ['--atelier-titlebar=overlay'],
  };
}

const EDIT_MENU = [
  { role: 'cut', label: '剪切' },
  { role: 'copy', label: '拷贝' },
  { role: 'paste', label: '粘贴' },
  { type: 'separator' },
  { role: 'selectAll', label: '全选' },
];

/** No web context menu, except the edit items in text fields and on selected text. */
function contextMenu(win, params) {
  if (params.isEditable) {
    const flags = params.editFlags;
    const enabled = { cut: flags.canCut, copy: flags.canCopy, paste: flags.canPaste, selectAll: flags.canSelectAll };
    Menu.buildFromTemplate(EDIT_MENU.map((item) => (item.role ? { ...item, enabled: enabled[item.role] } : item)))
      .popup({ window: win });
  } else if (params.selectionText) {
    Menu.buildFromTemplate([{ role: 'copy', label: '拷贝' }]).popup({ window: win });
  }
}

function openSettings() {
  showMain();
  dispatch(NAVIGATE_EVENT, { path: '/settings/providers' });
}

/** Windows has no menu bar: the menu's shortcuts are handled here. */
function windowsShortcut(event, input) {
  if (input.type !== 'keyDown' || input.alt || input.meta) return;
  const key = input.key.toLowerCase();
  if (input.control && key === ',') openSettings();
  else if (key === 'f5' || (input.control && key === 'r')) state.win?.webContents.reload();
  else if (key === 'f11') state.win?.setFullScreen(!state.win.isFullScreen());
  else return;
  event.preventDefault();
}

function guardNavigation(event, url) {
  const target = event.url ?? url;
  if (allowedNavigation(target, LOCAL_PAGE)) return;
  event.preventDefault();
  openExternal(target);
}

function createWindow() {
  const current = theme();
  const { bounds, maximized } = initialBounds(parent, screen);
  log('title bar overlay=true');
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: app.getName(),
    backgroundColor: BACKGROUND[current],
    show: false,
    titleBarStyle: 'hidden',
    ...(MAC
      ? { trafficLightPosition: TRAFFIC_LIGHTS }
      : { titleBarOverlay: { color: CAPTION_BACKGROUND, symbolColor: FOREGROUND[current], height: CAPTION_HEIGHT } }),
    webPreferences: webPreferences(),
  });
  state.win = win;
  if (bounds.x === undefined) win.center();
  if (maximized) win.maximize();
  win.show();
  const wc = win.webContents;
  wc.on('did-finish-load', () => log(`page loaded ${wc.getURL()}`));
  wc.on('will-navigate', guardNavigation);
  wc.on('will-redirect', guardNavigation);
  // Backstop: about:blank (and anything else the renderer commits without asking) never reaches
  // will-navigate. If the main frame lands somewhere unlisted, go back to the expected page.
  wc.on('did-navigate', (_event, url) => {
    if (allowedNavigation(url, LOCAL_PAGE)) return;
    log(`left the allowed pages (${url.slice(0, 120)}); going back`);
    state.currentUrl = null;
    navigate(state.shown ? serverUrl(state.shown) : localUrl(), state.shown);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (allowedNavigation(url, LOCAL_PAGE)) log(`blocked same-host new window ${url}`);
    else openExternal(url);
    return { action: 'deny' };
  });
  wc.on('context-menu', (_event, params) => contextMenu(win, params));
  if (!MAC) wc.on('before-input-event', windowsShortcut);
  wc.on('render-process-gone', (_event, details) => {
    log(`page process gone: ${details.reason}`);
    if (!state.quitting) wc.reload();
  });
  // Windows: the user is logging off or shutting down.
  win.on('session-end', () => endSession('session-end'));
  win.on('close', (event) => {
    if (state.quitting) return;
    // Closing keeps the server, running jobs and agent connections alive in the tray.
    event.preventDefault();
    saveBounds(parent, win);
    win.hide();
  });
  // The loading page from the first frame, in the remembered theme.
  navigate(localUrl());
}

function createTray() {
  const name = app.getName();
  let icon;
  if (MAC) {
    // The bare glyph as a template image (scripts/build_tray_icon.py), drawn 18 pt tall from a 3x render.
    icon = nativeImage.createFromBuffer(fs.readFileSync(TRAY_TEMPLATE), { scaleFactor: 3 });
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(TRAY_ICON);
  }
  const tray = new Tray(icon);
  tray.setToolTip(name);
  const menu = Menu.buildFromTemplate([
    { label: `显示 ${name}`, click: showMain },
    ...(MAC ? [] : [{ label: '查看日志', click: openLog }]),
    { label: `退出 ${name}`, click: () => { quit(); } },
  ]);
  if (MAC) {
    tray.setContextMenu(menu);
  } else {
    tray.on('click', showMain);
    tray.on('right-click', () => tray.popUpContextMenu(menu));
  }
  state.tray = tray;
}

function setupSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['clipboard-sanitized-write', 'fullscreen']);
  const serverOrigin = () => (state.shown ? `http://127.0.0.1:${state.shown.port}` : null);
  const permitted = (permission, origin, isMainFrame) => {
    let requested = null;
    try { requested = new URL(origin).origin; } catch { /* opaque */ }
    return allowed.has(permission) && isMainFrame !== false && requested !== null && requested === serverOrigin();
  };
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const ok = permitted(permission, details.requestingUrl, details.isMainFrame);
    if (!ok) log(`denied permission ${permission} for ${details.requestingUrl}`);
    callback(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin, details) => permitted(permission, origin, details?.isMainFrame));
  ses.on('will-download', (_event, item) => {
    const dir = MAC ? path.join(process.env.HOME || app.getPath('home'), 'Downloads') : app.getPath('downloads');
    const target = rt.uniqueDownloadPath(dir, item.getFilename());
    item.setSavePath(target);
    log(`download ${item.getURL().slice(0, 200)} -> ${target}`);
    item.once('done', (_e, result) => {
      log(`download finished ${target} ${result}`);
      if (result === 'completed') dispatch(DOWNLOAD_EVENT, { name: path.basename(target) });
    });
  });
}

function setupMenu() {
  if (!MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), version: '' });
  Menu.setApplicationMenu(buildMenu(app.getName(), {
    settings: openSettings,
    reload: () => state.win?.webContents.reload(),
    actualSize: () => state.win?.webContents.setZoomLevel(0),
    openLog,
    quit: () => { quit(); },
  }));
}

function runSmoke() {
  // CI: boot, wait for the server page, check the shell interface, then the normal quit path.
  const started = Date.now();
  const timer = setInterval(async () => {
    if (!state.shown) {
      if (Date.now() - started > SMOKE_TIMEOUT) {
        clearInterval(timer);
        log('smoke: timed out waiting for the server');
        exitNow(2);
      }
      return;
    }
    clearInterval(timer);
    await delay(8000);
    const problems = await securityProbe(state.win, state.shown.port, webPreferences())
      .catch((error) => [`probe crashed: ${error.message}`]);
    if (problems.length) {
      log(`security probe: failed: ${problems.join('; ')}`);
      exitNow(1);
      return;
    }
    log('security probe: ok');
    log('smoke: page shown, quitting');
    quit();
  }, 500);
}

/** Same id as the installer's shortcuts (electron-builder appId, passed in as build metadata). */
function appUserModelId() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).atelierAppId || null;
  } catch {
    return null;
  }
}

function start() {
  log(`${app.getName()} ${app.getVersion()} starting`);
  const appId = MAC ? null : appUserModelId();
  if (appId) app.setAppUserModelId(appId);
  setupSession();
  setupMenu();
  listen('atelier:set-theme', 'page', setTheme);
  listen('atelier:retry', 'local', () => { boot(); });
  listen('atelier:open-log', 'local', openLog);
  createWindow();
  createTray();
  // macOS: shut down, restart or log out. preventDefault asks the system to wait for the quit.
  powerMonitor.on('shutdown', (event) => {
    event.preventDefault();
    endSession('shutdown');
  });
  boot();
  watchdog();
  if (SMOKE) runSmoke();
}

if (PREPARE_ONLY) {
  // No window and no single-instance lock: the installer runs this before the app is opened.
  prepareOnly().then((code) => app.exit(code));
} else if (!app.requestSingleInstanceLock()) {
  // The running instance received our arguments (second-instance), --quit included.
  app.exit(0);
} else if (QUIT_REQUEST) {
  // Nothing is running, so there is nothing to quit.
  app.exit(0);
} else {
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) {
      log('quit requested by another launch');
      quit();
    } else {
      showMain();
    }
  });
  // ⌘Q, the app menu, the Dock and the tray all go through the same quit flow.
  app.on('before-quit', (event) => {
    if (state.quitting) return;
    event.preventDefault();
    quit();
  });
  app.on('activate', showMain);
  app.whenReady().then(start);
}
