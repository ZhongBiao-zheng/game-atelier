import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compareVersions, contractLevel, DESKTOP_CONTRACT, meetsContract, readRuntimeInfo, replacementReason,
  uniqueDownloadPath, validVersion,
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

/** The runtime a shell was built with (stage/runtime.json). */
const shell = (version, build) => ({ version, build, file: 'x', sha256: 'f'.repeat(64) });

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

test('replacement: another version that declares the contract is kept, older or newer', () => {
  const ok = String(DESKTOP_CONTRACT);
  const root = bundle([['0.5.140', ok, 'a']], '0.5.140', '0.5.140');
  assert.equal(replacementReason(root, shell('0.5.141', 'b')), null, 'older than the shell: the in-app update moves it on');
  assert.equal(replacementReason(root, shell('0.5.139', 'b')), null, 'newer than the shell: never rolled back');
  // Across the version-line change: 5.x is older than any 0.x, still kept.
  const legacy = bundle([['5.139.0', ok, 'a']], '5.139.0', '5.139.0');
  assert.equal(replacementReason(legacy, shell('0.5.140', 'b')), null);
});
test('replacement: an in-app update in progress counts as the runtime version', () => {
  // current already names the version being switched to; last-good still names the old one.
  // Neither declares the contract, so the newer one decides between contract and too-old.
  const updating = bundle([['0.5.140', '1', 'a'], ['0.5.142', '1', 'u']], '0.5.142', '0.5.140');
  assert.equal(replacementReason(updating, shell('0.5.141', 'b')), 'too-old');
  assert.equal(replacementReason(updating, shell('0.5.142', 'b')), 'contract');
  // An unreadable current falls back to last-good.
  fs.writeFileSync(path.join(updating, 'current'), 'garbage\n');
  assert.equal(replacementReason(updating, shell('0.5.141', 'b')), 'contract');
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
  assert.equal(replacementReason(path.join(tmp('none'), 'GameAtelier'), shell('5.139.0', 'b')), 'missing');
  const broken = bundle([['5.139.0', '2', 'b']], '5.139.0', '5.139.0');
  fs.rmSync(path.join(broken, 'versions', '5.139.0', 'VERSION'));
  assert.equal(replacementReason(broken, shell('5.139.0', 'b')), 'missing');
});

test('replacement: a runtime without the contract is replaced unless the shell is older', () => {
  const old = bundle([['5.138.0', '1', null]], '5.138.0', '5.138.0');
  assert.equal(replacementReason(old, shell('5.139.0', 'b')), 'contract');
  assert.equal(replacementReason(old, shell('5.138.0', 'b')), 'contract');
  assert.equal(replacementReason(old, shell('5.137.0', 'b')), 'too-old');
});

test('replacement: the shell\'s version from another build is replaced, never run unnoticed', () => {
  const ok = String(DESKTOP_CONTRACT);
  const root = bundle([['5.139.0', ok, 'released']], '5.139.0', '5.139.0');
  assert.equal(replacementReason(root, shell('5.139.0', 'released')), null);
  assert.equal(replacementReason(root, shell('5.139.0', 'unreleased')), 'build');
  const unmarked = bundle([['5.139.0', ok, null]], '5.139.0', '5.139.0');
  assert.equal(replacementReason(unmarked, shell('5.139.0', 'released')), 'build', 'no BUILD_ID: cannot tell, replace');
});
test('replacement: an in-app update to the shell\'s version is the same build, kept', () => {
  const ok = String(DESKTOP_CONTRACT);
  // Updated in the app from 5.139.0 to the released 5.140.0, then the 5.140.0 installer installed.
  const updated = bundle([['5.139.0', ok, 'installed-5.139'], ['5.140.0', ok, 'released-5.140']], '5.140.0', '5.140.0');
  assert.equal(replacementReason(updated, shell('5.140.0', 'released-5.140')), null);
  assert.equal(replacementReason(updated, shell('5.139.0', 'released-5.139')), null, 'another version: kept');
});
test('the build\'s runtime description needs a version, a sha256 and a BUILD_ID', () => {
  const dir = tmp('info');
  const file = path.join(dir, 'runtime.json');
  assert.equal(readRuntimeInfo(file), null, 'missing file');
  const good = { version: '5.139.0', file: 'GameAtelier-5.139.0-macos-arm64.tar.gz', sha256: 'a'.repeat(64), build: 'b', contract: 2 };
  fs.writeFileSync(file, JSON.stringify(good));
  assert.deepEqual(readRuntimeInfo(file), { version: '5.139.0', file: good.file, sha256: good.sha256, build: 'b' });
  for (const broken of [{ version: '5.139' }, { sha256: 'abc' }, { sha256: 'A'.repeat(64) }, { build: '' }, { file: '' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...good, ...broken }));
    assert.equal(readRuntimeInfo(file), null, JSON.stringify(broken));
  }
});
test('downloads never overwrite', () => {
  const dir = tmp('dl');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a.png'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'a (1).png'), 'x');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a (2).png'));
  assert.equal(uniqueDownloadPath(dir, '../escape.png'), path.join(dir, 'escape.png'));
});
