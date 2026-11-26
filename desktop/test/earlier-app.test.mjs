import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { bundleOf, bundlesToNotice, earlierBundles, markNoticed } from '../src/earlier-app.mjs';

const EXE = '/Applications/Cobrush.app/Contents/MacOS/Cobrush';
const HOME = '/Users/a';

test('the running bundle is found from its executable', () => {
  assert.equal(bundleOf(EXE), '/Applications/Cobrush.app');
  assert.equal(bundleOf('/usr/local/bin/electron'), null);
});

test('an old Atelier.app in either Applications folder is found', () => {
  const present = new Set(['/Applications/Atelier.app', '/Users/a/Applications/Atelier.app']);
  const exists = (p) => present.has(p);
  assert.deepEqual(earlierBundles({ name: 'Cobrush', exe: EXE, home: HOME, exists }), [...present]);
  assert.deepEqual(earlierBundles({ name: 'Cobrush', exe: EXE, home: HOME, exists: () => false }), []);
});

test('the old name running itself never points at itself', () => {
  const exe = '/Applications/Atelier.app/Contents/MacOS/Atelier';
  assert.deepEqual(earlierBundles({ name: 'Atelier', exe, home: HOME, exists: () => true }), []);
});

test('each old bundle is pointed out once', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-earlier-'));
  const where = { userData, name: 'Cobrush', exe: EXE, home: HOME, exists: (p) => p === '/Applications/Atelier.app' };
  assert.deepEqual(bundlesToNotice(where), ['/Applications/Atelier.app']);
  markNoticed(userData, ['/Applications/Atelier.app']);
  assert.deepEqual(bundlesToNotice(where), []);
  fs.rmSync(userData, { recursive: true, force: true });
});
