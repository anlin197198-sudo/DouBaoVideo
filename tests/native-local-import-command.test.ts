import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ApplicationDatabase} from '../src/main/infrastructure/database';
import {WorkspaceRepository} from '../src/main/infrastructure/workspace-repository';
import {createNativeLocalImportCommand} from '../src/main/electron/local-import-command-adapter';
import {SYNTHETIC_MP4_BASE64} from './fixtures/f17-native-smoke-mp4';
async function fixture(t:{after:(f:()=>Promise<void>)=>unknown},mode='reject'){
 const root=await mkdtemp(join(tmpdir(),'dv-native-command-')),source=join(root,'private-source.mp4'),archive=join(root,'archive'),stage=join(root,'stage');await mkdir(archive);await mkdir(stage);await writeFile(source,Buffer.from(SYNTHETIC_MP4_BASE64,'base64'));
 const db=new ApplicationDatabase(join(root,'workspace.sqlite'));t.after(async()=>{db.close();await rm(root,{recursive:true,force:true});});
 const task=db.transaction(()=>new WorkspaceRepository(db).createPlan({title:'Synthetic native confirmation',style:'comic',startDate:'2026-11-19',dailyCount:1,executionTime:'09:00'})).tasks[0]!;
 const contents=Object.assign(new EventEmitter(),{id:2,isDestroyed:()=>false});const window=Object.assign(new EventEmitter(),{id:1,webContents:contents,isDestroyed:()=>false});let epoch=1,created=0;const calls:{kind:string;owner:unknown;options:any}[]=[];
 const options={window,documentId:randomUUID(),epoch:1,getEpoch:()=>epoch,database:db,stagingParent:stage,rendererDirectory:join(root,'no-renderer'),
  isCurrentEditor:()=>true,isAllowedDestination:(path:string)=>path===archive,
  electron:{session:{fromPartition(){created++;throw Error();}},BrowserWindow:class{constructor(){created++;throw Error();}},dialog:{
   async showOpenDialog(owner:unknown,opts:any){calls.push({kind:'open',owner,options:opts});
    if(calls.length===1){if(mode==='epoch-source')epoch++;if(mode==='navigate-source')contents.emit('did-start-navigation',{},'other',false,true);return {canceled:mode==='cancel-source',filePaths:mode==='multiple'?[source,source]:mode==='wrong-extension'?[source+'.txt']:[source]};}
    if(mode==='replace-contents')window.webContents=Object.assign(new EventEmitter(),{id:2,isDestroyed:()=>false});
    return {canceled:mode==='cancel-target',filePaths:[archive]};},
   async showMessageBox(owner:unknown,opts:any){calls.push({kind:'confirm',owner,options:opts});return {response:opts.cancelId,checkboxChecked:false};},
  }}};
 const command=createNativeLocalImportCommand(options as unknown as Parameters<typeof createNativeLocalImportCommand>[0]);
 t.after(async()=>{command.close();});return {command,task,db,root,source,archive,calls,window,get created(){return created;}};
}
test('native adapter binds all dialogs to initiating window, uses single file/existing directory and default-cancel confirmation',async t=>{
 const f=await fixture(t);const result=await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.equal(result.status,'cancelled');assert.equal(f.calls.length,3);
 for(const call of f.calls)assert.equal(call.owner,f.window);
 assert.deepEqual(f.calls[0]!.options.properties,['openFile']);assert.deepEqual(f.calls[0]!.options.filters,[{name:'MP4 视频',extensions:['mp4']}]);
 assert.deepEqual(f.calls[1]!.options.properties,['openDirectory']);const box=f.calls[2]!.options;assert.equal(box.defaultId,box.cancelId);assert.equal(box.noLink,true);
 const message=JSON.stringify(box);assert.ok(message.includes('Synthetic native confirmation'));assert.ok(message.includes('1923'));assert.ok(message.includes(f.archive));assert.ok(!message.includes(f.source));
 assert.equal(f.created,0);assert.deepEqual(await readdir(f.archive),[]);assert.equal(f.db.connection.prepare('SELECT count(*) AS n FROM films').get()!.n,0);
});
test('cancelled or multiple source and cancelled target never reach a decoder or write',async t=>{
 for(const mode of ['cancel-source','multiple','wrong-extension','cancel-target']){const f=await fixture(t,mode);await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.equal(f.created,0);assert.ok(f.calls.every(c=>c.kind!=='confirm'));assert.deepEqual(await readdir(f.archive),[]);}
});
test('native document epoch changes and top navigation invalidate source selection before destination/confirmation',async t=>{
 for(const mode of ['epoch-source','navigate-source']){const f=await fixture(t,mode);await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.equal(f.calls.length,1);assert.equal(f.created,0);assert.deepEqual(await readdir(f.archive),[]);}
});

test('same numeric webContents ID cannot substitute a different document object after destination selection',async t=>{
 const f=await fixture(t,'replace-contents');await f.command.run({taskId:f.task.id,revision:f.task.revision});assert.equal(f.calls.length,2);assert.equal(f.created,0);assert.deepEqual(await readdir(f.archive),[]);
});
