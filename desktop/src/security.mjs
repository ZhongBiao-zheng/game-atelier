// Which pages the shell trusts (docs/contracts/desktop-shell.md, 「窗口与页面」). Pure functions,
// covered by desktop/test/security.test.mjs.
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function parse(url) {
  try { return new URL(url); } catch { return null; }
}

/** The Atelier page: plain HTTP on the loopback address, any port. */
export function isServerUrl(url) {
  const u = parse(url);
  return Boolean(u && u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port !== '');
}

/** The bundled loading / error page, whatever its query. */
export function isLocalPage(url, localPagePath) {
  const u = parse(url);
  if (!u || u.protocol !== 'file:') return false;
  try {
    return path.resolve(fileURLToPath(u)) === path.resolve(localPagePath);
  } catch {
    return false;
  }
}

/** The main frame may only show the bundled page or an Atelier server page. */
export function allowedNavigation(url, localPagePath) {
  return isServerUrl(url) || isLocalPage(url, localPagePath);
}

/** What may be handed to the system browser; everything else is only logged. */
export function externalAllowed(url) {
  const u = parse(url);
  return Boolean(u && ['http:', 'https:', 'mailto:'].includes(u.protocol));
}

/**
 * Every IPC message is checked here first. `frame` is `event.senderFrame`; it must be the
 * window's main frame (never a plugin iframe) and show the expected page: the server the shell is
 * currently showing (`page` channels) or the bundled page (`local` channels).
 */
export function trustedSender(frame, mainFrame, kind, { serverOrigin, localPagePath }) {
  if (!frame || !mainFrame || frame !== mainFrame) return false;
  if (kind === 'page') {
    const u = parse(frame.url);
    return Boolean(serverOrigin && u && isServerUrl(frame.url) && u.origin === serverOrigin);
  }
  if (kind === 'local') return isLocalPage(frame.url, localPagePath);
  return false;
}
