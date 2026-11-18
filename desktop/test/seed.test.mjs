import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readTrim, seedRecord } from '../src/runtime.mjs';
import { unpackSeed } from '../src/seed.mjs';

const tarGz = process.platform !== 'win32';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atelier-${name}-`));
}

/** A seed archive holding GameAtelier/ with one version; `complete: false` leaves out VERSION. */
function makeSeed(version, marker, { complete = true } = {}) {
  const dir = tmp('seedsrc');
  const payload = path.join(dir, 'GameAtelier', 'versions', version);
  fs.mkdirSync(path.join(payload, 'python', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'python', 'bin', 'python3'), '');
  if (complete) fs.writeFileSync(path.join(payload, 'VERSION'), `${version}\n`);
  fs.writeFileSync(path.join(payload, 'MARKER'), marker);
  fs.writeFileSync(path.join(dir, 'GameAtelier', 'last-good'), `${version}\n`);
  const file = path.join(dir, `GameAtelier-${version}-macos-arm64.tar.gz`);
  execFileSync('/usr/bin/tar', ['-czf', file, '-C', dir, 'GameAtelier']);
  return { file, version, build: marker, contract: 2 };
}

test('first start: unpacks, records the seed build, reports progress up to the archive size', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  const seed = makeSeed('5.139.0', 'one');
  const reports = [];
  const root = await unpackSeed(parent, seed, (done, total) => reports.push([done, total]));
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'one');
  assert.deepEqual(seedRecord(root), { version: '5.139.0', build: 'one' });
  const size = fs.statSync(seed.file).size;
  assert.ok(reports.length > 0);
  assert.deepEqual(reports.at(-1), [size, size]);
  assert.ok(reports.every(([done], i) => i === 0 || done >= reports[i - 1][0]));
});

test('replacement swaps the whole root', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  await unpackSeed(parent, makeSeed('5.139.0', 'one'), () => {});
  const root = await unpackSeed(parent, makeSeed('5.139.0', 'two'), () => {});
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'two');
  assert.deepEqual(seedRecord(root), { version: '5.139.0', build: 'two' });
});

test('an incomplete seed leaves the old runtime untouched', { skip: !tarGz }, async () => {
  const parent = tmp('parent');
  const root = await unpackSeed(parent, makeSeed('5.139.0', 'one'), () => {});
  await assert.rejects(unpackSeed(parent, makeSeed('5.140.0', 'bad', { complete: false }), () => {}));
  assert.equal(readTrim(path.join(root, 'versions', '5.139.0', 'MARKER')), 'one');
  assert.equal(readTrim(path.join(root, 'last-good')), '5.139.0');
});
