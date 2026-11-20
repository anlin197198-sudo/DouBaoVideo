import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractFile, listPackage, statFile, uncache } from '@electron/asar';

const maxHeaderBytes = 16 * 1024 * 1024;
const maxBundleBytes = 32 * 1024 * 1024;
const archivePath = (name) => join(...name.split('/'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function regularFile(path) {
  const info = lstatSync(path);
  if (!info.isFile()) throw new Error('Expected a regular file.');
  return info;
}

export function assertWindowsX64(path, kind) {
  const size = regularFile(path).size;
  const fd = openSync(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    if (readSync(fd, dos, 0, dos.length, 0) !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error('Missing DOS executable header.');
    }
    const offset = dos.readUInt32LE(0x3c);
    const pe = Buffer.alloc(26);
    if (offset < dos.length || offset + pe.length > size ||
        readSync(fd, pe, 0, pe.length, offset) !== pe.length ||
        pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664 ||
        pe.readUInt16LE(20) < 2 || offset + 24 + pe.readUInt16LE(20) > size ||
        !(pe.readUInt16LE(22) & 0x0002) || pe.readUInt16LE(24) !== 0x020b ||
        Boolean(pe.readUInt16LE(22) & 0x2000) !== (kind === 'library')) {
      throw new Error('Expected an x64 Windows PE32+ ' + kind + '.');
    }
  } finally {
    closeSync(fd);
  }
}

function archiveDataOffset(path, size) {
  const headerPrefix = Buffer.alloc(8);
  const fd = openSync(path, 'r');
  try {
    if (readSync(fd, headerPrefix, 0, headerPrefix.length, 0) !== headerPrefix.length) {
      throw new Error('Truncated ASAR size header.');
    }
    const headerSize = headerPrefix.readUInt32LE(4);
    if (headerPrefix.readUInt32LE(0) !== 4 || headerSize < 8 || headerSize > maxHeaderBytes ||
        headerSize + headerPrefix.length > size) {
      throw new Error('Invalid ASAR header bounds.');
    }
    return headerPrefix.length + headerSize;
  } finally {
    closeSync(fd);
  }
}

function findBundleFiles(directory, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return findBundleFiles(join(directory, entry.name), relative + '/');
    if (entry.isFile()) return [relative];
    throw new Error('Unexpected object in build output.');
  });
}

export function auditWindowsDirectory(directory, freshOut) {
  const checked = (label, fn) => {
    try { return fn(); }
    catch (error) {
      if (error?.code) throw new Error(`${label}: required file or directory unavailable (${error.code}).`);
      throw new Error(`${label}: ${error.message}`);
    }
  };
  checked('DouBaoVideo.exe', () => assertWindowsX64(join(directory, 'DouBaoVideo.exe'), 'application'));
  const archive = join(directory, 'resources', 'app.asar');
  const archiveBytes = checked('app.asar', () => regularFile(archive).size);
  const dataStart = checked('app.asar', () => archiveDataOffset(archive, archiveBytes));
  const files = checked('out', () => findBundleFiles(freshOut)).sort();
  if (!['main/index.js', 'preload/index.cjs', 'renderer/index.html'].every((name) => files.includes(name)) ||
      !files.some((name) => /^renderer\/assets\/.+\.js$/.test(name))) {
    throw new Error('Fresh build is missing a required main, preload, or renderer entry.');
  }
  if (!files.includes('renderer/f17-video-probe.html') || !files.includes('renderer/f17-video-probe-assets.json') ||
      !files.some((name) => /^renderer\/assets\/f17-video-probe-[a-z0-9_-]+\.js$/i.test(name))) {
    throw new Error('Fresh build is missing the dedicated F17 video probe entry, manifest, or bundle.');
  }
  checked('app.asar', () => {
    uncache(archive);
    const archived = listPackage(archive)
      .map((name) => name.replaceAll('\\', '/').replace(/^\//, ''))
      .filter((name) => name.startsWith('out/') && !statFile(archive, archivePath(name), false).files);
    if (JSON.stringify(archived.map((name) => name.slice(4)).sort()) !== JSON.stringify(files)) {
      throw new Error('Packaged application file list does not match the current build.');
    }
    for (const name of files) {
      const relative = 'out/' + name;
      const expectedPath = join(freshOut, name);
      const size = regularFile(expectedPath).size;
      const record = statFile(archive, archivePath(relative), false);
      const offset = typeof record.offset === 'string' && /^\d+$/.test(record.offset) ? Number(record.offset) : NaN;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > archiveBytes - dataStart - size ||
          record.unpacked || size > maxBundleBytes || size !== record.size ||
          sha256(extractFile(archive, archivePath(relative))) !== sha256(readFileSync(expectedPath))) {
        throw new Error(`Packaged bytes differ from current build: ${relative}.`);
      }
    }
  });
  const native = join(directory, 'resources', 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib');
  const filenames = checked('sharp-win32-x64', () => readdirSync(native));
  const nativeFiles = [/^sharp-win32-x64(?:-[\w.-]+)?\.node$/, /^libvips-\d+\.dll$/, /^libvips-cpp-[\w.-]+\.dll$/]
    .map((pattern) => {
      const matches = filenames.filter((name) => pattern.test(name));
      if (matches.length !== 1) throw new Error('A Windows sharp native component is missing or ambiguous.');
      const [name] = matches;
      checked(name, () => assertWindowsX64(join(native, name), 'library'));
      return name;
    });
  return { bundles: files.length, nativeLibraries: nativeFiles.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  try {
    const result = auditWindowsDirectory(join(root, 'dist/windows/win-unpacked'), join(root, 'out'));
    console.log(`Static Windows x64 audit passed: ${result.bundles} bundled files and ${result.nativeLibraries} sharp libraries. No executable was launched.`);
  } catch (error) {
    console.error(`Static Windows audit failed: ${error.message}`);
    process.exitCode = 1;
  }
}
