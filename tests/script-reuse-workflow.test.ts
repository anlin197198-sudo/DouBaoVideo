import {ScriptReuseWorkflow} from "../src/main/application/script-reuse-workflow";
import {acceptScriptReuseDraft,type ScriptReusePreview,type ScriptReuseDraft} from "../src/shared/script-reuse-draft";
import type {CommandResult} from "../src/shared/bridge";
import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ApplicationDatabase} from "../src/main/infrastructure/database";
import {createApplicationServices} from "../src/main/application/services";
import {ScriptReuseService,type ScriptReuseInput} from "../src/main/application/script-reuse";
import {addShot} from "../src/shared/storyboard";
import {addAsset} from "../src/shared/assets";
import {setAssetLink} from "../src/shared/asset-links";
import sharp from "sharp";
import {ReferenceImageStore} from "../src/main/infrastructure/reference-image-store";
import {addFrameCandidate,chooseFrame} from "../src/shared/frames";
import {editPrompt} from "../src/shared/prompts";
async function fixture(){
 const dir=mkdtempSync(join(tmpdir(),"script-reuse-")),path=join(dir,"workspace.sqlite"),database=new ApplicationDatabase(path);
 const store=new ReferenceImageStore(database,dir,async bytes=>{const r=await sharp(bytes).png().toBuffer({resolveWithObject:true});return {png:r.data,width:r.info.width,height:r.info.height};});
 const services=createApplicationServices({database,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:dir,references:{async importForTask(){return null;},isAvailable:id=>store.isAvailable(id)}});
 const send=(command:string,input:unknown)=>services.router.dispatch({requestId:randomUUID(),command,input},{trusted:true});
 assert.equal((await send("plans.create",{title:"合成",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).ok,true);
 const taskId=services.repository.snapshot().tasks[0]!.id;
 for(const script of ["旧历史正文","当前已保存正文"]){const t=services.repository.getTask(taskId);assert.equal((await send("tasks.saveWorkspace",{id:taskId,expectedRevision:t.revision,workspace:{...t.workspace,script}})).ok,true);}
 const t=services.repository.getTask(taskId),shotId=randomUUID(),assetId=randomUUID();
 let w=addAsset(addShot(t.workspace,shotId),assetId,"prop");w=setAssetLink(w,assetId,shotId,true);w=editPrompt(w,"comic","video",null,"人工提示词");
 const file=join(dir,"synthetic.png");writeFileSync(file,await sharp({create:{width:8,height:8,channels:3,background:"red"}}).png().toBuffer());const image=await store.importFile(taskId,file);
 for(const slot of ["first","last"] as const){const id=randomUUID();w=chooseFrame(addFrameCandidate(w,"comic",slot,image.id,id,"2026-11-19T00:00:00Z"),slot,id);}
 assert.equal((await send("tasks.saveWorkspace",{id:taskId,expectedRevision:t.revision,workspace:w})).ok,true);
 assert.equal((await send("tasks.confirmFrames",{id:taskId,expectedRevision:services.repository.getTask(taskId).revision})).ok,true);
 const task=services.repository.getTask(taskId),service=new ScriptReuseService(database);
 const input:ScriptReuseInput={taskId,revision:task.revision,workspace:task.workspace,planStyle:"comic",saveState:{dirty:false,saving:false,error:null,conflict:false},accepted:true};
 return {database,services,send,service,input,path,preview:(version=1)=>service.preview({taskId,expectedRevision:task.revision,historyVersion:version}),close(){if(database.connection.isOpen)database.close();rmSync(dir,{recursive:true,force:true});}};
}
test("strict trusted IPC tokens are task-bound, single-use, and return only drafts without receipts or history writes",async()=>{
 const f=await fixture();try{
 const id=f.input.taskId,rev=f.input.revision,before=f.services.repository.getTask(id),count=f.database.connection.prepare("SELECT count(*) n FROM command_receipts").get()!.n;
 assert.equal((await f.services.router.dispatch({requestId:randomUUID(),command:"scripts.previewReuse",input:{taskId:id,expectedRevision:rev,version:1}},{trusted:false})).ok,false);
 for(const input of [{taskId:id,expectedRevision:rev,version:1,accepted:true},{taskId:id,expectedRevision:rev,version:0}])assert.equal((await f.send("scripts.previewReuse",input)).ok,false);
 const response=await f.send("scripts.previewReuse",{taskId:id,expectedRevision:rev,version:1}) as CommandResult<ScriptReusePreview>;assert.ok(response.ok);const preview=response.data;
 assert.equal(preview.history.text,"旧历史正文");assert.equal(preview.currentText,"当前已保存正文");
 assert.equal((await f.send("scripts.applyReuse",{taskId:randomUUID(),expectedRevision:rev,token:preview.token})).ok,false);
 assert.equal((await f.send("scripts.applyReuse",{taskId:id,expectedRevision:rev,token:randomUUID()})).ok,false);
 const applied=await f.send("scripts.applyReuse",{taskId:id,expectedRevision:rev,token:preview.token}) as CommandResult<ScriptReuseDraft>;assert.ok(applied.ok);assert.equal(applied.data.workspace.script,"旧历史正文");
 assert.equal((await f.send("scripts.applyReuse",{taskId:id,expectedRevision:rev,token:preview.token})).ok,false);
 assert.deepEqual(f.services.repository.getTask(id),before);assert.equal(f.database.connection.prepare("SELECT count(*) n FROM command_receipts").get()!.n,count);
 const live={taskId:id,revision:rev,workspace:before.workspace,plan:"comic" as const,state:{dirty:false,saving:false,error:null,conflict:false}};
 assert.ok(acceptScriptReuseDraft(applied.data,live));for(const patch of [{revision:rev+1},{taskId:randomUUID()},{plan:"realistic" as const},{workspace:{...before.workspace,script:"new draft"}},...[{dirty:true},{saving:true},{conflict:true},{error:"error"}].map(p=>({state:{...live.state,...p}}))])assert.equal(acceptScriptReuseDraft(applied.data,{...live,...patch}),null);
 assert.equal((await f.send("tasks.saveWorkspace",{id,expectedRevision:rev,workspace:applied.data.workspace})).ok,true);assert.equal(f.services.repository.getScriptHistory({taskId:id,version:3}).text,"旧历史正文");assert.equal(f.services.repository.getScriptHistory({taskId:id,version:2}).text,"当前已保存正文");
 }finally{f.close();}
});
test("actual saved changes reject preview application; token expiry and capacity stay bounded",async()=>{
 const f=await fixture();try{
 let now=1000;const workflow=new ScriptReuseWorkflow(f.database,()=>now),request={taskId:f.input.taskId,expectedRevision:f.input.revision,version:1};
 const preview=workflow.preview(request);now+=300000;assert.throws(()=>workflow.apply({taskId:request.taskId,expectedRevision:request.expectedRevision,token:preview.token}));
 const second=workflow.preview(request);const changed={...f.input.workspace,viewport:{x:5,y:0,zoom:1}};
 assert.equal((await f.send("tasks.saveWorkspace",{id:request.taskId,expectedRevision:request.expectedRevision,workspace:changed})).ok,true);
 assert.throws(()=>workflow.apply({taskId:request.taskId,expectedRevision:request.expectedRevision,token:second.token}));
 const current={...request,expectedRevision:f.services.repository.getTask(request.taskId).revision};const bounded=new ScriptReuseWorkflow(f.database,()=>now);
 for(let i=0;i<32;i++)bounded.preview(current);assert.throws(()=>bounded.preview(current));now+=300001;assert.ok(bounded.preview(current).token);
 }finally{f.close();}
});
test("late response cannot replace local edits; cancelled response can be discarded without a durable change",async()=>{
 const f=await fixture();try{
 const workflow=new ScriptReuseWorkflow(f.database),preview=workflow.preview({taskId:f.input.taskId,expectedRevision:f.input.revision,version:1});
 let resolve!:(value:ScriptReuseDraft)=>void;const delayed=new Promise<ScriptReuseDraft>(r=>{resolve=r;});
 let state={taskId:f.input.taskId,revision:f.input.revision,workspace:f.input.workspace,plan:"comic" as const,state:{dirty:false,saving:false,error:null as string|null,conflict:false}};
 const result=delayed.then(value=>acceptScriptReuseDraft(value,state));state={...state,workspace:{...state.workspace,script:"local newer"},state:{...state.state,dirty:true}};
 resolve(workflow.apply({taskId:f.input.taskId,expectedRevision:f.input.revision,token:preview.token}));assert.equal(await result,null);assert.equal(f.services.repository.getTask(f.input.taskId).workspace.script,"当前已保存正文");
 }finally{f.close();}
});
