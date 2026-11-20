import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,lstat,readdir,rm,readFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {existsSync,readdirSync} from 'node:fs';
import {ApplicationDatabase} from '../src/main/infrastructure/database';
import {WorkspaceRepository} from '../src/main/infrastructure/workspace-repository';
import {VideoProbeRegistry} from '../src/main/application/video-probe-registry';
import {localFilmImportNotice} from '../src/renderer/src/pages/local-film-import-state';
import {createLocalImportCommand} from '../src/main/application/local-import-command';
import {SYNTHETIC_MP4_BASE64} from './fixtures/f17-native-smoke-mp4';
const frame={status:'first-presented-frame',evidence:{durationSeconds:1,videoWidth:160,videoHeight:90,width:160,height:90,mediaTime:0,presentedFrames:1}};
async function setup(t:{after:(f:()=>Promise<void>)=>unknown},mode='normal'){
 const root=await mkdtemp(join(tmpdir(),'dv-command-')),source=join(root,'source.mp4'),archive=join(root,'archive'),stage=join(root,'stage');await mkdir(archive);await mkdir(stage);
 const bytes=Buffer.from(SYNTHETIC_MP4_BASE64,'base64');await writeFile(source,bytes);const db=new ApplicationDatabase(join(root,'workspace.sqlite'));
 t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const task=db.transaction(()=>new WorkspaceRepository(db).createPlan({title:'Synthetic command',style:'comic',startDate:'2026-11-19',dailyCount:1,executionTime:'09:00'})).tasks[0]!;
 let live=true,hosts=0,confirmations=0,selections=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>entered=r);
 const command=createLocalImportCommand({database:db,stagingParent:stage,origin:{windowId:1,documentId:randomUUID(),epoch:1},
  isCurrent(){if(mode==='late-close'&&readdirSync(archive).some(f=>f.endsWith('.mp4')))live=false;return live;},
  async selectSource(){selections++;if(mode==='hold'){entered();await gate;}return mode==='cancel-source'?null:{path:source,selection:await lstat(source)};},
  async selectDestination(){return mode==='cancel-destination'?null:archive;},isAllowedDestination(directory){return directory===archive&&!(mode==='revoked-destination'&&confirmations>0);},
  async confirm(){confirmations++;if(mode==='stale-confirm')db.connection.prepare('UPDATE tasks SET revision=revision+1 WHERE id=?').run(task.id);return mode!=='reject';},
  archivePreflightIO:mode==='denied-directory'?{async link(){throw Object.assign(Error('private diagnostic'),{code:'EPERM'});}}:undefined,
  createProbeHost(){hosts++;const owner={ownerId:44,documentId:randomUUID()};let active=true;
   const registry=new VideoProbeRegistry({isLive:(id,doc)=>active&&id===owner.ownerId&&doc===owner.documentId});
   return {owner,registry,async probe(url:string){const response=await registry.response(new Request(url),owner);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);if(mode==='swap-destination'){await rename(archive,archive+'-original');await mkdir(archive);}return frame;},async stop(){active=false;if(mode==='hanging-stop')return new Promise<boolean>(()=>{});return true;}};
  }});
 return {command,db,task,root,source,archive,stage,bytes,release,waiting,close:()=>{live=false;},get hosts(){return hosts;},get confirmations(){return confirmations;},get selections(){return selections;}};
}
const rows=(db:ApplicationDatabase)=>['films','executions','command_receipts'].map(table=>db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
test('explicit command performs real synthetic archive/SQLite pipeline with redacted outcome and unchanged task',async t=>{
 const f=await setup(t),before=f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id);
 const result=await f.command.run({taskId:f.task.id,revision:f.task.revision});
 assert.deepEqual(rows(f.db),[1,1,1]);assert.equal(f.hosts,1);assert.equal(f.confirmations,1);
 assert.deepEqual(f.db.connection.prepare('SELECT * FROM tasks WHERE id=?').get(f.task.id),before);
 const files=await readdir(f.archive);assert.equal(files.length,1);assert.deepEqual(await readFile(join(f.archive,files[0]!)),f.bytes);assert.deepEqual(await readFile(f.source),f.bytes);assert.deepEqual(await readdir(f.stage),[]);
 const output=JSON.stringify(result);for(const sensitive of [f.root,f.task.id,'app://','Synthetic command','source.mp4'])assert.ok(!output.includes(sensitive));
});
test('selection cancellation, rejected confirmation and revision drift produce no archive or host',async t=>{
 for(const mode of ['cancel-source','cancel-destination','reject','stale-confirm','revoked-destination']){const f=await setup(t,mode);await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.deepEqual(rows(f.db),[0,0,0]);assert.deepEqual(await readdir(f.archive),[]);assert.equal(f.hosts,0);}
});
test('origin loss after exclusive publication preserves file with no metadata and redacted truthful outcome',async t=>{
 const f=await setup(t,'late-close');const result=await f.command.run({taskId:f.task.id,revision:f.task.revision});
 assert.equal((await readdir(f.archive)).length,1);assert.deepEqual(rows(f.db),[0,0,0]);assert.match(JSON.stringify(result),/published/);assert.ok(!JSON.stringify(result).includes(f.root));
});
test('busy invalidation and renderer path injection cannot start an extra selection',async t=>{
 const f=await setup(t,'hold');await f.command.run({taskId:f.task.id,revision:f.task.revision,path:f.source});assert.equal(f.selections,0);
 const pending=f.command.run({taskId:f.task.id,revision:f.task.revision});await f.waiting;
 await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.equal(f.selections,1);f.close();f.release();await pending;assert.equal(f.hosts,0);assert.deepEqual(rows(f.db),[0,0,0]);
});

test('unconfirmed native stop remains bounded and reports retained cleanup instead of hanging command',async t=>{
 const f=await setup(t,'hanging-stop');const result=await f.command.run({taskId:f.task.id,revision:f.task.revision});
 assert.equal(result.status,'cleanup-unconfirmed');assert.equal(result.cleanupConfirmed,false);assert.deepEqual(rows(f.db),[0,0,0]);assert.deepEqual(await readdir(f.archive),[]);assert.equal((await readdir(f.stage)).length,1);
});

test('confirmed destination replacement during decoding cannot be used as a new archive root',async t=>{
 const f=await setup(t,'swap-destination');await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.deepEqual(rows(f.db),[0,0,0]);assert.deepEqual(await readdir(f.archive),[]);assert.deepEqual(await readdir(f.archive+'-original'),[]);
});

test('unsupported actual destination check gates decoder and staging with fixed UI text',async t=>{
 const f=await setup(t,'denied-directory');
 const result=await f.command.run({taskId:f.task.id,revision:f.task.revision});
 assert.deepEqual(result,{status:'destination-unsupported',archiveStatus:'none',recordStatus:'none',cleanupConfirmed:true,automaticRetry:false,mediaPlaybackAuthorized:false});
 assert.equal(f.confirmations,1);assert.equal(f.hosts,0);assert.deepEqual(rows(f.db),[0,0,0]);
 assert.deepEqual(await readdir(f.archive),[]);assert.deepEqual(await readdir(f.stage),[]);
 assert.deepEqual(await readFile(f.source),f.bytes);
 assert.match(localFilmImportNotice(result).message,/不支持安全的独占保存/);
 assert.equal(localFilmImportNotice(result).refresh,false);
});
