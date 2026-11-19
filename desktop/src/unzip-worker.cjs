// One worker of the zip extraction (src/unpack.mjs). Runs as an eval'd worker_threads script, so it
// only uses Node built-ins. Every worker reads the central directory itself and extracts entries
// index, index + count, index + 2·count, …; file creation (the slow part on NTFS) happens on this
// thread with synchronous calls, so the workers really run in parallel.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { file, staging, index, count, counter } = workerData;
const done = new Int32Array(counter);
const root = path.resolve(staging);

function read(fd, position, length) {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const n = fs.readSync(fd, buffer, offset, length - offset, position + offset);
    if (n === 0) throw new Error('运行包不完整');
    offset += n;
  }
  return buffer;
}

function centralDirectory(fd) {
  const size = fs.fstatSync(fd).size;
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = read(fd, size - tailLength, tailLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('运行包不是有效的 zip');
  const total = tail.readUInt16LE(end + 10);
  const length = tail.readUInt32LE(end + 12);
  const offset = tail.readUInt32LE(end + 16);
  if (total === 0xffff || offset === 0xffffffff) throw new Error('运行包使用了不支持的 zip64 格式');
  const directory = read(fd, offset, length);
  const entries = [];
  for (let p = 0; entries.length < total; ) {
    if (directory.readUInt32LE(p) !== 0x02014b50) throw new Error('运行包目录损坏');
    const nameLength = directory.readUInt16LE(p + 28);
    entries.push({
      method: directory.readUInt16LE(p + 10),
      compressed: directory.readUInt32LE(p + 20),
      header: directory.readUInt32LE(p + 42),
      name: directory.toString('utf8', p + 46, p + 46 + nameLength),
    });
    p += 46 + nameLength + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32);
  }
  return entries;
}

function target(name) {
  const resolved = path.resolve(root, name);
  if (path.isAbsolute(name) || (resolved !== root && !resolved.startsWith(root + path.sep))) {
    throw new Error(`运行包含有越界路径：${name}`);
  }
  return resolved;
}

const fd = fs.openSync(file, 'r');
try {
  const entries = centralDirectory(fd);
  parentPort.postMessage({ total: entries.length });
  for (let i = index; i < entries.length; i += count) {
    const entry = entries[i];
    const file = target(entry.name);
    if (entry.name.endsWith('/')) {
      fs.mkdirSync(file, { recursive: true });
    } else {
      const local = read(fd, entry.header, 30);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error(`运行包条目损坏：${entry.name}`);
      const start = entry.header + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = read(fd, start, entry.compressed);
      let data;
      if (entry.method === 0) data = raw;
      else if (entry.method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`运行包条目压缩方式不支持：${entry.name}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    Atomics.add(done, 0, 1);
  }
} finally {
  fs.closeSync(fd);
}
