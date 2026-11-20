import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { randomUUID } from "node:crypto";

import { mkdtemp, mkdir, writeFile, lstat, rm, readFile, readdir, rename, unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { createMp4Stage } from "../src/main/infrastructure/mp4-stage";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { WorkspaceBackup } from "../src/main/infrastructure/workspace-backup";
import { IsolatedRestore } from "../src/main/infrastructure/isolated-restore";
import { createRegisteredVideoLookup } from "../src/main/infrastructure/registered-video-source";
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
 return {db,binding,snapshot,bytes,dump,directory,root};
}
const counts=(db:ApplicationDatabase)=>['executions','films','command_receipts'].map(name=>db.connection.prepare(`SELECT count(*) AS n FROM ${name}`).get()!.n);
async function archived(t:Parameters<typeof fixture>[0]){const f=await fixture(t),recorder=createBoundArchiveRecorder(),written=await recorder.write(f.binding,f.snapshot,()=>true);assert.ok(written.capability);return {...f,recorder,capability:written.capability,target:written.archive!.receipt!.target};}
test("private physical capability atomically records neutral import metadata and strict replay without task changes",async t=>{
 const f=await archived(t),taskBefore=f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.binding.taskId);
 assert.equal((await f.recorder.commitToWorkspace(f.db,{...f.capability},f.binding)).status,'recording-unconfirmed');assert.deepEqual(counts(f.db),[0,0,0]);
 const result=await f.recorder.commitToWorkspace(f.db,f.capability,f.binding);assert.equal(result.status,'recorded');assert.deepEqual(counts(f.db),[1,1,1]);
 const execution=f.db.connection.prepare('SELECT * FROM executions').get()!;assert.equal(execution.operation,'local-import');assert.equal(execution.status,'recorded');assert.equal(execution.account_id,null);assert.equal(execution.remote_reference,null);
 assert.deepEqual(f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.binding.taskId),taskBefore);
 const before=f.dump();assert.equal((await f.recorder.commitToWorkspace(f.db,f.capability,f.binding)).status,'prior-recorded');assert.equal(f.dump(),before);
 assert.equal((await f.recorder.commitToWorkspace(f.db,f.capability,{...f.binding,requestId:randomUUID()})).status,'recording-unconfirmed');
 const otherConnection=new ApplicationDatabase(join(f.root,'workspace.sqlite'));try{assert.equal((await f.recorder.commitToWorkspace(otherConnection,f.capability,f.binding)).status,'recording-unconfirmed');assert.equal(f.recorder.readRecordedMetadata(otherConnection,f.binding)?.status,'prior-recorded');}finally{otherConnection.close();}
 f.recorder.close();const reopened=new ApplicationDatabase(join(f.root,'workspace.sqlite'));try{
  const fresh=createBoundArchiveRecorder();assert.equal(fresh.readRecordedMetadata(reopened,f.binding)?.status,'prior-recorded');
  assert.equal((await fresh.commitToWorkspace(reopened,f.capability,f.binding)).status,'recording-unconfirmed');assert.deepEqual(counts(reopened),[1,1,1]);
 }finally{reopened.close();}
 assert.deepEqual(await readFile(f.target),f.bytes);
});
test("stale revision, occupied identity/version, anomalous version and request conflicts never add rows or remove archive",async t=>{
 for(const kind of ['revision','execution','film','version','anomaly','request']){
  const f=await archived(t),db=f.db.connection;
  if(kind==='revision')db.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(f.binding.taskId);
  if(kind==='execution'||kind==='film'||kind==='version'||kind==='anomaly'){
   const eid=kind==='execution'?f.binding.executionId:randomUUID();db.prepare("INSERT INTO executions(id,task_id,operation,status,input_json,created_at,updated_at) VALUES(?,?,'video','completed','{}','synthetic','synthetic')").run(eid,f.binding.taskId);
   if(kind!=='execution')db.prepare("INSERT INTO films VALUES(?,?,?,'historical',?,'synthetic')").run(kind==='film'?f.binding.filmId:randomUUID(),eid,f.binding.taskId,kind==='anomaly'?0:1);
  }
  if(kind==='request')db.prepare("INSERT INTO command_receipts VALUES(?,'other','different','{}','synthetic')").run(f.binding.requestId);
  const before=f.dump();assert.equal((await f.recorder.commitToWorkspace(f.db,f.capability,f.binding)).status,'recording-unconfirmed');assert.equal(f.dump(),before);assert.deepEqual(await readFile(f.target),f.bytes);
 }
});
test("SQL failure rolls back all three records; revocation during hash never enters a write",async t=>{
 const f=await archived(t);f.db.connection.exec("CREATE TRIGGER reject_import_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
 const before=f.dump();assert.equal((await f.recorder.commitToWorkspace(f.db,f.capability,f.binding)).status,'recording-unconfirmed');assert.equal(f.dump(),before);assert.deepEqual(counts(f.db),[0,0,0]);assert.deepEqual(await readFile(f.target),f.bytes);
 const g=await archived(t),pending=g.recorder.commitToWorkspace(g.db,g.capability,g.binding);g.recorder.revoke(g.capability);
 assert.equal((await pending).status,'recording-unconfirmed');assert.deepEqual(counts(g.db),[0,0,0]);assert.deepEqual(await readFile(g.target),g.bytes);
});
test("V7 backup and isolated restore retain neutral metadata and replay only, never file or capability authority",async t=>{
 const f=await archived(t);assert.equal((await f.recorder.commitToWorkspace(f.db,f.capability,f.binding)).status,'recorded');
 const media=join(f.root,'media'),backups=join(f.root,'backups'),restores=await mkdtemp(join(tmpdir(),'dv-import-restores-'));t.after(()=>rm(restores,{recursive:true,force:true}));await mkdir(media);await mkdir(backups);
 const decode=async(_bytes:Buffer):Promise<{png:Buffer;width:number;height:number}>=>{throw Error('unexpected image');};
 const backup=await new WorkspaceBackup({database:f.db,mediaDirectory:media,applicationVersion:'synthetic',chooseDirectory:async()=>backups,decode}).create();assert.ok(backup);assert.equal(backup.databaseVersion,7);
 const restored=await new IsolatedRestore({currentWorkspace:f.root,decode}).restore(backup.directory,restores);assert.equal(restored.workspaceActivated,false);assert.equal(restored.videoFilesIncluded,false);
 const db=new ApplicationDatabase(join(restored.directory,'workspace.sqlite'));try{
  const fresh=createBoundArchiveRecorder(),before=counts(db);assert.equal(fresh.readRecordedMetadata(db,f.binding)?.status,'prior-recorded');assert.equal((await fresh.commitToWorkspace(db,f.capability,f.binding)).status,'recording-unconfirmed');assert.deepEqual(counts(db),before);
  const lookup=await createRegisteredVideoLookup(f.directory,[]);assert.equal(await lookup(f.binding.filmId),null);
  const snapshot=new WorkspaceRepository(db).snapshot();assert.ok(!JSON.stringify(snapshot.films).includes(f.directory));assert.equal(snapshot.films.length,1);
 }finally{db.close();}
 assert.deepEqual(await readFile(f.target),f.bytes);
});
test("final transaction guard observes changes made by lease callbacks before committing any rows",async t=>{
 const f=await fixture(t),recorder=createBoundArchiveRecorder();let callbacks=0;
 const target=join(f.directory,buildVideoBasename({taskId:f.binding.taskId,executionId:f.binding.executionId,version:f.binding.version,title:f.binding.title}));
 const written=await recorder.write(f.binding,f.snapshot,()=>{if(f.db.connection.isTransaction&&++callbacks===3)writeFileSync(target,Buffer.alloc(f.bytes.length,9));return true;});assert.ok(written.capability);
 assert.equal((await recorder.commitToWorkspace(f.db,written.capability,f.binding)).status,'recording-unconfirmed');assert.deepEqual(counts(f.db),[0,0,0]);assert.equal((await readFile(target)).length,f.bytes.length);
});
