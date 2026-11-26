// Runs in the main frame only (nodeIntegrationInSubFrames is off), sandboxed, before the page's
// own scripts. docs/contracts/desktop-shell.md: the Atelier page gets `window.atelierShell`, the
// bundled loading page gets `window.atelierLoading`, every other page gets nothing. The main
// process checks every message again (src/security.mjs `trustedSender`).
const { contextBridge, ipcRenderer } = require('electron');

const { protocol, hostname, pathname } = window.location;

if (protocol === 'http:' && hostname === '127.0.0.1') {
  const overlay = process.argv.includes('--atelier-titlebar=overlay');
  const mark = () => {
    const root = document.documentElement;
    root.dataset.shell = process.platform === 'darwin' ? 'macos' : 'windows';
    if (overlay) root.dataset.titlebar = 'overlay';
  };
  // <html> may not exist yet; mark it the moment it is inserted, before the first paint.
  if (document.documentElement) {
    mark();
  } else {
    new MutationObserver((_, observer) => {
      if (!document.documentElement) return;
      observer.disconnect();
      mark();
    }).observe(document, { childList: true });
  }
  contextBridge.exposeInMainWorld('atelierShell', {
    setTheme: (theme) => ipcRenderer.send('atelier:set-theme', theme === 'light' ? 'light' : 'dark'),
    openLog: () => ipcRenderer.send('atelier:page-open-log'),
    showDownload: (id) => ipcRenderer.send('atelier:show-download', String(id)),
  });
} else if (protocol === 'file:' && pathname.endsWith('/ui/index.html')) {
  contextBridge.exposeInMainWorld('atelierLoading', {
    retry: () => ipcRenderer.send('atelier:retry'),
    openLog: () => ipcRenderer.send('atelier:open-log'),
    cancel: () => ipcRenderer.send('atelier:cancel'),
    resume: () => ipcRenderer.send('atelier:resume'),
    importFile: () => ipcRenderer.send('atelier:import'),
  });
}
