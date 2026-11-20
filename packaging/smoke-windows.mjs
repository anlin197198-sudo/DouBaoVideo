import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertWindowsX64 } from './audit-windows.mjs';

const { basename, dirname, join, parse, normalize } = win32;
const usage = 'Usage: node packaging/smoke-windows.mjs --run --exe C:\\local\\win-unpacked\\DouBaoVideo.exe --parent C:\\local\\private-smoke-parent';

export function isLiteralDrivePath(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]:\\[^\\]/.test(value) || value.length > 240
    || /[<>:"/|?*\x00-\x1f%]/.test(value.slice(2)) || normalize(value) !== value) return false;
  return value.slice(3).split('\\').every(part => part && !/[. ]$/.test(part)
    && !/^(?:con|conin\$|conout\$|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part));
}
export function parseSmokeOptions(argv) {
  if (!argv.length || (argv.length === 1 && argv[0] === '--help')) return null;
  if (argv.length !== 5) throw new Error('Invalid options.');
  let run = false, exe, parent;
  for (let i = 0; i < argv.length; i++) {
    const option = argv[i];
    if (option === '--run' && !run) run = true;
    else if (option === '--exe' && exe === undefined) exe = argv[++i];
    else if (option === '--parent' && parent === undefined) parent = argv[++i];
    else throw new Error('Invalid options.');
  }
  if (!run || !isLiteralDrivePath(exe) || basename(exe).toLowerCase() !== 'doubaovideo.exe'
    || !isLiteralDrivePath(parent)) throw new Error('Explicit run and local unpacked EXE/private parent are required.');
  return { exe, parent };
}

// Reject links and alternate filesystem spelling in the supplied path and each ancestor.
function assertLocalObject(path, kind, fs) {
  const root = parse(path).root;
  for (let current = path; ; current = dirname(current)) {
    const stat = fs.lstat(current);
    if (stat.isSymbolicLink() || (current === path && kind === 'file' ? !stat.isFile() : !stat.isDirectory()))
      throw new Error('Unexpected filesystem object.');
    if (current === root) break;
  }
  if (fs.realpath(path).toLowerCase() !== path.toLowerCase()) throw new Error('Unexpected local path.');
}
export function prepareWindowsSmoke(options, systemRoot, fs = { lstat: lstatSync, realpath: realpathSync.native,
  mkdir: mkdirSync, mkdtemp: mkdtempSync, assertExecutable: path => assertWindowsX64(path, 'application') }) {
  const { exe, parent } = options;
  if (!isLiteralDrivePath(exe) || basename(exe).toLowerCase() !== 'doubaovideo.exe'
    || !isLiteralDrivePath(parent) || !isLiteralDrivePath(systemRoot)) throw new Error('Invalid local paths.');
  const appDirectory = dirname(exe);
  if (parent.toLowerCase() === appDirectory.toLowerCase()
    || parent.toLowerCase().startsWith(appDirectory.toLowerCase() + '\\')) throw new Error('Smoke root cannot be inside the package.');
  assertLocalObject(exe, 'file', fs);
  assertLocalObject(join(appDirectory, 'resources', 'app.asar'), 'file', fs);
  assertLocalObject(parent, 'directory', fs);
  assertLocalObject(systemRoot, 'directory', fs);
  fs.assertExecutable(exe);
  const root = fs.mkdtemp(join(parent, 'DouBaoVideo-smoke-'));
  const paths = Object.fromEntries(['workspace', 'home', 'roaming', 'local', 'temp'].map(name => {
    const path = join(root, name);
    fs.mkdir(path);
    return [name, path];
  }));
  return { root, exe, cwd: appDirectory, env: {
    SystemRoot: systemRoot, WINDIR: systemRoot, SystemDrive: parse(systemRoot).root.slice(0, 2),
    DOUBAO_DATA_DIR: paths.workspace, DOUBAO_DEEPSEEK_ENABLED: '0',
    HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.roaming, LOCALAPPDATA: paths.local,
    TEMP: paths.temp, TMP: paths.temp,
  } };
}

// Do not terminate by PID or name. A timeout may leave the tracked child running.
export function observeOwnedLaunch(plan, { start = spawn, timeoutMs = 30_000, onSpawn = () => {}, onDeadline = () => {},
  closeTimeoutMs = 10_000 } = {}) {
  return new Promise(resolveResult => {
    let child, timer, finished = false, spawned = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child?.unref();
      resolveResult(result);
    };
    try {
      child = start(plan.exe, [], { cwd: plan.cwd, env: plan.env, shell: false, stdio: 'ignore' });
    } catch {
      finish({ state: 'launch_failed' });
      return;
    }
    child.once('error', () => finish({ state: spawned ? 'observation_failed' : 'launch_failed' }));
    child.once('spawn', () => {
      if (finished) return;
      spawned = true;
      onSpawn(child.pid);
    });
    child.once('exit', (code, signal) => finish({ state: spawned ? 'exited' : 'launch_failed', code, signal }));
    timer = setTimeout(() => {
      if (!spawned) { finish({ state: 'launch_not_observed' }); return; }
      onDeadline(child.pid);
      if (!finished) timer = setTimeout(() => finish({ state: 'exit_not_observed' }), closeTimeoutMs);
    }, timeoutMs);
  });
}

async function runCli() {
  let stage = 'options';
  try {
    const options = parseSmokeOptions(process.argv.slice(2));
    if (!options) { console.log(usage + '\nNo executable launched.'); return; }
    stage = 'platform';
    if (process.platform !== 'win32') throw new Error();
    stage = 'preparation';
    const plan = prepareWindowsSmoke(options, process.env.SystemRoot);
    stage = 'observation';
    const outcome = await observeOwnedLaunch(plan, {
      onSpawn: pid => console.log(`Direct child spawned (PID ${pid}); observe only its window. Startup is not verified.`),
      onDeadline: pid => console.log(`Startup observation ended. If you can verify ownership, close the window of PID ${pid} normally now; no process will be terminated automatically.`),
    });
    console.log(`Observation: ${outcome.state}${typeof outcome.code === 'number' ? ` (exit code ${outcome.code})` : ''}. Window and visual acceptance are manual; no automatic cleanup.`);
    if (outcome.state !== 'exited' || outcome.code !== 0) process.exitCode = 1;
  } catch {
    console.error(`Windows smoke stopped at ${stage}. ${usage}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runCli();
