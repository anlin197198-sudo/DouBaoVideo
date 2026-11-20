import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, lstat, rm, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { createMp4Stage } from "../src/main/infrastructure/mp4-stage";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { createBoundArchiveRecorder } from "../src/main/application/bound-archive-evidence";
import { buildVideoBasename } from "../src/shared/video-basename";
import { SYNTHETIC_MP4_BASE64 } from "./fixtures/f17-native-smoke-mp4";
async function fixture(t:{after:(f:()=>Promise<void>)=>unknown}){
 const root=await mkdtemp(join(tmpdir(),"dv-bound-archive-")),stageRoot=join(root,"stage"),directory=join(root,"archive");await mkdir(stageRoot);await mkdir(directory);
 const db=new ApplicationDatabase(join(root,"workspace.sqlite"));const task=db.transaction(()=>new WorkspaceRepository(db).createPlan({title:"Synthetic binding",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 const source=join(root,"synthetic.mp4"),bytes=Buffer.from(SYNTHETIC_MP4_BASE64,"base64");await writeFile(source,bytes);
 const input=await intakeMp4(source,await lstat(source)),staged=await(await createMp4Stage(stageRoot))(input);assert.equal(staged.status,"staged");if(staged.status!=="staged")throw Error();
 t.after(async()=>{await staged.discard();await input.close();db.close();await rm(root,{recursive:true,force:true});});
 const binding={requestId:randomUUID(),filmId:randomUUID(),taskId:task.id,executionId:randomUUID(),expectedRevision:task.revision,version:1,title:"Synthetic binding",directory,owner:{ownerId:5,documentId:randomUUID()},fingerprint:{...staged.snapshot.fingerprint}};
 const snapshot={fingerprint:staged.snapshot.fingerprint,open:async()=>{const acquired=await staged.snapshot.acquire();return acquired.source.stream(0,acquired.fingerprint.bytes-1);}};
 const dump=()=>JSON.stringify(db.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>[row.name,db.connection.prepare(`SELECT * FROM \"${String(row.name)}\" ORDER BY rowid`).all()]));
 return {db,binding,snapshot,bytes,dump,directory};
}
test("only original actual archive creates bound capability; copies, swapped bindings and other epochs fail without DB writes",async t=>{
 const f=await fixture(t),before=f.dump(),recorder=createBoundArchiveRecorder();assert.equal(f.db.version,7);
 const written=await recorder.write(f.binding,f.snapshot,()=>true);assert.equal(written.archive?.receipt?.status,"published");assert.ok(written.capability);
 const proof=recorder.inspect(written.capability,f.binding);assert.ok(proof);assert.equal(proof.writeAuthorized,false);assert.equal(proof.physicalFileRechecked,false);assert.equal(proof.mediaPlaybackAuthorized,false);assert.deepEqual(await readFile(proof.target),f.bytes);
 assert.equal(recorder.inspect({...written.capability},f.binding),null);assert.equal(createBoundArchiveRecorder().inspect(written.capability,f.binding),null);
 for(const changed of [{...f.binding,requestId:randomUUID()},{...f.binding,expectedRevision:f.binding.expectedRevision+1},{...f.binding,taskId:randomUUID()},{...f.binding,version:2},{...f.binding,directory:join(f.directory,"other")},{...f.binding,owner:{...f.binding.owner,documentId:randomUUID()}},{...f.binding,fingerprint:{...f.binding.fingerprint,sha256:"0".repeat(64)}}])assert.equal(recorder.inspect(written.capability,changed),null);
 assert.equal((await recorder.write({...f.binding,requestId:randomUUID()},f.snapshot,()=>true)).status,"refused");assert.equal(f.dump(),before);
 recorder.close();assert.equal(recorder.inspect(written.capability,f.binding),null);
});
test("cancelled, mismatched and non-published attempts mint no evidence; late cancellation never hides published receipt",async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 assert.equal((await createBoundArchiveRecorder().write(f.binding,f.snapshot,()=>true,controller.signal)).capability,null);
 assert.equal((await createBoundArchiveRecorder().write({...f.binding,fingerprint:{...f.binding.fingerprint,bytes:f.binding.fingerprint.bytes+1}},f.snapshot,()=>true)).status,"refused");assert.deepEqual(await readdir(f.directory),[]);
 const target=join(f.directory,buildVideoBasename({taskId:f.binding.taskId,executionId:f.binding.executionId,version:1,title:f.binding.title}));
 const late=await createBoundArchiveRecorder().write(f.binding,f.snapshot,()=>!existsSync(target));assert.equal(late.archive?.receipt?.status,"published");assert.equal(late.capability,null);assert.deepEqual(await readFile(target),f.bytes);
 const occupied=await createBoundArchiveRecorder().write(f.binding,f.snapshot,()=>true);assert.equal(occupied.archive?.receipt?.status,"not-published");assert.equal(occupied.capability,null);
});
test("immutable captured payload cannot be rebound by caller mutation; revoked or stale proof cannot revive",async t=>{
 const f=await fixture(t),recorder=createBoundArchiveRecorder();let live=true;
 const expected=structuredClone(f.binding);const writing=recorder.write(f.binding,{...f.snapshot,open:async()=>{f.binding.version=9;f.binding.fingerprint.sha256="0".repeat(64);return f.snapshot.open();}},()=>live);
 const done=await writing;assert.ok(done.capability);assert.ok(recorder.inspect(done.capability,expected));assert.equal(recorder.inspect(done.capability,f.binding),null);
 live=false;assert.equal(recorder.inspect(done.capability,expected),null);live=true;assert.equal(recorder.inspect(done.capability,expected),null);
});
test("inspection cannot survive revocation by expected getters or reentrant lease callbacks",async t=>{
 for(const mode of ['close','revoke','lease','abort']){
  const f=await fixture(t),recorder=createBoundArchiveRecorder(),controller=new AbortController();let stop=false,checks=0;
  const result=await recorder.write(f.binding,f.snapshot,()=>{if(stop){if(mode==='abort'){if(++checks===2)controller.abort();}else recorder.close();}return true;},controller.signal);assert.ok(result.capability);
  if(mode==='lease'||mode==='abort'){stop=true;assert.equal(recorder.inspect(result.capability,f.binding),null);}
  else{
   const expected={...f.binding,get requestId(){if(mode==='close')recorder.close();else recorder.revoke(result.capability!);return f.binding.requestId;}};
   assert.equal(recorder.inspect(result.capability,expected),null);
  }
 }
});
