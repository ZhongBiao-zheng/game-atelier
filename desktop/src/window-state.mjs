// Window size, position and maximised state across launches.
import fs from 'node:fs';
import path from 'node:path';

const FILE = 'window-state.json';
const MIN = { width: 1024, height: 640 };

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** First run: 1440×900, or 85 % of a smaller screen, centred. Later runs: the saved bounds while
 * they still overlap a connected display. */
export function initialBounds(parent, screen) {
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(parent, FILE), 'utf8'));
    const bounds = {
      x: Math.round(saved.x), y: Math.round(saved.y),
      width: Math.max(MIN.width, Math.round(saved.width)), height: Math.max(MIN.height, Math.round(saved.height)),
    };
    const visible = Object.values(bounds).every(Number.isFinite)
      && screen.getAllDisplays().some((d) => intersects(bounds, d.workArea));
    if (visible) return { bounds, maximized: saved.maximized === true };
  } catch { /* first run or unreadable */ }
  const area = screen.getPrimaryDisplay().workAreaSize;
  return {
    bounds: { width: Math.round(Math.min(area.width * 0.85, 1440)), height: Math.round(Math.min(area.height * 0.85, 900)) },
    maximized: false,
  };
}

export function saveBounds(parent, win) {
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  const state = { ...win.getNormalBounds(), maximized: win.isMaximized() };
  try { fs.writeFileSync(path.join(parent, FILE), `${JSON.stringify(state)}\n`); } catch { /* ignore */ }
}

export const MIN_SIZE = MIN;
