// Downloading the runtime (the release archive GameAtelier-<version>-<platform>) on first start.
// Sources, names and addresses come from src/viewer_server/release_sources.json, the same file the
// in-app update reads (docs/contracts/desktop-shell.md「运行包下载」). What the archive must hash to
// is not taken from the source: the shell was built with it (stage/runtime.json `sha256`).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What unpacking needs on top of the archive (Windows 5.138.0: 393 MiB), plus a margin. */
const UNPACKED_BYTES = 400 * 1024 ** 2;
const MARGIN_BYTES = 100 * 1024 ** 2;
const STALL_MS = 30_000;
const RETRY_DELAYS_MS = [2000, 5000];
const CHECKSUM_LIMIT = 1025;

export class DownloadError extends Error {
  /** kind: network | notfound | checksum | disk | cancelled | version */
  constructor(kind, message, extra = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, extra);
  }
}

export function readRelease(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function assetName(release, version, platform) {
  const ext = release.archive_ext[platform];
  if (!ext) throw new Error(`no runtime archive for ${platform}`);
  return release.asset.replace('{version}', version).replace('{platform}', platform).replace('{ext}', ext);
}

export function assetUrl(release, base, version, asset) {
  return release.download.replace('{base}', base).replace('{version}', version).replace('{asset}', asset);
}

/**
 * The order the shell tries: each source in release_sources.json order, without any proxy first
 * when it says `direct_first` (CNB: a broken local proxy is the usual reason a domestic download
 * stalls), then through the system proxy. The in-app update reads the same flag.
 * GAME_ATELIER_TEST_UPDATE_FEED (with GAME_ATELIER_TESTING=1, local http only, comma separated)
 * replaces them all, as it does for the in-app update.
 */
export function plannedSources(release, env = process.env) {
  const feed = testFeeds(env);
  if (feed) return feed.map((base, index) => ({ id: `test${index}`, base, proxy: 'direct' }));
  return release.sources.flatMap((source) => (source.direct_first
    ? [{ ...source, proxy: 'direct' }, { ...source, proxy: 'system' }]
    : [{ ...source, proxy: 'system' }]));
}

function testFeeds(env) {
  const value = env.GAME_ATELIER_TEST_UPDATE_FEED;
  if (!value || env.GAME_ATELIER_TESTING !== '1') return null;
  return value.split(',').map((item) => {
    const url = new URL(item.trim());
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) {
      throw new Error('测试更新源必须是本机 HTTP 地址。');
    }
    return url.href.replace(/\/+$/, '');
  });
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(cancelled()); }, { once: true });
});

function cancelled() {
  return new DownloadError('cancelled', '下载已暂停');
}

function parseChecksum(text) {
  const first = text.trim().split(/\s+/)[0] || '';
  if (!/^[a-fA-F0-9]{64}$/.test(first)) throw new DownloadError('checksum', '校验文件无效');
  return first.toLowerCase();
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function sizeOf(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function freeBytes(dir, statfs) {
  const stats = statfs(dir);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** One request with a stall watchdog; the caller decides about retries. */
async function request(fetchFn, url, { headers = {}, signal, stallMs }) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timer = setTimeout(abort, stallMs);
  const touch = () => { clearTimeout(timer); timer = setTimeout(abort, stallMs); };
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
  try {
    const response = await fetchFn(url, { headers, signal: controller.signal, redirect: 'follow' });
    touch();
    return { response, touch, done };
  } catch (error) {
    done();
    if (signal?.aborted) throw cancelled();
    throw new DownloadError('network', `网络连接失败：${error.message}`);
  }
}

function statusError(status) {
  if (status === 404) return new DownloadError('notfound', '找不到运行包');
  return new DownloadError('network', `下载失败（HTTP ${status}）`);
}

async function fetchChecksum(fetchFn, url, options) {
  const { response, done } = await request(fetchFn, url, options);
  try {
    if (!response.ok) throw statusError(response.status);
    const text = (await response.text()).slice(0, CHECKSUM_LIMIT);
    return parseChecksum(text);
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    if (error instanceof DownloadError) throw error;
    throw new DownloadError('network', `网络连接失败：${error.message}`);
  } finally {
    done();
  }
}

/** Streams the archive into `part`, continuing from its current size when the source allows. */
async function fetchArchive(fetchFn, url, part, { signal, stallMs, onProgress, checkSpace }) {
  let offset = sizeOf(part);
  const headers = offset ? { Range: `bytes=${offset}-` } : {};
  const { response, touch, done } = await request(fetchFn, url, { headers, signal, stallMs });
  try {
    if (response.status === 416 && offset) {
      // Already complete (or the part is longer than the archive): let the hash decide.
      return;
    }
    if (!response.ok) throw statusError(response.status);
    const range = response.headers.get('content-range');
    if (offset && (response.status !== 206 || !range?.startsWith(`bytes ${offset}-`))) {
      offset = 0; // the source ignored Range: start over
    }
    const length = Number(response.headers.get('content-length')) || 0;
    const total = range ? Number(range.split('/')[1]) || offset + length : offset + length;
    checkSpace(total - offset);
    const out = fs.createWriteStream(part, { flags: offset ? 'a' : 'w' });
    let written = offset;
    try {
      for await (const chunk of response.body) {
        touch();
        if (!out.write(chunk)) await new Promise((resolve) => { out.once('drain', resolve); });
        written += chunk.length;
        onProgress(written, total || written);
      }
    } finally {
      await new Promise((resolve, reject) => { out.end((error) => (error ? reject(error) : resolve())); });
    }
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (error instanceof DownloadError) throw error;
    if (error.code === 'ENOSPC') throw new DownloadError('disk', '磁盘空间不足');
    throw new DownloadError('network', `网络连接失败：${error.message}`);
  } finally {
    done();
  }
}

/**
 * Downloads the runtime archive this shell was built with into `dir`; returns its path. `sha256`
 * is the one the build recorded. Each source's `.sha256` is only a cheap check first: when it is
 * not this build's (an unreleased build shares the released version number) or cannot be read, the
 * source is skipped without downloading. A `.part` file and a `.part.json` record survive an
 * interruption, so the next call continues where it stopped; the whole file is then hashed, and a
 * mismatch deletes it and moves on to the next source.
 */
export async function downloadRuntime({
  release, version, platform, sha256, dir, sources, fetchFor, onProgress = () => {}, onSource = () => {},
  signal, statfs = fs.statfsSync, stallMs = STALL_MS, retryDelays = RETRY_DELAYS_MS,
}) {
  fs.mkdirSync(dir, { recursive: true });
  const asset = assetName(release, version, platform);
  const final = path.join(dir, asset);
  const part = `${final}.part`;
  const record = `${part}.json`;
  const failures = [];
  const checkSpace = (remaining) => {
    const need = remaining + UNPACKED_BYTES + MARGIN_BYTES;
    const free = freeBytes(dir, statfs);
    if (free < need) throw new DownloadError('disk', '磁盘空间不足', { need: need - free });
  };
  // Downloaded before but never unpacked (the app quit meanwhile): use it, no network needed.
  if (fs.existsSync(final) && await sha256File(final) === sha256) return final;
  for (const source of sources) {
    if (signal?.aborted) throw cancelled();
    const fetchFn = fetchFor(source.proxy);
    const url = assetUrl(release, source.base, version, asset);
    onSource(source);
    try {
      let checksum;
      for (let attempt = 0; ; attempt += 1) {
        try {
          checksum = await fetchChecksum(fetchFn, url + release.checksum_suffix, { signal, stallMs });
          break;
        } catch (error) {
          if (error.kind !== 'network' || attempt >= retryDelays.length) throw error;
          await sleep(retryDelays[attempt], signal);
        }
      }
      if (checksum !== sha256) throw new DownloadError('checksum', '文件校验未通过');
      const saved = readJson(record);
      if (!(saved?.version === version && saved.sha256 === checksum)) fs.rmSync(part, { force: true });
      fs.writeFileSync(record, JSON.stringify({ version, sha256: checksum, source: source.id }));
      checkSpace(0);
      for (let attempt = 0; ; attempt += 1) {
        try {
          await fetchArchive(fetchFn, url, part, { signal, stallMs, onProgress, checkSpace });
          break;
        } catch (error) {
          if (error.kind !== 'network' || attempt >= retryDelays.length) throw error;
          await sleep(retryDelays[attempt], signal);
        }
      }
      if (await sha256File(part) !== sha256) {
        fs.rmSync(part, { force: true });
        fs.rmSync(record, { force: true });
        throw new DownloadError('checksum', '文件校验未通过');
      }
      fs.renameSync(part, final);
      fs.rmSync(record, { force: true });
      return final;
    } catch (error) {
      if (error.kind === 'cancelled' || error.kind === 'disk') throw error;
      failures.push({ source: source.id, proxy: source.proxy, kind: error.kind || 'network', message: error.message });
    }
  }
  const kinds = failures.map((f) => f.kind);
  const kind = kinds.includes('checksum') ? 'checksum'
    : kinds.length && kinds.every((k) => k === 'notfound') ? 'notfound' : 'network';
  const message = { checksum: '文件校验未通过', notfound: `找不到 ${version} 的运行包`, network: '网络连接失败' }[kind];
  throw new DownloadError(kind, message, { failures });
}

/**
 * A runtime archive the user picked (downloaded in a browser, or the CI artifact of an unreleased
 * build). It must be the archive this shell was built with: its name and its sha256.
 */
export async function checkImported(file, { release, version, platform, sha256 }) {
  const expected = assetName(release, version, platform);
  if (path.basename(file) !== expected) {
    throw new DownloadError('version', `需要 ${version} 的运行包`, { expected });
  }
  if (await sha256File(file) !== sha256) {
    throw new DownloadError('checksum', `文件校验未通过，需要与本安装包配套的 ${version} 运行包`);
  }
  return file;
}
