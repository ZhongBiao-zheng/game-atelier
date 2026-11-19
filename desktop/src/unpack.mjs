// Unpacking a runtime archive (downloaded, or imported from a file) into the runtime root.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BUNDLE_DIR, log, validateBundle } from './runtime.mjs';

/**
 * macOS: the system bsdtar unpacks at native speed (it refuses `..` and absolute paths, keeps
 * modes and mtimes). The archive is streamed into its stdin, so the bytes read so far give real
 * progress.
 */
function extractTarGz(file, staging, report, signal) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(file).size;
    let done = 0;
    const tar = spawn('/usr/bin/tar', ['-xzf', '-', '-C', staging], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    tar.stderr.on('data', (chunk) => { stderr += chunk; });
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => {
      done += chunk.length;
      report(done, total);
    });
    input.on('error', (error) => { tar.kill(); reject(new Error(`打不开运行包：${error.message}`)); });
    tar.stdin.on('error', () => { /* tar exited early; its exit code says why */ });
    input.pipe(tar.stdin);
    // Quitting mid-unpack: left alone, tar waits for the rest of its input and the app never exits.
    signal?.addEventListener('abort', () => { input.destroy(); tar.kill(); }, { once: true });
    tar.on('error', (error) => reject(new Error(`解压运行包失败：${error.message}`)));
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压运行包失败：${stderr.trim() || `tar ${code}`}`));
    });
  });
}

/**
 * Windows bundles are zip archives (scripts/build_release.py). Creating ~13k small files is the
 * slow part on NTFS (W1 on a 4-thread runner: 16 s single-threaded, 8 s with 8 threads), so the
 * entries are split across worker threads (src/unzip-worker.cjs). Progress is entries extracted
 * out of all entries; only this thread reports, and the shared counter only grows.
 */
function extractZip(file, staging, report, signal) {
  const source = fs.readFileSync(fileURLToPath(new URL('./unzip-worker.cjs', import.meta.url)), 'utf8');
  const count = Math.min(Math.max(os.availableParallelism(), 1), 8);
  const counter = new SharedArrayBuffer(4);
  const done = new Int32Array(counter);
  let total = 0;
  let reported = -1;
  let reports = 0;
  const workers = Array.from({ length: count }, (_, index) => new Worker(source, {
    eval: true, workerData: { file, staging, index, count, counter },
  }));
  const tick = () => {
    const now = Atomics.load(done, 0);
    if (total && now !== reported) {
      reported = now;
      reports += 1;
      report(now, total);
    }
  };
  const timer = setInterval(tick, 50);
  signal?.addEventListener('abort', () => { for (const worker of workers) worker.terminate(); }, { once: true });
  const finished = workers.map((worker) => new Promise((resolve, reject) => {
    worker.on('message', (message) => { if (message.total) total = message.total; });
    worker.on('error', reject);
    worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压线程异常退出（${code}）`))));
  }));
  return Promise.all(finished)
    .catch((error) => {
      for (const worker of workers) worker.terminate();
      throw new Error(error.message.startsWith('运行包') ? error.message : `解压运行包失败：${error.message}`);
    })
    .finally(() => {
      clearInterval(timer);
      tick();
      log(`unpack progress: ${reports} reports, last ${reported}/${total}`);
    });
}

function extract(file, staging, report, signal) {
  return file.endsWith('.zip') ? extractZip(file, staging, report, signal) : extractTarGz(file, staging, report, signal);
}

/** Folders an earlier attempt left behind (the app quit or crashed while unpacking). */
function removeLeftovers(parent) {
  for (const name of fs.readdirSync(parent)) {
    if (name.startsWith('.staging-') || name.startsWith('.old-')) removeQuietly(path.join(parent, name));
  }
}

function removeQuietly(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

/**
 * (Re)creates `<parent>/GameAtelier` from a runtime archive. The new bundle is unpacked into a staging
 * folder and validated first; only then is the old root moved aside and the new one moved in.
 * If moving in fails, the old root is put back untouched.
 */
export async function unpackRuntime(parent, archive, report, signal) {
  const root = path.join(parent, BUNDLE_DIR);
  // Unique per attempt: a retry in the same process must not meet an earlier attempt's folders.
  const attempt = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.staging-${attempt}`);
  const aside = path.join(parent, `.old-${attempt}`);
  fs.mkdirSync(parent, { recursive: true });
  removeLeftovers(parent);
  fs.mkdirSync(staging, { recursive: true });
  const started = Date.now();
  try {
    await extract(archive.file, staging, report, signal);
    if (signal?.aborted) throw new Error('解压已取消');
    const extracted = path.join(staging, BUNDLE_DIR);
    validateBundle(extracted);
    log(`unpacked ${path.basename(archive.file)} in ${Date.now() - started} ms`);
    if (!fs.existsSync(root)) {
      fs.renameSync(extracted, root);
      return root;
    }
    fs.renameSync(root, aside);
    try {
      fs.renameSync(extracted, root);
    } catch (error) {
      fs.renameSync(aside, root);
      throw new Error(`安装运行包失败：${error.message}`);
    }
    removeQuietly(aside);
    return root;
  } finally {
    // Empty after a successful move; a failed attempt leaves a partial tree that must not linger.
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
