import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { win32 } from 'node:path';
import { isLiteralDrivePath, parseSmokeOptions, prepareWindowsSmoke, observeOwnedLaunch } from '../packaging/smoke-windows.mjs';

const exe = String.raw`C:\artifacts\win-unpacked\DouBaoVideo.exe`;
const parent = String.raw`C:\private\smoke`;
const windows = String.raw`C:\Windows`;
const pkg = win32.dirname(exe);
const asar = win32.join(pkg, 'resources', 'app.asar');
const argv = ['--exe', exe, '--run', '--parent', parent];
function fixture() {
  const created: string[] = [];
  let invalid = '';
  let linked = '';
  let aliased = '';
  const fs = {
    lstat: (path: string) => ({
      isSymbolicLink: () => path === linked,
      isDirectory: () => path !== invalid && ![exe, asar].includes(path),
      isFile: () => path !== invalid && [exe, asar].includes(path),
    }),
    realpath: (path: string) => path === aliased ? String.raw`C:\other` : path,
    mkdir: (path: string) => created.push(path),
    mkdtemp: (prefix: string) => { const dir = prefix + 'abc123'; created.push(dir); return dir; },
    assertExecutable: (path: string) => assert.equal(path, exe),
  };
  return { fs, created, invalid: (path: string) => { invalid = path; }, linked: (path: string) => { linked = path; },
    aliased: (path: string) => { aliased = path; } };
}

test('Windows startup driver requires explicit run and rejects alternative path forms', () => {
  assert.equal(parseSmokeOptions([]), null);
  assert.equal(parseSmokeOptions(['--help']), null);
  assert.deepEqual(parseSmokeOptions(argv), { exe, parent });
  for (const path of [String.raw`\\host\share\a`, String.raw`\\?\C:\a`, 'file:///C:/a', 'C:a', String.raw`C:\a\..\b`,
    String.raw`C:\a:stream`, String.raw`C:\a*`, String.raw`C:\a.\a`, String.raw`C:\CON\b`, String.raw`C:\a\\b`, 'C:/a', 'C:\\']) {
    assert.equal(isLiteralDrivePath(path), false, path);
  }
  for (const bad of [argv.slice(0, 2), [...argv, '--run'], argv.map(value => value === exe ? exe.replace('DouBaoVideo', 'Setup') : value)]) {
    assert.throws(() => parseSmokeOptions(bad));
  }
});

test('Windows startup prepares fresh directories and allowlists child environment only after interlocks', () => {
  for (const [mode, target] of [['invalid', asar], ['linked', win32.dirname(parent)], ['aliased', parent]] as const) {
    const f = fixture();
    f[mode](target);
    assert.throws(() => prepareWindowsSmoke({ exe, parent }, windows, f.fs));
    assert.deepEqual(f.created, []);
  }
  const f = fixture();
  assert.throws(() => prepareWindowsSmoke({ exe, parent: pkg }, windows, f.fs));
  const plan = prepareWindowsSmoke({ exe, parent }, windows, f.fs);
  assert.equal(plan.root, win32.join(parent, 'DouBaoVideo-smoke-abc123'));
  assert.deepEqual(f.created, [plan.root, ...['workspace', 'home', 'roaming', 'local', 'temp'].map(name => win32.join(plan.root, name))]);
  assert.deepEqual(Object.keys(plan.env).sort(), ['SystemRoot', 'WINDIR', 'SystemDrive', 'DOUBAO_DATA_DIR',
    'DOUBAO_DEEPSEEK_ENABLED', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP'].sort());
  assert.equal(plan.env.DOUBAO_DEEPSEEK_ENABLED, '0');
  assert.equal(plan.env.DOUBAO_DATA_DIR, win32.join(plan.root, 'workspace'));
});

test('Windows startup tracks only the direct child, distinguishes timeout and never terminates it', async () => {
  const plan = prepareWindowsSmoke({ exe, parent }, windows, fixture().fs);
  for (const variant of ['exit', 'error', 'timeout', 'no-spawn'] as const) {
    const child = Object.assign(new EventEmitter(), { pid: 42, unref: () => { unrefs++; return child; },
      kill: () => assert.fail('Never kill a process') });
    let unrefs = 0;
    const seen: string[] = [];
    const outcome = await observeOwnedLaunch(plan, {
      start: (file, args, opts) => {
        assert.equal(file, exe);
        assert.deepEqual(args, []);
        assert.deepEqual(opts, { cwd: pkg, env: plan.env, shell: false, stdio: 'ignore' });
        queueMicrotask(() => {
          if (variant === 'error') child.emit('error', new Error('not propagated'));
          else if (variant !== 'no-spawn') {
            child.emit('spawn');
            if (variant === 'exit') child.emit('exit', 0, null);
          }
        });
        return child;
      },
      timeoutMs: 4, closeTimeoutMs: 4,
      onSpawn: pid => seen.push('spawn ' + pid),
      onDeadline: pid => seen.push('deadline ' + pid),
    });
    assert.equal(outcome.state, { exit: 'exited', error: 'launch_failed', timeout: 'exit_not_observed', 'no-spawn': 'launch_not_observed' }[variant]);
    assert.deepEqual(seen, variant === 'timeout' ? ['spawn 42', 'deadline 42'] : variant === 'exit' ? ['spawn 42'] : []);
    assert.equal(unrefs, 1);
  }
});
