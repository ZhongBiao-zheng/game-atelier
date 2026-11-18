// `pnpm icons`: app icons from assets/brand into stage/icons (not committed).
// - icon.png: 1024 px macOS icon (Apple grid padding is part of the SVG); electron-builder makes the icns.
// - icon.ico: Windows icon from the unpadded SVG (the macOS padding leaves the glyph at 80 % on Windows).
// - trayTemplate.png: the menu-bar template image made by scripts/build_tray_icon.py (3x, 18 pt).
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = path.join(desktop, '..', 'assets', 'brand');
const out = path.join(desktop, 'stage', 'icons');
const ICO_SIZES = [16, 24, 32, 48, 64, 256];

function render(svgFile, size) {
  const svg = fs.readFileSync(svgFile);
  return new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: 'rgba(0,0,0,0)' }).render().asPng();
}

/** ICO with PNG entries (Windows Vista and later read them at every size). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.png)]);
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon.png'), render(path.join(brand, 'atelier-icon-macos.svg'), 1024));
const winSvg = path.join(brand, 'atelier-icon.svg');
fs.writeFileSync(path.join(out, 'icon.ico'), ico(ICO_SIZES.map((size) => ({ size, png: render(winSvg, size) }))));
fs.copyFileSync(path.join(brand, 'atelier-tray-template.png'), path.join(out, 'trayTemplate.png'));
console.log(`icons -> ${path.relative(desktop, out)}`);
