// `pnpm stage`: what the build packages from outside desktop/, copied into stage/ (not committed).
// - release_sources.json: where the runtime is downloaded from (src/viewer_server/release_sources.json).
// - icon.png: 1024 px macOS icon (Apple grid padding is part of the SVG); electron-builder makes the icns.
// - trayTemplate.png: the menu-bar template image made by scripts/build_tray_icon.py (3x, 18 pt).
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = path.join(desktop, '..', 'assets', 'brand');
const stage = path.join(desktop, 'stage');
const out = path.join(stage, 'icons');

function render(svgFile, size) {
  const svg = fs.readFileSync(svgFile);
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(path.join(brand, 'atelier-icon-macos.svg'), 1024));
fs.copyFileSync(path.join(brand, 'atelier-tray-template.png'), path.join(out, 'trayTemplate.png'));
fs.copyFileSync(path.join(desktop, '..', 'src', 'viewer_server', 'release_sources.json'), path.join(stage, 'release_sources.json'));
console.log(`staged -> ${path.relative(desktop, stage)}`);
