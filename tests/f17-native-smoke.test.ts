import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFileSync, mkdtempSync, writeFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SYNTHETIC_MP4_BASE64, SYNTHETIC_MP4_SHA256 } from "./fixtures/f17-native-smoke-mp4";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { acceptsNativeProbeLaunch, nativeProbeEnvironment, classifyNativeProbeOutput, classifyNativeProbeExit } from "../scripts/run-f17-native-probe.mjs";

test("native smoke requires opt-in Windows, strips inherited env and emits only safe classification",()=>{
 assert.equal(acceptsNativeProbeLaunch(['--run'],'win32'),true);
 for(const args of [[],['--run','private.mp4'],['--help']])assert.equal(acceptsNativeProbeLaunch(args,'win32'),false);
 assert.equal(acceptsNativeProbeLaunch(['--run'],'linux'),false);
 const env=nativeProbeEnvironment('C:\\Windows','synthetic-root');
 assert.deepEqual(Object.keys(env).sort(),['APPDATA','HOME','LOCALAPPDATA','SystemRoot','TEMP','TMP','USERPROFILE','WINDIR'].sort());
 assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.DEEPSEEK_API_KEY,undefined);assert.equal(env.ELECTRON_RUN_AS_NODE,undefined);
 assert.deepEqual(classifyNativeProbeOutput(JSON.stringify({stage:'f17-native-probe',result:'first-frame-observed',width:160,height:90,path:'/private',secret:'do-not-copy'})),{stage:'f17-native-probe',result:'first-frame-observed',width:160,height:90});
 assert.equal(classifyNativeProbeExit({stage:'f17-native-probe',result:'first-frame-observed',width:160,height:90},1).result,'failed');
 assert.equal(classifyNativeProbeExit({stage:'f17-native-probe',result:'first-frame-observed',width:160,height:90},0).result,'first-frame-observed');
 for(const line of ['raw diagnostic',JSON.stringify({stage:'other',result:'failed'}),JSON.stringify({stage:'f17-native-probe',result:'first-frame-observed',width:-1,height:90})])assert.equal(classifyNativeProbeOutput(line),null);
});
test("repository fixture is fixed bounded synthetic MP4 accepted as undecoded intake only",async t=>{
 const bytes=Buffer.from(SYNTHETIC_MP4_BASE64,'base64');assert.equal(bytes.length,1923);assert.equal(createHash('sha256').update(bytes).digest('hex'),SYNTHETIC_MP4_SHA256);
 const root=mkdtempSync(join(tmpdir(),'dv-native-fixture-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'synthetic.mp4');writeFileSync(path,bytes);
 const stat=lstatSync(path);const media=await intakeMp4(path,stat);assert.equal(media.evidence.decoded,false);assert.equal(media.evidence.sha256,SYNTHETIC_MP4_SHA256);
 const parts:Uint8Array[]=[];for await(const chunk of media.stream())parts.push(chunk);await media.close();assert.deepEqual(Buffer.concat(parts),bytes);
});
test("native smoke remains a separate fixed entry, never default application activation",()=>{
 const main=readFileSync('scripts/f17-native-probe-main.ts','utf8'),config=readFileSync('electron.probe-smoke.config.ts','utf8');
 assert.ok(main.includes('--run-f17-native-probe'));assert.match(main,/stream:\s*true/);assert.ok(main.includes('createPrivateVideoDecodeInspector'));
 assert.ok(config.includes('scripts/f17-native-probe-main.ts'));assert.ok(!config.includes('src/main/index.ts'));
 const app=readFileSync('src/main/index.ts','utf8');assert.ok(!app.includes('f17-native-probe'));assert.ok(!app.includes('createPrivateVideoDecodeInspector'));
});

test("full-import mode needs ordered explicit opt-in and accepts only its fixed complete evidence",()=>{
 assert.equal(acceptsNativeProbeLaunch(['--run','--full-import'],'win32'),true);
 for(const args of [['--full-import'],['--full-import','--run'],['--run','--run'],['--run','--full-import','--full-import'],['--run','--full-import','private.mp4']])assert.equal(acceptsNativeProbeLaunch(args,'win32'),false);
 assert.equal(acceptsNativeProbeLaunch(['--run','--full-import'],'linux'),false);
 const success={stage:'f17-native-full-import',result:'import-recorded',taskUnchanged:true,archiveVerified:true,metadataRecorded:true};
 assert.deepEqual(classifyNativeProbeOutput(JSON.stringify({...success,path:'/private',token:'secret'}),'full-import'),success);
 assert.equal(classifyNativeProbeOutput(JSON.stringify(success)),null);
 assert.equal(classifyNativeProbeOutput(JSON.stringify({stage:'f17-native-probe',result:'first-frame-observed',width:160,height:90}),'full-import'),null);
 for(const field of ['taskUnchanged','archiveVerified','metadataRecorded'])for(const value of [false,undefined,'true'])assert.equal(classifyNativeProbeOutput(JSON.stringify({...success,[field]:value}),'full-import'),null);
 assert.deepEqual(classifyNativeProbeExit(success,0,'full-import'),success);
 for(const code of [1,null])assert.deepEqual(classifyNativeProbeExit(success,code,'full-import'),{stage:'f17-native-full-import',result:'failed'});
 const launcher=readFileSync('scripts/run-f17-native-probe.mjs','utf8');assert.match(launcher,/--run-f17-native-full-import/);assert.match(launcher,/classifyNativeProbeOutput\(line,mode\)/);
});

test("full-import developer entry binds real isolated SQLite and archive to owned native host, not default startup",()=>{
 const main=readFileSync('scripts/f17-native-probe-main.ts','utf8');
 for(const text of ['--run-f17-native-full-import','createPrivateVideoFirstFrameHost','createVerifiedLocalImport','new ApplicationDatabase(databasePath)','SELECT * FROM tasks WHERE id=?','sourceCleanupConfirmed','readFileSync(target).equals(bytes)','execution.account_id!==null','execution.remote_reference!==null'])assert.ok(main.includes(text));
 assert.equal((main.match(/new ApplicationDatabase\(databasePath\)/g)||[]).length,2);
 assert.ok(!main.includes('process.argv[3]'));assert.ok(!readFileSync('src/main/index.ts','utf8').includes('createVerifiedLocalImport'));
});
