import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  compareVersions, contractLevel, DESKTOP_CONTRACT, meetsContract, readRuntimeInfo,
  imageFileName, repairBundlePointers, replacementReason, uniqueDownloadPath, validVersion,
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
    fs.mkdirSync(path.join(payload, 'app', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(payload, 'app', 'scripts', 'bootstrap.py'), '');
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
test('repairBundlePointers recovers truncated last-good from current or highest valid version', () => {
  const ok = String(DESKTOP_CONTRACT);
  const root = bundle([['5.138.0', ok, 'old'], ['5.142.0', ok, 'new']], '5.142.0', '5.142.0');
  // Simulate abrupt shutdown leaving a 0-byte last-good file.
  fs.writeFileSync(path.join(root, 'last-good'), '');
  assert.equal(repairBundlePointers(root), '5.142.0');
  assert.equal(fs.readFileSync(path.join(root, 'last-good'), 'utf8').trim(), '5.142.0');
  assert.equal(replacementReason(root, shell('5.138.0', 'old')), null);

  // Both last-good and current corrupted: recover from versions/ highest valid version.
  fs.writeFileSync(path.join(root, 'last-good'), '');
  fs.writeFileSync(path.join(root, 'current'), '');
  assert.equal(repairBundlePointers(root), '5.142.0');
  assert.equal(fs.readFileSync(path.join(root, 'last-good'), 'utf8').trim(), '5.142.0');
  assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8').trim(), '5.142.0');
});

test('recovery skips incomplete, incompatible, blocked and staged candidates', () => {
  const root = bundle([
    ['5.138.0', '2', 'old'], ['5.139.0', '2', 'blocked'], ['5.140.0', '2', 'ready'],
    ['5.141.0', '1', 'incompatible'], ['5.142.0', '2', 'incomplete'],
  ], '5.141.0', '');
  fs.rmSync(path.join(root, 'versions', '5.142.0', 'app', 'scripts', 'bootstrap.py'));
  fs.mkdirSync(path.join(root, 'updates'));
  fs.writeFileSync(path.join(root, 'updates', 'state.json'), JSON.stringify({ status: 'ready', to: '5.140.0' }));
  fs.writeFileSync(path.join(root, 'updates', 'blocked.json'), JSON.stringify({ '5.139.0': 'failed' }));
  assert.equal(repairBundlePointers(root), '5.138.0');
  assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8').trim(), '5.138.0');
});

test('recovery rejects a bootstrap outside its payload', { skip: process.platform === 'win32' }, () => {
  const root = bundle([['5.138.0', '2', 'old'], ['5.142.0', '2', 'new']], '5.142.0', '');
  const entry = (v) => path.join(root, 'versions', v, 'app', 'scripts', 'bootstrap.py');
  fs.rmSync(entry('5.142.0'));
  fs.symlinkSync(entry('5.138.0'), entry('5.142.0'));
  assert.equal(repairBundlePointers(root), '5.138.0');
});

test('a damaged transaction cannot select a candidate or fall back to reinstalling', () => {
  const root = bundle([['5.142.0', '2', 'new']], '5.142.0', '');
  fs.mkdirSync(path.join(root, 'updates'));
  const file = path.join(root, 'updates', 'pending.json');
  for (const text of ['{', JSON.stringify({ from: '5.138.0', to: '5.142.0', update_id: 'a'.repeat(32) })]) {
    fs.writeFileSync(file, text);
    assert.throws(() => repairBundlePointers(root), /更新事务/);
    assert.equal(fs.readFileSync(path.join(root, 'last-good'), 'utf8').trim(), '');
  }
});

test('an interrupted transaction recovers its source only after the executor releases its lock', { skip: process.platform === 'win32' }, async () => {
  const root = bundle([['5.138.0', '2', 'old'], ['5.142.0', '2', 'new']], '5.142.0', '');
  fs.mkdirSync(path.join(root, 'updates'));
  const transaction = { from: '5.138.0', to: '5.142.0', update_id: 'a'.repeat(32), phase: 'restarting' };
  fs.writeFileSync(path.join(root, 'updates', 'pending.json'), JSON.stringify(transaction));
  const payload = path.join(root, 'versions', transaction.from);
  const app = path.join(payload, 'app');
  fs.copyFileSync(new URL('../../scripts/bootstrap.py', import.meta.url), path.join(app, 'scripts/bootstrap.py'));
  const lib = path.join(app, 'src', 'character_workflow', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const name of ['atomic_io.py', 'file_lock.py']) {
    fs.copyFileSync(new URL(`../../src/character_workflow/lib/${name}`, import.meta.url), path.join(lib, name));
  }
  // Use the host Python for this fixture while the launcher's interpreter stays inside its payload.
  const python = path.join(payload, 'python/bin/python3');
  fs.writeFileSync(python, '#!/bin/sh\nexport GAME_ATELIER_DATA_ROOT="$(dirname "$0")/test-data"\nexec python3 "$@"\n');
  fs.chmodSync(python, 0o755);
  const runtime = path.join(path.dirname(python), 'test-data', '.runtime');
  fs.mkdirSync(runtime, { recursive: true });
  const executor = spawn('python3', ['-c', [
    'import fcntl, sys',
    'with open(sys.argv[1], "a+") as lock:',
    '    fcntl.flock(lock, fcntl.LOCK_EX)',
    '    print("locked", flush=True)',
    '    sys.stdin.read()',
  ].join('\n'), path.join(runtime, 'update.lock')]);
  const exit = once(executor, 'exit');
  try {
    await once(executor.stdout, 'data');
    assert.throws(() => repairBundlePointers(root));
    assert.equal(fs.readFileSync(path.join(root, 'last-good'), 'utf8').trim(), '');
  } finally {
    executor.stdin.end();
    await exit;
  }
  assert.equal(repairBundlePointers(root), '5.138.0');
  assert.equal(fs.readFileSync(path.join(root, 'current'), 'utf8').trim(), '5.142.0');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'updates/pending.json'))), transaction);
});

test('downloads never overwrite', () => {
  const dir = tmp('dl');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a.png'));
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'a (1).png'), 'x');
  assert.equal(uniqueDownloadPath(dir, 'a.png'), path.join(dir, 'a (2).png'));
  assert.equal(uniqueDownloadPath(dir, '../escape.png'), path.join(dir, 'escape.png'));
});

test('save-as names come from the image URL without any directory', () => {
  const raw = 'http://127.0.0.1:5174/api/raw?path=%2FUsers%2Fa%2Fgame-atelier%2Fstudio%2Fout%2Fcat.png&job_id=j1';
  assert.equal(imageFileName(raw, 'raw.png'), 'cat.png');
  assert.equal(imageFileName('http://127.0.0.1:5174/api/gallery/image?path=C%3A%5Cdata%5Cdog.webp', 'image.webp'), 'dog.webp');
  assert.equal(imageFileName('http://127.0.0.1:5174/static/%E5%9B%BE.jpg', 'x.jpg'), '图.jpg');
  // No extension in the URL (canvas media): the browser's name for the download, which has one.
  assert.equal(imageFileName('http://127.0.0.1:5174/api/canvas/projects/p/versions/v/media', 'media.png'), 'media.png');
  assert.equal(imageFileName('blob:http://127.0.0.1:5174/1234', 'C:\\Users\\a\\b.png'), 'b.png');
  assert.equal(imageFileName('data:image/png;base64,AAAA', ''), 'image.png');
  assert.equal(imageFileName('http://127.0.0.1:5174/a%E0%A4%A', ''), 'image.png');
});
