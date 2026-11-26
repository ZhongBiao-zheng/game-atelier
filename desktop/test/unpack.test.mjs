import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { readTrim } from '../src/runtime.mjs';
import { unpackRuntime } from '../src/unpack.mjs';

const tarGz = process.platform !== 'win32';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atelier-${name}-`));
}

/** A runtime archive holding GameAtelier/ with one version; `complete: false` leaves out VERSION. */
function makeArchive(version, marker, { complete = true } = {}) {
  const dir = tmp('archivesrc');
  const payload = path.join(dir, 'GameAtelier', 'versions', version);
  fs.mkdirSync(path.join(payload, 'python', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'python', 'bin', 'python3'), '');
  fs.mkdirSync(path.join(payload, 'app', 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'app', 'scripts', 'bootstrap.py'), '');
  if (complete) fs.writeFileSync(path.join(payload, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(payload, 'MARKER'), marker);
  fs.writeFileSync(path.join(dir, 'GameAtelier', 'last-good'), `${version}\n`);
  const file = path.join(dir, `GameAtelier-${version}-macos-arm64.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', file, '-C', dir, 'GameAtelier']);
  return { file, version, build: marker, contract: 2 };
}

test('first start: unpacks and reports progress up to the archive size', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  const archive = makeArchive('5.139.0', 'one');
  const reports = [];
  const root = await unpackRuntime(parent, archive, (done, total) => reports.push([done, total]));
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'one');
  const size = fs.statSync(archive.file).size;
  assert.ok(reports.length > 0);
  assert.deepEqual(reports.at(-1), [size, size]);
  assert.ok(reports.every(([done], i) => i === 0 || done >= reports[i - 1][0]));
});

test('replacement swaps the whole root', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  await unpackRuntime(parent, makeArchive('5.139.0', 'one'), () => {});
  const root = await unpackRuntime(parent, makeArchive('5.139.0', 'two'), () => {});
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'two');
});

/** Minimal zip writer (deflate), enough for build_release.py-shaped archives. */
function writeZip(file, entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, content] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = content === null ? Buffer.alloc(0) : Buffer.from(content);
    const packed = content === null ? data : zlib.deflateRawSync(data);
    const method = content === null ? 0 : 8;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed); centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...locals, directory, end]));
}

function makeZipArchive(version, marker, extra = []) {
  const file = path.join(tmp('zipsrc'), `GameAtelier-${version}-windows-x64.zip`);
  const base = `GameAtelier/versions/${version}/`;
  writeZip(file, [
    ['GameAtelier/', null], ['GameAtelier/last-good', `${version}\n`],
    [`${base}VERSION`, `${version}\n`], [`${base}MARKER`, marker], [`${base}数据.txt`, '中文路径'],
    [`${base}app/scripts/bootstrap.py`, ''], [`${base}python/bin/python3`, ''], [`${base}python/python.exe`, ''],
    ...Array.from({ length: 40 }, (_, i) => [`${base}app/src/m${i}.py`, `x = ${i}\n`.repeat(50)]),
    ...extra,
  ]);
  return { file, version, build: marker, contract: 2 };
}

test('zip archives unpack in parallel with entry-count progress', async () => {
  const parent = tmp('parent');
  const reports = [];
  const root = await unpackRuntime(parent, makeZipArchive('5.139.0', 'zip-one'), (done, total) => reports.push([done, total]));
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'zip-one');
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', '数据.txt')), '中文路径');
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'app', 'src', 'm39.py')).split('\n').length, 50);
  const [last, total] = reports.at(-1);
  assert.equal(total, 48);
  assert.equal(last, total);
  assert.ok(reports.every(([done], i) => i === 0 || done >= reports[i - 1][0]));
});

test('a zip entry escaping the folder is refused and the old runtime stays', async () => {
  const parent = tmp('parent');
  const root = await unpackRuntime(parent, makeZipArchive('5.139.0', 'zip-one'), () => {});
  await assert.rejects(unpackRuntime(parent, makeZipArchive('5.139.0', 'evil', [['../outside.txt', 'x']]), () => {}), /越界/);
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'zip-one');
  assert.ok(!fs.existsSync(path.join(parent, '..', 'outside.txt')));
});

test('an incomplete archive leaves the old runtime untouched', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  const root = await unpackRuntime(parent, makeArchive('5.139.0', 'one'), () => {});
  await assert.rejects(unpackRuntime(parent, makeArchive('5.140.0', 'bad', { complete: false }), () => {}));
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'one');
  assert.equal(readTrim(path.join(root, 'last-good')), '5.139.0');
});

test('quitting mid-unpack stops it and leaves the old runtime untouched', async () => {
  const parent = tmp('parent');
  const root = await unpackRuntime(parent, makeZipArchive('5.139.0', 'zip-one'), () => {});
  const controller = new AbortController();
  const next = makeZipArchive('5.139.0', 'zip-two', Array.from({ length: 400 }, (_, i) => [`GameAtelier/versions/5.139.0/extra/${i}.txt`, 'x'.repeat(2000)]));
  const run = unpackRuntime(parent, next, () => controller.abort(), controller.signal);
  await assert.rejects(run);
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'zip-one');
  assert.deepEqual(fs.readdirSync(parent).filter((name) => name.startsWith('.staging-')), []);
});

test('quitting mid-unpack of a tar.gz rejects and leaves no runtime behind', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  const controller = new AbortController();
  const run = unpackRuntime(parent, makeArchive('5.139.0', 'one'), () => controller.abort(), controller.signal);
  await assert.rejects(run);
  assert.ok(!fs.existsSync(path.join(parent, 'GameAtelier')));
});

test('folders left by an interrupted earlier attempt are cleared', async () => {
  const parent = tmp('parent');
  fs.mkdirSync(path.join(parent, '.staging-1-2', 'GameAtelier'), { recursive: true });
  fs.mkdirSync(path.join(parent, '.old-1-2'));
  await unpackRuntime(parent, makeZipArchive('5.139.0', 'zip-one'), () => {});
  await new Promise((resolve) => { setTimeout(resolve, 200); });
  assert.deepEqual(fs.readdirSync(parent).sort(), ['GameAtelier']);
});
