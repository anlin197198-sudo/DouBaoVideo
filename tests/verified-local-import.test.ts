import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp,mkdir,writeFile,lstat,readFile,readdir,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
import { createVerifiedLocalImport } from "../src/main/application/verified-local-import";
import { buildVideoBasename } from "../src/shared/video-basename";
import { SYNTHETIC_MP4_BASE64 } from "./fixtures/f17-native-smoke-mp4";
const positive={status:"first-presented-frame",evidence:{durationSeconds:1,videoWidth:160,videoHeight:90,width:160,height:90,mediaTime:0,presentedFrames:1}};
async function fixture(t:{after:(f:()=>Promise<void>)=>unknown},mode='normal'){
 const root=await mkdtemp(join(tmpdir(),'dv-import-pipeline-')),stage=join(root,'stage'),archive=join(root,'archive'),source=join(root,'source.mp4');await mkdir(stage);await mkdir(archive);
 const bytes=Buffer.from(SYNTHETIC_MP4_BASE64,'base64');await writeFile(source,bytes);const db=new ApplicationDatabase(join(root,'workspace.sqlite'));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const task=db.transaction(()=>new WorkspaceRepository(db).createPlan({title:'Synthetic pipeline',style:'comic',startDate:'2026-11-19',dailyCount:1,executionTime:'09:00'})).tasks[0]!;
 const input=await intakeMp4(source,await lstat(source)),owner={ownerId:77,documentId:randomUUID()},controller=new AbortController();
 const intent={requestId:randomUUID(),filmId:randomUUID(),taskId:task.id,executionId:randomUUID(),expectedRevision:task.revision,version:1,title:'Synthetic pipeline',directory:archive,owner:{...owner},fingerprint:{bytes:input.evidence.bytes,sha256:input.evidence.sha256}};
 const target=join(archive,buildVideoBasename({taskId:intent.taskId,executionId:intent.executionId,version:1,title:intent.title}));
 let live=true,stopped=false,probes=0,issued='';
 let release!:()=>void,reached!:()=>void;const gate=new Promise<void>(r=>release=r),entered=new Promise<void>(r=>reached=r);
 const registry=new VideoProbeRegistry({isLive:(id,doc)=>live&&id===owner.ownerId&&doc===owner.documentId});
 const run=await createVerifiedLocalImport({database:db,stagingParent:stage,registry,
  async probe(url,seenOwner){probes++;issued=url;assert.deepEqual(seenOwner,owner);const response=await registry.response(new Request(url),owner);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);if(mode==='hold-probe'){reached();await gate;}return mode==='bad-frame'?{status:'failed',reason:'playback_failed'}:positive;},
  async stopProbe(seenOwner){assert.deepEqual(seenOwner,owner);assert.equal(registry.accepts(issued.split('/').pop()!,owner),false);assert.deepEqual(await readdir(archive),[]);live=false;stopped=true;
   if(mode==='stale-after-stop')db.connection.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(task.id);
   return mode!=='stop-failed';},
 });
 const current=()=>{if(existsSync(target)){assert.equal(stopped,true);if(mode==='cancel-after-publish'){controller.abort();return false;}}return true;};
 return {db,task,stage,archive,source,input,owner,intent,target,bytes,controller,current,run,release,entered,get probes(){return probes;}};
}
const counts=(db:ApplicationDatabase)=>['executions','films','command_receipts'].map(table=>db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
test("combined owned-frame path writes exact staged bytes then real neutral V7 transaction; duplicate is metadata-only",async t=>{
 const f=await fixture(t),before=f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id);
 const result=await f.run(f.input,f.owner,f.intent,f.current,f.controller.signal);assert.equal(result.archive?.receipt?.status,'published');assert.equal(result.record?.status,'recorded');assert.equal(result.preparation?.cleanup,'removed');assert.deepEqual(counts(f.db),[1,1,1]);assert.equal(f.probes,1);
 assert.deepEqual(await readFile(f.target),f.bytes);assert.deepEqual(await readFile(f.source),f.bytes);assert.deepEqual(await readdir(f.stage),[]);assert.deepEqual(f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id),before);
 const again=await f.run(await intakeMp4(f.source,await lstat(f.source)),f.owner,f.intent,f.current);assert.equal(again.status,'prior-recorded');assert.equal(again.archive,null);assert.equal(f.probes,1);assert.deepEqual(counts(f.db),[1,1,1]);assert.equal((await readdir(f.archive)).length,1);
});
test("cancel after actual publication preserves pending file receipt with no database rows",async t=>{
 const f=await fixture(t,'cancel-after-publish');const result=await f.run(f.input,f.owner,f.intent,f.current,f.controller.signal);
 assert.equal(result.preparation?.status,'cancelled');assert.equal(result.preparation?.effect?.status,'settled');assert.equal(result.archive?.receipt?.status,'published');assert.equal(result.record,null);assert.deepEqual(counts(f.db),[0,0,0]);assert.deepEqual(await readFile(f.target),f.bytes);assert.deepEqual(await readdir(f.stage),[]);assert.equal(result.automaticRetry,false);
});
test("failed frame, unconfirmed native stop and stale revision after stop cannot publish",async t=>{
 for(const mode of ['bad-frame','stop-failed','stale-after-stop']){
  const f=await fixture(t,mode),result=await f.run(f.input,f.owner,f.intent,f.current);assert.equal(result.archive,null);assert.equal(result.record,null);assert.deepEqual(counts(f.db),[0,0,0]);assert.deepEqual(await readdir(f.archive),[]);
  if(mode==='stop-failed'){assert.equal(result.preparation?.status,'cleanup-unconfirmed');assert.equal((await readdir(f.stage)).length,1);}else assert.deepEqual(await readdir(f.stage),[]);
 }
});
test("database failure and final intake cleanup failure retain exact published and recorded facts",async t=>{
 const f=await fixture(t);f.db.connection.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'synthetic'); END;");
 const result=await f.run(f.input,f.owner,f.intent,f.current);assert.equal(result.archive?.receipt?.status,'published');assert.equal(result.record?.status,'recording-unconfirmed');assert.deepEqual(counts(f.db),[0,0,0]);assert.deepEqual(await readFile(f.target),f.bytes);
 const g=await fixture(t),input={...g.input,close:async()=>{await g.input.close();throw Error('synthetic cleanup');}};
 const recorded=await g.run(input,g.owner,g.intent,g.current);assert.equal(recorded.preparation?.status,'cleanup-unconfirmed');assert.equal(recorded.archive?.receipt?.status,'published');assert.equal(recorded.record?.status,'recorded');assert.deepEqual(counts(g.db),[1,1,1]);assert.deepEqual(await readFile(g.target),g.bytes);
});
test("intent must name the actual private decoder document before staging or probing",async t=>{
 const f=await fixture(t);const result=await f.run(f.input,f.owner,{...f.intent,owner:{...f.owner,documentId:randomUUID()}},f.current);
 assert.equal(result.status,'not-started');assert.equal(f.probes,0);assert.deepEqual(await readdir(f.stage),[]);assert.deepEqual(await readdir(f.archive),[]);assert.deepEqual(counts(f.db),[0,0,0]);
});
test("concurrent calls cannot share a decoder lifecycle or close the active input",async t=>{
 const f=await fixture(t,'hold-probe'),pending=f.run(f.input,f.owner,f.intent,f.current);await f.entered;
 const refused=await f.run(f.input,f.owner,f.intent,f.current);assert.equal(refused.status,'not-started');assert.equal(f.probes,1);assert.deepEqual(counts(f.db),[0,0,0]);
 f.release();const first=await pending;assert.equal(first.record?.status,'recorded');assert.deepEqual(counts(f.db),[1,1,1]);assert.deepEqual(await readFile(f.target),f.bytes);
});
