import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export function acceptsNativeProbeLaunch(argv, platform) {
  return platform === 'win32' && ((argv.length === 1 && argv[0] === '--run') || (argv.length === 2 && argv[0] === '--run' && argv[1] === '--full-import'));
}
// No spread of process.env: provider keys, flags, Node injection and proxy settings never pass through.
export function nativeProbeEnvironment(systemRoot, privateRoot) {
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\[^\x00-\x1f]*$/.test(systemRoot)
    || win32.normalize(systemRoot) !== systemRoot) throw new Error('Invalid system root.');
  return { SystemRoot: systemRoot, WINDIR: systemRoot,
    HOME: join(privateRoot, 'home'), USERPROFILE: join(privateRoot, 'home'),
    APPDATA: join(privateRoot, 'roaming'), LOCALAPPDATA: join(privateRoot, 'local'),
    TEMP: join(privateRoot, 'temp'), TMP: join(privateRoot, 'temp') };
}
export function classifyNativeProbeOutput(line, mode = 'probe') {
  if (!['probe','full-import'].includes(mode)) return null;
  try {
    const value = JSON.parse(line);
    if (mode === 'full-import') {
      if (!value || value.stage !== 'f17-native-full-import' || !['import-recorded','not-observed','failed','timeout'].includes(value.result)) return null;
      if (value.result === 'import-recorded') {
        if(value.taskUnchanged !== true || value.archiveVerified !== true || value.metadataRecorded !== true) return null;
        return {stage:'f17-native-full-import',result:'import-recorded',taskUnchanged:true,archiveVerified:true,metadataRecorded:true};
      }
      return {stage:'f17-native-full-import',result:value.result};
    }
    if (!value || value.stage !== 'f17-native-probe'  || !['first-frame-observed','not-observed','failed','timeout'].includes(value.result)) return null;
    const output = { stage: 'f17-native-probe', result: value.result };
    if (value.result === 'first-frame-observed') {
      if (![value.width,value.height].every(v => Number.isSafeInteger(v) && v > 0 && v <= 100000)) return null;
      output.width = value.width; output.height = value.height;
    }
    return output;
  } catch { return null; }
}

export function classifyNativeProbeExit(report, exitCode, mode = 'probe') {
  const safe = classifyNativeProbeOutput(JSON.stringify(report),mode);
  return !safe || (['first-frame-observed','import-recorded'].includes(safe.result) && exitCode !== 0)
    ? {stage:mode==='full-import'?'f17-native-full-import':'f17-native-probe',result:'failed'} : safe;
}

export async function runNativeProbe(argv = process.argv.slice(2)) {
  if (!acceptsNativeProbeLaunch(argv, process.platform)) {
    console.log('Native probe not launched. On an authorized Windows machine: npm run smoke:f17:native -- --run');
    return 2;
  }
  const mode=argv.length===2?'full-import':'probe',stage=mode==='full-import'?'f17-native-full-import':'f17-native-probe';
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const executable = join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
  const entry = join(repository, '.local', 'f17-native-smoke', 'main', 'index.js');
  // Only the installed project runtime and fixed compiled entry. Never install, download or use PATH.
  for (const file of [executable,entry]) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error('Unavailable local runtime.');
  }
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'dvb-native-probe-launch-'));
  try {
    for (const name of ['home','roaming','local','temp']) mkdirSync(join(root,name));
    const env = nativeProbeEnvironment(process.env.SystemRoot,root);
    const code = await new Promise(resolveCode => {
      let settled = false, report = null, pending = '', overflow = false;
      const finish = code => { if(settled)return;settled=true;clearTimeout(timer);
        console.log(JSON.stringify(report ?? {stage,result:'failed'}));resolveCode(code); };
      const child = spawn(executable,[entry,mode==='full-import'?'--run-f17-native-full-import':'--run-f17-native-probe'],{cwd:repository,env,stdio:['ignore','pipe','ignore'],windowsHide:true,shell:false});
      const timer = setTimeout(() => {
        report={stage,result:'timeout'};
        try { child.kill(); } catch { /* Own-process termination is unconfirmed. */ }
        child.stdout.destroy();child.unref();finish(1);
      },20000);
      child.stdout.on('data',chunk=>{
        if(overflow)return;pending+=chunk.toString('utf8');if(pending.length>65536){overflow=true;pending='';return;}
        let next;while((next=pending.indexOf('\n'))>=0){const line=pending.slice(0,next);pending=pending.slice(next+1);const known=classifyNativeProbeOutput(line,mode);if(known)report=known;}
      });
      child.on('error',()=>{report={stage,result:'failed'};finish(1);});
      child.on('close',code=>{if(pending){const known=classifyNativeProbeOutput(pending,mode);if(known)report=known;}
        const passed=code===0 && report?.result===(mode==='full-import'?'import-recorded':'first-frame-observed');
        report=classifyNativeProbeExit(report,code,mode);
        finish(passed?0:1);});
    });
    // Always retain this synthetic root: main-process exit alone does not prove child-process quiescence.
    // No original/default workspace is touched or cleaned.
    return code;
  } catch { return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runNativeProbe().then(code=>{process.exitCode=code;}).catch(()=>{console.log(JSON.stringify({stage:process.argv.slice(2).length===2&&process.argv[2]==='--run'&&process.argv[3]==='--full-import'?'f17-native-full-import':'f17-native-probe',result:'failed'}));process.exitCode=1;});
}
