import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { allowedNavigation, externalAllowed, isServerUrl, trustedSender } from '../src/security.mjs';

const LOCAL = path.resolve('/Applications/Atelier.app/Contents/Resources/app.asar/ui/index.html');
const localUrl = (query = '') => `${pathToFileURL(LOCAL)}${query}`;
const SERVER = 'http://127.0.0.1:5174';

test('only the loopback Atelier page and the bundled page are navigable', () => {
  assert.ok(isServerUrl(`${SERVER}/canvas`));
  assert.ok(allowedNavigation(`${SERVER}/`, LOCAL));
  assert.ok(allowedNavigation(localUrl('?error=start&name=Atelier'), LOCAL));
  for (const url of [
    'http://localhost:5174/', 'https://127.0.0.1:5174/', 'http://127.0.0.1/', 'http://127.0.0.2:5174/',
    'https://example.com/', `${pathToFileURL('/etc/passwd')}`, 'data:text/html,x', 'javascript:alert(1)', 'about:blank',
  ]) {
    assert.ok(!allowedNavigation(url, LOCAL), url);
  }
});

test('only web and mail links go to the system browser', () => {
  assert.ok(externalAllowed('https://example.com/'));
  assert.ok(externalAllowed('mailto:a@example.com'));
  assert.ok(!externalAllowed('file:///etc/passwd'));
  assert.ok(!externalAllowed('smb://host/share'));
  assert.ok(!externalAllowed('not a url'));
});

test('IPC is trusted only from the main frame showing the expected page', () => {
  const mainFrame = { url: `${SERVER}/studio` };
  const context = { serverOrigin: SERVER, localPagePath: LOCAL };
  assert.ok(trustedSender(mainFrame, mainFrame, 'page', context));
  // A plugin iframe (srcdoc, opaque origin) is never the main frame.
  const iframe = { url: 'about:srcdoc' };
  assert.ok(!trustedSender(iframe, mainFrame, 'page', context));
  // Another port (an older instance, another local service) or host.
  for (const url of ['http://127.0.0.1:5175/', 'http://localhost:5174/', 'https://example.com/']) {
    const frame = { url };
    assert.ok(!trustedSender(frame, frame, 'page', context), url);
  }
  // No server shown yet: page channels are closed.
  assert.ok(!trustedSender(mainFrame, mainFrame, 'page', { ...context, serverOrigin: null }));
  // The server page cannot use the loading page's channels, and the other way round.
  assert.ok(!trustedSender(mainFrame, mainFrame, 'local', context));
  const loading = { url: localUrl('?stage=first') };
  assert.ok(trustedSender(loading, loading, 'local', context));
  assert.ok(!trustedSender(loading, loading, 'page', context));
  const otherFile = { url: `${pathToFileURL('/tmp/index.html')}` };
  assert.ok(!trustedSender(otherFile, otherFile, 'local', context));
  assert.ok(!trustedSender(null, mainFrame, 'page', context));
  assert.ok(!trustedSender(mainFrame, mainFrame, 'other', context));
});
