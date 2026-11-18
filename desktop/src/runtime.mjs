// The shell's side of docs/contracts/desktop-shell.md: it only touches the runtime bundle through
// its fixed launcher, and the server through `.runtime` records and loopback HTTP.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** Shared with the Python side (`APP_NAME`), independent of the product name. */
export const APP_DIR = 'game-atelier';
export const BUNDLE_DIR = 'GameAtelier';
/**
 * What this shell relies on: `bootstrap.py --desktop-start`, and a page that declares its drag
 * regions with `app-region`, reports its theme through `window.atelierShell` and leaves room for
 * the window controls under `data-titlebar="overlay"`. Runtimes declare what they offer in
 * `versions/<version>/DESKTOP_CONTRACT` (scripts/build_release.py, same number).
 */
export const DESKTOP_CONTRACT = 2;
const CONTRACT_FILE = 'DESKTOP_CONTRACT';
/** Content digest written by scripts/build_release.py next to VERSION. */
const BUILD_FILE = 'BUILD_ID';
/** Which seed build the shell unpacked into this runtime root (see `seedRecord`). */
const SEED_RECORD = 'seed.json';

let logFile = null;

export function log(line) {
  // Never throw on a closed stderr (Finder launches, pipes).
  try { process.stderr.write(`[shell] ${line}\n`); } catch { /* ignore */ }
  if (!logFile) return;
  try { fs.appendFileSync(logFile, `${Math.floor(Date.now() / 1000)} ${line}\n`); } catch { /* ignore */ }
}

/**
 * macOS `~/Library/Application Support`, Windows `%LOCALAPPDATA%`. Derived from HOME rather than
 * the system API, so a test run with its own HOME never touches the real folders.
 */
export function localDataDir() {
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  }
  return path.join(os.homedir(), 'Library', 'Application Support');
}

/** `<local data>/game-atelier/runtime`: writable, outside the read-only app bundle. */
export function runtimeParent(localData) {
  const parent = path.join(localData, APP_DIR, 'runtime');
  fs.mkdirSync(parent, { recursive: true });
  logFile = path.join(parent, 'shell.log');
  return parent;
}

/** Where the runtime lives (or will be unpacked to); `ATELIER_RUNTIME_ROOT` is for development. */
export function runtimeRoot(parent) {
  return process.env.ATELIER_RUNTIME_ROOT || path.join(parent, BUNDLE_DIR);
}

export function readTrim(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

export function validVersion(version) {
  return typeof version === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version);
}

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function interpreter(payload) {
  return process.platform === 'win32'
    ? path.join(payload, 'python', 'python.exe')
    : path.join(payload, 'python', 'bin', 'python3');
}

/** A bundle is usable when `last-good` names a complete version directory (ADR-0030). */
export function validateBundle(root) {
  const version = readTrim(path.join(root, 'last-good'));
  if (!version) throw new Error('运行包缺少 last-good');
  if (!validVersion(version)) throw new Error(`运行包版本无效：${version}`);
  const payload = path.join(root, 'versions', version);
  if (readTrim(path.join(payload, 'VERSION')) !== version || !fs.existsSync(interpreter(payload))) {
    throw new Error(`运行包版本目录不完整：${version}`);
  }
}

export function installed(root) {
  try {
    validateBundle(root);
    return true;
  } catch {
    return false;
  }
}

/** Missing files and anything but a plain integer count as level 0. */
export function contractLevel(text) {
  const value = String(text ?? '').trim();
  return /^\d+$/.test(value) ? Number(value) : 0;
}

/**
 * Both versions the launcher may use must offer the contract: `last-good` runs `bootstrap.py`
 * (which parses `--desktop-start`), `current` serves the page unless it is rolled back.
 */
export function meetsContract(root) {
  const levels = ['current', 'last-good']
    .map((name) => readTrim(path.join(root, name)))
    .filter(validVersion)
    .map((version) => contractLevel(readTrim(path.join(root, 'versions', version, CONTRACT_FILE))));
  return levels.length > 0 && levels.every((level) => level >= DESKTOP_CONTRACT);
}

/**
 * `<resources>/seed/seed.json`, written by scripts/build_desktop.py from the archive itself:
 * `{ file, version, build, contract }`. Null when the install ships no usable seed.
 */
export function readSeed(seedDir) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(seedDir, 'seed.json'), 'utf8'));
    const file = path.join(seedDir, path.basename(String(info.file)));
    if (!validVersion(info.version) || !fs.existsSync(file)) return null;
    return { file, version: info.version, build: String(info.build || ''), contract: contractLevel(info.contract) };
  } catch {
    return null;
  }
}

export function seedRecord(root) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(root, SEED_RECORD), 'utf8'));
    return validVersion(record.version) ? { version: record.version, build: String(record.build || '') } : null;
  } catch {
    return null;
  }
}

export function writeSeedRecord(root, seed) {
  fs.writeFileSync(path.join(root, SEED_RECORD), `${JSON.stringify({ version: seed.version, build: seed.build })}\n`);
}

export function buildId(root, version) {
  return readTrim(path.join(root, 'versions', version, BUILD_FILE));
}

/**
 * Why the runtime must be (re)created from the seed, or null to keep it.
 * - `missing`: no usable runtime yet (first start, or an interrupted earlier attempt).
 * - `contract`: it does not declare DESKTOP_CONTRACT and the seed is not older. Contract levels only
 *   grow with builds, so a runtime newer than the seed always declares it.
 * - `build`: it runs the seed's version, that version directory came from a seed (the record says
 *   so and still matches), and this seed is a different build. Test packages are reinstalled under
 *   the same version number; an in-app update never writes the record.
 * - `too-old`: it does not declare the contract and the seed is older, so the seed cannot help.
 */
export function replacementReason(root, seed) {
  if (!installed(root)) return 'missing';
  const lastGood = readTrim(path.join(root, 'last-good'));
  if (!meetsContract(root)) {
    return compareVersions(seed.version, lastGood) >= 0 ? 'contract' : 'too-old';
  }
  if (lastGood === seed.version && seed.build) {
    const record = seedRecord(root);
    const build = buildId(root, lastGood);
    if (record?.version === lastGood && record.build === build && build !== seed.build) return 'build';
  }
  return null;
}

/** `light` / `dark` as the page last reported it. */
export function savedTheme(parent) {
  const theme = readTrim(path.join(parent, 'window-theme'));
  return theme === 'light' || theme === 'dark' ? theme : null;
}

export function saveTheme(parent, theme) {
  try { fs.writeFileSync(path.join(parent, 'window-theme'), theme); } catch { /* ignore */ }
}

function tail(text, lines = 6) {
  return text.split(/\r?\n/).filter((l) => l.trim()).slice(-lines).join('\n');
}

export class Runtime {
  constructor(root) {
    this.root = root;
  }

  launcher(args) {
    const env = { ...process.env };
    delete env.VIRTUAL_ENV;
    delete env.UV_PROJECT_ENVIRONMENT;
    if (process.platform !== 'win32') {
      return { file: '/bin/sh', args: [path.join(this.root, '启动.command'), ...args], env };
    }
    // Windows: do what launch.ps1 does (last-good interpreter runs bootstrap.py) without
    // PowerShell. launch.ps1 stays untouched for double-click and the scheduled task, the shell
    // skips ~1 s of PowerShell start-up per call, and Python's UTF-8 output reaches us unchanged.
    const version = readTrim(path.join(this.root, 'last-good')) || '';
    const payload = path.join(this.root, 'versions', version);
    env.PYTHONPATH = path.join(payload, 'app', 'src');
    env.PYTHONUTF8 = '1';
    return {
      file: path.join(payload, 'python', 'python.exe'),
      args: [path.join(payload, 'app', 'scripts', 'bootstrap.py'), ...args],
      env,
    };
  }

  /**
   * Resolves with stdout. Rejects with an Error whose message is only what the launcher wrote to
   * stderr for users (empty when it gave no reason); internal failures go to the log.
   */
  run(args, dataRoot) {
    const { file, args: argv, env } = this.launcher(args);
    if (dataRoot) env.GAME_ATELIER_DATA_ROOT = dataRoot;
    return new Promise((resolve, reject) => {
      execFile(file, argv, { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
          log(`launcher ${JSON.stringify(args)} -> ${code}`);
          if (!error) {
            resolve(stdout);
            return;
          }
          if (typeof error.code !== 'number') log(`cannot run the launcher: ${error.message}`);
          const message = tail(stderr || '');
          if (message) log(`launcher stderr: ${message}`);
          reject(new Error(message));
        });
    });
  }

  /** Single source of truth for the data root (`bootstrap.py --print-data-root`). */
  async dataRoot() {
    const out = await this.run(['--print-data-root']);
    const line = out.split(/\r?\n/)[0]?.trim();
    if (!line) {
      log('the launcher printed no data root');
      throw new Error('');
    }
    return line;
  }

  /** Starts the server and returns the data root it uses (the launcher's last stdout line). */
  async start() {
    const out = await this.run(['--desktop-start']);
    const line = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
    if (!line) {
      log('the launcher printed no data root');
      throw new Error('');
    }
    return line;
  }

  /**
   * Pinned to the data root the server was started with: the page may switch the configured
   * root while this server keeps its records in the old one.
   */
  stop(dataRoot) {
    return this.run(['--run', '-m', 'viewer_server.server', 'stop'], dataRoot);
  }

  updateInProgress(dataRoot) {
    return fs.existsSync(path.join(this.root, 'updates', 'pending.json'))
      || fs.existsSync(path.join(dataRoot, '.runtime', 'maintenance'));
  }
}

function httpGet(port, pathname, bearer) {
  return new Promise((resolve) => {
    const headers = { Accept: 'application/json' };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size <= 64 * 1024) chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve(null));
    });
    // 800 ms to connect, 3 s for the answer.
    const connect = setTimeout(() => req.destroy(), 800);
    req.on('socket', (socket) => socket.once('connect', () => clearTimeout(connect)));
    req.setTimeout(3000, () => req.destroy());
    req.on('error', () => { clearTimeout(connect); resolve(null); });
    req.on('close', () => clearTimeout(connect));
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The recorded server, only if it answers with the recorded instance id. */
export async function verifiedServer(dataRoot) {
  const records = path.join(dataRoot, '.runtime');
  const port = Number.parseInt(readTrim(path.join(records, 'server.port')) || '', 10);
  const instance = readTrim(path.join(records, 'server.instance'));
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !instance) return null;
  const res = await httpGet(port, '/api/connection/status');
  const body = res && parseJson(res.body);
  if (res?.status === 200 && body?.service === 'game-atelier' && body.instance_id === instance) {
    return { port, instance };
  }
  return null;
}

export function sameServer(a, b) {
  return Boolean(a && b && a.port === b.port && a.instance === b.instance);
}

/** Total in-flight work, or null when the server cannot tell us (treated as "maybe busy"). */
export async function activeWork(dataRoot, server) {
  const control = parseJson(readTrim(path.join(dataRoot, '.runtime', 'shell-control.json')) || '');
  if (!control || control.instance_id !== server.instance || typeof control.token !== 'string') return null;
  const res = await httpGet(server.port, '/api/shell/active-work', control.token);
  const counts = res && parseJson(res.body);
  if (res?.status !== 200 || !counts || typeof counts !== 'object') return null;
  return Object.values(counts).filter((v) => Number.isInteger(v)).reduce((sum, v) => sum + v, 0);
}

/** Survives a shell crash, so a reopened shell still stops the server it started. */
export function markOwned(dataRoot, server) {
  try { fs.writeFileSync(path.join(dataRoot, '.runtime', 'shell-owned'), server.instance); } catch { /* ignore */ }
}

export function isOwned(dataRoot, server) {
  return readTrim(path.join(dataRoot, '.runtime', 'shell-owned')) === server.instance;
}

export function clearOwned(dataRoot) {
  try { fs.rmSync(path.join(dataRoot, '.runtime', 'shell-owned'), { force: true }); } catch { /* ignore */ }
}

/** `name.ext`, `name (1).ext`, … so a download never overwrites an existing file. */
export function uniqueDownloadPath(dir, name) {
  const safe = path.basename(name || 'download') || 'download';
  let candidate = path.join(dir, safe);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(safe);
  const stem = ext ? safe.slice(0, -ext.length) : safe;
  for (let n = 1; ; n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
