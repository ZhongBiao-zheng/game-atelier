// Unpacking the seed bundle that ships inside the installer into the runtime root.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BUNDLE_DIR, log, validateBundle, writeSeedRecord } from './runtime.mjs';

/**
 * macOS: the system bsdtar unpacks at native speed (it refuses `..` and absolute paths, keeps
 * modes and mtimes). The archive is streamed into its stdin, so the bytes read so far give real
 * progress.
 */
function extractTarGz(seed, staging, report) {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(seed).size;
    let done = 0;
    const tar = spawn('/usr/bin/tar', ['-xzf', '-', '-C', staging], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    tar.stderr.on('data', (chunk) => { stderr += chunk; });
    const input = fs.createReadStream(seed);
    input.on('data', (chunk) => {
      done += chunk.length;
      report(done, total);
    });
    input.on('error', (error) => { tar.kill(); reject(new Error(`打不开运行包：${error.message}`)); });
    tar.stdin.on('error', () => { /* tar exited early; its exit code says why */ });
    input.pipe(tar.stdin);
    tar.on('error', (error) => reject(new Error(`解压运行包失败：${error.message}`)));
    tar.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压运行包失败：${stderr.trim() || `tar ${code}`}`));
    });
  });
}

function extract(seed, staging, report) {
  if (process.platform === 'win32') {
    // Batch 3 (docs/contracts/desktop-shell.md): multi-threaded zip extraction.
    return Promise.reject(new Error('Windows 解压尚未实现'));
  }
  return extractTarGz(seed, staging, report);
}

function removeQuietly(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

/**
 * (Re)creates `<parent>/GameAtelier` from the seed. The new bundle is unpacked into a staging
 * folder and validated first; only then is the old root moved aside and the new one moved in.
 * If moving in fails, the old root is put back untouched.
 */
export async function unpackSeed(parent, seed, report) {
  const root = path.join(parent, BUNDLE_DIR);
  // Unique per attempt: a retry in the same process must not meet an earlier attempt's folders.
  const attempt = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `.staging-${attempt}`);
  const aside = path.join(parent, `.old-${attempt}`);
  fs.mkdirSync(staging, { recursive: true });
  const started = Date.now();
  try {
    await extract(seed.file, staging, report);
    const extracted = path.join(staging, BUNDLE_DIR);
    validateBundle(extracted);
    writeSeedRecord(extracted, seed);
    log(`unpacked ${path.basename(seed.file)} in ${Date.now() - started} ms`);
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
