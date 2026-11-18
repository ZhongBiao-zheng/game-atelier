import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compareVersions, contractLevel, DESKTOP_CONTRACT, meetsContract, readSeed, replacementReason,
  uniqueDownloadPath, validVersion, writeSeedRecord,
} from '../src/runtime.mjs';

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atelier-${name}-`));
}

/** A runtime root with the given versions: [version, contract level or null, build id or null]. */
function bundle(versions, current, lastGood) {
  const root = tmp('bundle');
  for (const [version, level, build] of versions) {
    const payload = path.join(root, 'versions', version);
    fs.mkdirSync(path.join(payload, 'python', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'python', 'bin', 'python3'), '');
    fs.writeFileSync(path.join(payload, 'python', 'python.exe'), '');
    fs.writeFileSync(path.join(payload, 'VERSION'), `${version}\n`);
    if (level !== null) fs.writeFileSync(path.join(payload, 'DESKTOP_CONTRACT'), `${level}\n`);
    if (build !== null) fs.writeFileSync(path.join(payload, 'BUILD_ID'), `${build}\n`);
  }
  fs.writeFileSync(path.join(root, 'current'), `${current}\n`);
  fs.writeFileSync(path.join(root, 'last-good'), `${lastGood}\n`);
  return root;
}

const seed = (version, build) => ({ file: 'x', version, build, contract: DESKTOP_CONTRACT });

test('version rules match the bundle layout', () => {
  assert.ok(validVersion('5.138.0'));
  assert.ok(!validVersion('5.138'));
  assert.ok(!validVersion('5.138.0-rc1'));
  assert.ok(!validVersion('../1.2.3'));
  assert.equal(compareVersions('5.139.0', '5.138.9'), 1);
  assert.equal(compareVersions('5.10.0', '5.9.0'), 1);
  assert.equal(compareVersions('5.138.0', '5.138.0'), 0);
  // bootstrap.version_key: the retired 5.x line sorts before 0.x.
  assert.equal(compareVersions('5.139.0', '0.5.140'), -1);
  assert.equal(compareVersions('0.5.10', '0.5.9'), 1);
});

test('replacement: a runtime older than the seed is replaced, never one at or above it', () => {
  const ok = String(DESKTOP_CONTRACT);
  const root = bundle([['0.5.140', ok, 'a']], '0.5.140', '0.5.140');
  assert.equal(replacementReason(root, seed('0.5.141', 'b')), 'older');
  assert.equal(replacementReason(root, seed('0.5.140', 'b')), null);
  assert.equal(replacementReason(root, seed('0.5.139', 'b')), null);
  // Across the version-line change: 5.x is older than any 0.x.
  const legacy = bundle([['5.139.0', ok, 'a']], '5.139.0', '5.139.0');
  assert.equal(replacementReason(legacy, seed('0.5.140', 'b')), 'older');
  assert.equal(replacementReason(root, seed('5.139.0', 'b')), null);
});

test('replacement: an in-app update in progress counts as the runtime version', () => {
  const ok = String(DESKTOP_CONTRACT);
  // current already names the version being switched to; last-good still names the old one.
  const updating = bundle([['0.5.140', ok, 'a'], ['0.5.142', ok, 'u']], '0.5.142', '0.5.140');
  assert.equal(replacementReason(updating, seed('0.5.141', 'b')), null);
  assert.equal(replacementReason(updating, seed('0.5.143', 'b')), 'older');
  // An unreadable current falls back to last-good.
  fs.writeFileSync(path.join(updating, 'current'), 'garbage\n');
  assert.equal(replacementReason(updating, seed('0.5.141', 'b')), 'older');
});

test('contract levels: plain integers only, anything else is 0', () => {
  assert.equal(contractLevel('2\n'), 2);
  assert.equal(contractLevel('one'), 0);
  assert.equal(contractLevel('2.5'), 0);
  assert.equal(contractLevel(null), 0);
});

test('the runtime declares the contract, not its version', () => {
  const ok = String(DESKTOP_CONTRACT);
  assert.ok(!meetsContract(bundle([['5.138.0', null, 'a']], '5.138.0', '5.138.0')));
  assert.ok(!meetsContract(bundle([['5.138.0', '1', 'a']], '5.138.0', '5.138.0')));
  assert.ok(meetsContract(bundle([['5.138.0', ok, 'a']], '5.138.0', '5.138.0')));
  // last-good runs bootstrap.py, current serves the page: both must declare it.
  assert.ok(!meetsContract(bundle([['5.138.0', null, 'a'], ['5.139.0', ok, 'b']], '5.139.0', '5.138.0')));
});

test('replacement: missing or incomplete runtime', () => {
  assert.equal(replacementReason(path.join(tmp('none'), 'GameAtelier'), seed('5.139.0', 'b')), 'missing');
  const broken = bundle([['5.139.0', '2', 'b']], '5.139.0', '5.139.0');
  fs.rmSync(path.join(broken, 'versions', '5.139.0', 'VERSION'));
  assert.equal(replacementReason(broken, seed('5.139.0', 'b')), 'missing');
});

test('replacement: a runtime without the contract is replaced unless the seed is older', () => {
  const old = bundle([['5.138.0', '1', null]], '5.138.0', '5.138.0');
  assert.equal(replacementReason(old, seed('5.139.0', 'b')), 'contract');
  assert.equal(replacementReason(old, seed('5.138.0', 'b')), 'contract');
  assert.equal(replacementReason(old, seed('5.137.0', 'b')), 'too-old');
});

test('replacement: same version, unpacked from a different seed build', () => {
  const ok = String(DESKTOP_CONTRACT);
  const root = bundle([['5.139.0', ok, 'first']], '5.139.0', '5.139.0');
  writeSeedRecord(root, seed('5.139.0', 'first'));
  assert.equal(replacementReason(root, seed('5.139.0', 'first')), null);
  assert.equal(replacementReason(root, seed('5.139.0', 'second')), 'build');
});

test('replacement: versions the seed did not unpack are kept', () => {
  const ok = String(DESKTOP_CONTRACT);
  // In-app update to a newer version: the record names the older seed version.
  const updated = bundle([['5.139.0', ok, 'seed'], ['5.140.0', ok, 'update']], '5.140.0', '5.140.0');
  writeSeedRecord(updated, seed('5.139.0', 'seed'));
  assert.equal(replacementReason(updated, seed('5.140.0', 'other')), null);
  assert.equal(replacementReason(updated, seed('5.139.0', 'other')), null);
  // No record (unpacked by something else): never replaced for a build difference.
  const unknown = bundle([['5.139.0', ok, 'x']], '5.139.0', '5.139.0');
  assert.equal(replacementReason(unknown, seed('5.139.0', 'y')), null);
  // The record no longer matches the directory (rewritten since): keep it.
  const rewritten = bundle([['5.139.0', ok, 'later']], '5.139.0', '5.139.0');
  writeSeedRecord(rewritten, seed('5.139.0', 'first'));
  assert.equal(replacementReason(rewritten, seed('5.139.0', 'third')), null);
});

test('the seed description must name an existing archive', () => {
  const dir = tmp('seed');
  assert.equal(readSeed(dir), null);
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify({ file: 'GameAtelier-5.139.0-macos-arm64.tar.gz', version: '5.139.0', build: 'b', contract: 2 }));
  assert.equal(readSeed(dir), null);
  fs.writeFileSync(path.join(dir, 'GameAtelier-5.139.0-macos-arm64.tar.gz'), '');
  assert.deepEqual(readSeed(dir), {
    file: path.join(dir, 'GameAtelier-5.139.0-macos-arm64.tar.gz'), version: '5.139.0', build: 'b', contract: 2,
  });
  fs.writeFileSync(path.join(dir, 'seed.json'), JSON.stringify({ file: '../../etc/x', version: '5.139.0' }));
  assert.equal(readSeed(dir), null);
});

test('downloads never overwrite', () => {
  const dir = tmp('dl');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a.png'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'a (1).png'), 'x');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a (2).png'));
  assert.equal(uniqueDownloadPath(dir, '../escape.png'), path.join(dir, 'escape.png'));
});
