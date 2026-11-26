// macOS: the app was called Atelier before it was renamed (docs/contracts/desktop-shell.md「目录」).
// A dmg cannot replace an app bundle under another name, so the old Atelier.app stays next to the
// new one: same bundle id, same Chromium profile, single-instance lock and runtime. Nothing breaks,
// but Launchpad shows both, so the first start under the new name points the user at the old one.
// It is never deleted for them.
import fs from 'node:fs';
import path from 'node:path';

/** Names this app was installed under before. */
export const EARLIER_NAMES = ['Atelier'];
const MARKER = 'earlier-app-noticed';

/** The `.app` bundle an executable path lies in, or null. */
export function bundleOf(exe) {
  const at = exe.indexOf('.app/');
  return at < 0 ? null : exe.slice(0, at + 4);
}

/** Earlier app bundles in an Applications folder, the running one excepted. */
export function earlierBundles({ name, exe, home, exists = fs.existsSync }) {
  const running = bundleOf(exe);
  const folders = ['/Applications', home ? path.join(home, 'Applications') : null].filter(Boolean);
  return EARLIER_NAMES
    .filter((earlier) => earlier !== name)
    .flatMap((earlier) => folders.map((folder) => path.join(folder, `${earlier}.app`)))
    .filter((bundle) => bundle !== running && exists(bundle));
}

/** Bundles to tell the user about: found, and not told about before (marker in `userData`). */
export function bundlesToNotice({ userData, ...where }) {
  let noticed = [];
  try {
    noticed = fs.readFileSync(path.join(userData, MARKER), 'utf8').split('\n').filter(Boolean);
  } catch {
    // never noticed
  }
  return earlierBundles(where).filter((bundle) => !noticed.includes(bundle));
}

export function markNoticed(userData, bundles) {
  fs.mkdirSync(userData, { recursive: true });
  fs.appendFileSync(path.join(userData, MARKER), bundles.map((b) => `${b}\n`).join(''));
}
