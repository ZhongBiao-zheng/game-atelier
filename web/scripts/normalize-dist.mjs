import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js']);

async function normalizeDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await normalizeDirectory(path);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(extname(entry.name))) continue;
    const source = await readFile(path, 'utf8');
    const normalized = source.replace(/[ \t]+$/gm, '');
    if (normalized !== source) await writeFile(path, normalized, 'utf8');
  }
}

await normalizeDirectory(fileURLToPath(new URL('../dist', import.meta.url)));
