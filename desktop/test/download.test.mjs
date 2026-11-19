import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assetName, checkImported, DownloadError, downloadRuntime, plannedSources, readRelease,
} from '../src/download.mjs';

const RELEASE = readRelease(fileURLToPath(new URL('../../src/viewer_server/release_sources.json', import.meta.url)));
const VERSION = '0.5.140';
const PLATFORM = 'windows-x64';
const ASSET = assetName(RELEASE, VERSION, PLATFORM);
const ARCHIVE = Buffer.from(Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 251));
const SHA = createHash('sha256').update(ARCHIVE).digest('hex');
const PLENTY = { bavail: 1e9, bsize: 4096 };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-download-'));
}

/**
 * A release source on 127.0.0.1. `prefix` → { archive, checksum, status, ignoreRange, stall, failFirst }.
 * Every request is logged with its Range header.
 */
async function serve(sources) {
  const log = [];
  const failures = {};
  const server = http.createServer((req, res) => {
    const [, prefix, ...rest] = req.url.split('/');
    const source = sources[prefix];
    const file = rest.join('/');
    log.push({ prefix, file, range: req.headers.range || null });
    const expected = `download/v${VERSION}/${ASSET}`;
    if (!source || source.status === 404 || (file !== expected && file !== `${expected}.sha256`)) {
      res.writeHead(404).end();
      return;
    }
    const key = `${prefix}/${file}`;
    if (source.failFirst && (failures[key] = (failures[key] || 0) + 1) <= source.failFirst) {
      res.writeHead(503).end();
      return;
    }
    if (file.endsWith('.sha256')) {
      res.writeHead(200).end(`${source.checksum ?? SHA}  ${ASSET}\n`);
      return;
    }
    const body = source.archive ?? ARCHIVE;
    const match = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = match && !source.ignoreRange ? Number(match[1]) : 0;
    if (start) {
      res.writeHead(206, { 'content-length': body.length - start, 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` });
    } else {
      res.writeHead(200, { 'content-length': body.length });
    }
    // stall: 'always' sends 1000 bytes of every response and then nothing; 'once' only the first.
    if (source.stall === 'always' || (source.stall === 'once' && !source.stalled)) {
      source.stalled = true;
      res.write(body.subarray(start, start + 1000));
      return;
    }
    res.end(body.subarray(start));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    log,
    source: (prefix) => ({ id: prefix, base: `${base}/${prefix}`, proxy: 'direct' }),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

function options(dir, sources, extra = {}) {
  return {
    release: RELEASE, version: VERSION, platform: PLATFORM, sha256: SHA, dir, sources,
    fetchFor: () => fetch, statfs: () => PLENTY, retryDelays: [10, 10], stallMs: 2000, ...extra,
  };
}

test('downloads, verifies and leaves only the archive', async () => {
  const srv = await serve({ a: {} });
  try {
    const dir = tmp();
    const progress = [];
    const file = await downloadRuntime(options(dir, [srv.source('a')], { onProgress: (d, t) => progress.push([d, t]) }));
    assert.equal(path.basename(file), 'GameAtelier-0.5.140-windows-x64.zip');
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.deepEqual(fs.readdirSync(dir), [ASSET]);
    assert.deepEqual(progress.at(-1), [ARCHIVE.length, ARCHIVE.length]);
  } finally { await srv.close(); }
});

test('an interrupted download continues with a Range request and the whole file is hashed', async () => {
  const srv = await serve({ a: {} });
  try {
    const dir = tmp();
    const part = path.join(dir, `${ASSET}.part`);
    fs.writeFileSync(part, ARCHIVE.subarray(0, 120_000));
    fs.writeFileSync(`${part}.json`, JSON.stringify({ version: VERSION, sha256: SHA, source: 'a' }));
    const file = await downloadRuntime(options(dir, [srv.source('a')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.equal(srv.log.find((r) => r.file.endsWith('.zip')).range, 'bytes=120000-');
  } finally { await srv.close(); }
});

test('a resumed file that does not hash right is deleted, never kept half-done', async () => {
  const srv = await serve({ a: {} });
  try {
    const dir = tmp();
    const part = path.join(dir, `${ASSET}.part`);
    const corrupt = Buffer.from(ARCHIVE.subarray(0, 120_000));
    corrupt[10] ^= 0xff; // the part on disk was damaged; the rest arrives intact
    fs.writeFileSync(part, corrupt);
    fs.writeFileSync(`${part}.json`, JSON.stringify({ version: VERSION, sha256: SHA, source: 'a' }));
    await assert.rejects(downloadRuntime(options(dir, [srv.source('a')])), (e) => e.kind === 'checksum');
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { await srv.close(); }
});

test('a complete archive left by a quit before unpacking is reused, not fetched again', async () => {
  const srv = await serve({ a: {} });
  try {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, ASSET), ARCHIVE);
    const file = await downloadRuntime(options(dir, [srv.source('a')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.deepEqual(srv.log, [], 'no network at all');
  } finally { await srv.close(); }
});

test('a part recorded for another version or checksum starts over', async () => {
  const srv = await serve({ a: {} });
  try {
    const dir = tmp();
    const part = path.join(dir, `${ASSET}.part`);
    fs.writeFileSync(part, Buffer.alloc(5000, 1));
    fs.writeFileSync(`${part}.json`, JSON.stringify({ version: '0.5.139', sha256: SHA, source: 'a' }));
    const file = await downloadRuntime(options(dir, [srv.source('a')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.equal(srv.log.find((r) => r.file.endsWith('.zip')).range, null);
  } finally { await srv.close(); }
});

test('a source without the archive (404) hands over to the next one', async () => {
  const srv = await serve({ a: { status: 404 }, b: {} });
  try {
    const file = await downloadRuntime(options(tmp(), [srv.source('a'), srv.source('b')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.deepEqual(srv.log.filter((r) => r.prefix === 'a').length, 1, '404 is not retried');
  } finally { await srv.close(); }
});

test('5xx is retried on the same source', async () => {
  const srv = await serve({ a: { failFirst: 2 } });
  try {
    const file = await downloadRuntime(options(tmp(), [srv.source('a')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
  } finally { await srv.close(); }
});

test('sources whose checksum is not this build\'s are skipped without downloading', async () => {
  // An unreleased build: the published archive of the same version is a different one.
  const srv = await serve({ a: { checksum: '0'.repeat(64) }, b: { checksum: '1'.repeat(64) } });
  try {
    const dir = tmp();
    await assert.rejects(downloadRuntime(options(dir, [srv.source('a'), srv.source('b')])),
      (e) => e instanceof DownloadError && e.kind === 'checksum' && e.failures.length === 2);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('.json')), []);
    assert.ok(!srv.log.some((r) => r.file.endsWith('.zip')), 'the archive was never requested');
  } finally { await srv.close(); }
});

test('a source whose checksum cannot be read is skipped, never downloaded unchecked', async () => {
  const srv = await serve({ a: { failFirst: 99 }, b: {} });
  try {
    const file = await downloadRuntime(options(tmp(), [srv.source('a'), srv.source('b')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.ok(!srv.log.some((r) => r.prefix === 'a' && r.file.endsWith('.zip')));
  } finally { await srv.close(); }
});

test('the archive must hash to what the build recorded, whatever the source says', async () => {
  const other = Buffer.from(ARCHIVE);
  other[0] ^= 1;
  const otherSha = createHash('sha256').update(other).digest('hex');
  const srv = await serve({ a: { archive: other, checksum: otherSha } });
  try {
    const dir = tmp();
    await assert.rejects(downloadRuntime(options(dir, [srv.source('a')])), (e) => e.kind === 'checksum');
    assert.ok(!srv.log.some((r) => r.file.endsWith('.zip')), 'the source\'s own checksum is not trusted');
  } finally { await srv.close(); }
});

test('every source 404: the version is not published', async () => {
  const srv = await serve({ a: { status: 404 }, b: { status: 404 } });
  try {
    await assert.rejects(downloadRuntime(options(tmp(), [srv.source('a'), srv.source('b')])),
      (e) => e.kind === 'notfound' && e.message.includes(VERSION));
  } finally { await srv.close(); }
});

test('a connection that stalls once is resumed from where it stopped', async () => {
  const srv = await serve({ a: { stall: 'once' } });
  try {
    const file = await downloadRuntime(options(tmp(), [srv.source('a')], { stallMs: 200 }));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
    assert.equal(srv.log.filter((r) => r.file.endsWith('.zip')).at(-1).range, 'bytes=1000-');
  } finally { await srv.close(); }
});

test('a connection that keeps stalling fails as a network error and keeps what arrived', async () => {
  const srv = await serve({ a: { stall: 'always' } });
  try {
    const dir = tmp();
    await assert.rejects(downloadRuntime(options(dir, [srv.source('a')], { stallMs: 200 })), (e) => e.kind === 'network');
    assert.ok(fs.statSync(path.join(dir, `${ASSET}.part`)).size >= 1000);
  } finally { await srv.close(); }
});

test('not enough disk space stops before the archive is requested', async () => {
  const srv = await serve({ a: {} });
  try {
    await assert.rejects(
      downloadRuntime(options(tmp(), [srv.source('a')], { statfs: () => ({ bavail: 1000, bsize: 4096 }) })),
      (e) => e.kind === 'disk' && e.need > 0,
    );
    assert.ok(!srv.log.some((r) => r.file.endsWith('.zip')));
  } finally { await srv.close(); }
});

test('cancelling keeps the part; the next run finishes it', async () => {
  const srv = await serve({ a: { stall: 'always' } });
  try {
    const dir = tmp();
    const controller = new AbortController();
    const run = downloadRuntime(options(dir, [srv.source('a')], {
      signal: controller.signal, onProgress: () => controller.abort(),
    }));
    await assert.rejects(run, (e) => e.kind === 'cancelled');
    assert.ok(fs.existsSync(path.join(dir, `${ASSET}.part`)));
    await srv.close();
    const again = await serve({ a: {} });
    try {
      const file = await downloadRuntime(options(dir, [again.source('a')]));
      assert.deepEqual(fs.readFileSync(file), ARCHIVE);
      assert.match(again.log.find((r) => r.file.endsWith('.zip')).range, /^bytes=\d+-$/);
    } finally { await again.close(); }
  } finally { await srv.close().catch(() => {}); }
});

test('a source that ignores Range is downloaded again from the start', async () => {
  const srv = await serve({ a: { ignoreRange: true } });
  try {
    const dir = tmp();
    const part = path.join(dir, `${ASSET}.part`);
    fs.writeFileSync(part, ARCHIVE.subarray(0, 50_000));
    fs.writeFileSync(`${part}.json`, JSON.stringify({ version: VERSION, sha256: SHA, source: 'a' }));
    const file = await downloadRuntime(options(dir, [srv.source('a')]));
    assert.deepEqual(fs.readFileSync(file), ARCHIVE);
  } finally { await srv.close(); }
});

test('importing a file of another version is refused, naming the version needed', async () => {
  const dir = tmp();
  const other = path.join(dir, 'GameAtelier-0.5.139-windows-x64.zip');
  fs.writeFileSync(other, ARCHIVE);
  await assert.rejects(checkImported(other, { release: RELEASE, version: VERSION, platform: PLATFORM, sha256: SHA }),
    (e) => e.kind === 'version' && e.message === `需要 ${VERSION} 的运行包`);
});

test('importing a file that is not this build\'s runtime is refused, naming the version needed', async () => {
  const dir = tmp();
  const file = path.join(dir, ASSET);
  fs.writeFileSync(file, ARCHIVE);
  const ctx = { release: RELEASE, version: VERSION, platform: PLATFORM };
  await assert.rejects(checkImported(file, { ...ctx, sha256: '3'.repeat(64) }),
    (e) => e.kind === 'checksum' && e.message.includes(VERSION));
  assert.equal(await checkImported(file, { ...ctx, sha256: SHA }), file, 'no .sha256 beside it is needed');
});

test('source order: CNB direct, CNB through the system proxy, then GitHub; the test feed replaces them', () => {
  assert.deepEqual(plannedSources(RELEASE, {}).map((s) => `${s.id}:${s.proxy}`), ['cnb:direct', 'cnb:system', 'github:system']);
  const env = { GAME_ATELIER_TESTING: '1', GAME_ATELIER_TEST_UPDATE_FEED: 'http://127.0.0.1:1/a,http://127.0.0.1:1/b/' };
  assert.deepEqual(plannedSources(RELEASE, env).map((s) => s.base), ['http://127.0.0.1:1/a', 'http://127.0.0.1:1/b']);
  assert.equal(plannedSources(RELEASE, { GAME_ATELIER_TEST_UPDATE_FEED: 'http://127.0.0.1:1' })[0].id, 'cnb', 'needs GAME_ATELIER_TESTING');
  assert.throws(() => plannedSources(RELEASE, { GAME_ATELIER_TESTING: '1', GAME_ATELIER_TEST_UPDATE_FEED: 'https://evil.example' }));
});
