import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { mkdtemp, mkdir, writeFile, lstat, rm, readFile, readdir, rename, unlink, symlink } from "node:fs/promises";
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
test("private original capability verifies original pinned publication without granting DB or playback authority",async t=>{
 const f=await fixture(t),recorder=createBoundArchiveRecorder(),before=f.dump();const written=await recorder.write(f.binding,f.snapshot,()=>true);assert.ok(written.capability);
 const result=await recorder.verifyPhysical(written.capability,f.binding);assert.equal(result.status,"verified");assert.equal(result.writeAuthorized,false);assert.equal(result.databaseCompleted,false);assert.equal(result.mediaPlaybackAuthorized,false);
 assert.equal((await recorder.verifyPhysical({...written.capability},f.binding)).status,"unavailable");assert.equal((await recorder.verifyPhysical(written.capability,{...f.binding,version:2})).status,"unavailable");assert.equal(f.dump(),before);
});
test("same-size tamper, identical-byte inode replacement, missing files and symlinks cannot verify original publication",async t=>{
 for(const mode of ['tamper','replace','missing','symlink']){
  const f=await fixture(t),recorder=createBoundArchiveRecorder(),written=await recorder.write(f.binding,f.snapshot,()=>true);assert.ok(written.capability);
  const target=written.archive!.receipt!.target,original=await lstat(target),saved=join(f.directory,'original-kept.mp4');
  if(mode==='tamper')await writeFile(target,Buffer.alloc(f.bytes.length,7));
  else {await rename(target,saved);if(mode==='replace'){await writeFile(target,f.bytes);assert.notEqual((await lstat(target)).ino,original.ino);}else if(mode==='symlink')await symlink(saved,target);}
  assert.equal((await recorder.verifyPhysical(written.capability,f.binding)).status,"unavailable");
 }
});
test("revoked or changed ownership during asynchronous verification cannot return success",async t=>{
 for(const mode of ['revoke','lease','close']){
  const f=await fixture(t),recorder=createBoundArchiveRecorder();let live=true;
  const written=await recorder.write(f.binding,f.snapshot,()=>live);assert.ok(written.capability);
  const pending=recorder.verifyPhysical(written.capability,f.binding);
  if(mode==='revoke')recorder.revoke(written.capability);else if(mode==='close')recorder.close();else live=false;
  assert.equal((await pending).status,"unavailable");
  assert.deepEqual(await readFile(written.archive!.receipt!.target),f.bytes);
 }
});
