import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditWindowsDirectory } from './audit-windows.mjs';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--dir')) {
  throw new Error('Usage: npm run package:win -- [--dir]');
}
const directoryOnly = args.includes('--dir');
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this script using npm run package:win.');
const stage = mkdtempSync(join(realpathSync(tmpdir()), 'doubaovideo-win-'));
const nativeDirectory = 'node_modules/@img/sharp-win32-x64/lib';
const hasWindowsImageRuntime = (directory) => {
  if (!existsSync(directory)) return false;
  const files = readdirSync(directory);
  return [/^sharp-win32-x64(?:-[\w.-]+)?\.node$/, /^libvips-\d+\.dll$/, /^libvips-cpp-.+\.dll$/]
    .every((pattern) => files.some((name) => pattern.test(name)));
};
const run = (bin, params, cwd) => {
  const result = spawnSync(process.execPath, [bin, ...params], {
    cwd,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (${result.signal ?? result.status}): ${params.join(' ')}`);
};

try {
  run(npm, ['run', 'build'], root);
  for (const name of ['package.json', 'package-lock.json', 'out']) {
    cpSync(join(root, name), join(stage, name), { recursive: true });
  }
  run(npm, [
    'ci', '--omit=dev', '--include=optional', '--ignore-scripts', '--os=win32',
    '--cpu=x64', '--no-audit', '--no-fund',
  ], stage);
  if (!hasWindowsImageRuntime(join(stage, nativeDirectory))) {
    throw new Error('Missing locked Windows x64 sharp runtime. Check the npm registry and lockfile.');
  }
  run(join(root, 'node_modules/electron-builder/cli.js'), [
    '--config', 'packaging/windows.yml', `--config.directories.app=${stage}`,
    '--win', ...(directoryOnly ? ['--dir'] : ['nsis']), '--x64',
    ...(!directoryOnly && process.platform === 'linux' ? ['--config.toolsets.wine=1.0.1'] : []),
    '--publish', 'never',
  ], root);
  const audit = auditWindowsDirectory(join(root, 'dist/windows/win-unpacked'), join(root, 'out'));
  console.log(`Static Windows x64 audit passed: ${audit.bundles} bundled files and ${audit.nativeLibraries} sharp libraries. No executable was launched.`);
} finally {
  rmSync(stage, { recursive: true, force: true, maxRetries: 3 });
}
