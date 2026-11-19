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
test("same-task repository history becomes only a new draft; normal save appends and reopen preserves old versions",async()=>{
 const f=await fixture();try{
 const before=structuredClone(f.input.workspace),historyBefore=f.services.repository.listScriptHistory({taskId:f.input.taskId});
 const preview=f.preview();assert.equal(preview.status,"draft-preview");if(preview.status!=="draft-preview")throw Error("blocked");assert.equal(Object.isFrozen(preview.history),true);
 const result=f.service.apply(preview,f.input);assert.equal(result.status,"draft-applied");if(result.status!=="draft-applied")throw Error("blocked");
 assert.equal(result.workspace.script,"旧历史正文");assert.deepEqual(result.workspace.assetLinks,before.assetLinks);assert.deepEqual(result.workspace.prompts,before.prompts);
 assert.deepEqual(result.workspace.viewport,before.viewport);assert.deepEqual(result.workspace.shots[0]!.position,before.shots[0]!.position);
 assert.equal(result.workspace.frames!.confirmation!.invalidated,true);
 assert.equal(before.frames!.confirmation!.invalidated,false);
 assert.equal(result.workspace.shots[0]!.needsReview,true);assert.equal(result.workspace.assets[0]!.needsReview,true);
 assert.deepEqual(f.input.workspace,before);assert.deepEqual(f.services.repository.getTask(f.input.taskId).workspace,before);assert.deepEqual(f.services.repository.listScriptHistory({taskId:f.input.taskId}),historyBefore);
 assert.equal(f.service.apply(preview,f.input).status,"blocked");
 assert.equal((await f.send("tasks.saveWorkspace",{id:f.input.taskId,expectedRevision:f.input.revision,workspace:result.workspace})).ok,true);
 f.database.close();const reopened=new ApplicationDatabase(f.path);try{const s=createApplicationServices({database:reopened,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:"test"});
 assert.equal(s.repository.getTask(f.input.taskId).workspace.script,"旧历史正文");assert.deepEqual(s.repository.listScriptHistory({taskId:f.input.taskId}).items.map(i=>i.version),[3,2,1]);
 assert.equal(s.repository.getScriptHistory({taskId:f.input.taskId,version:2}).text,"当前已保存正文");assert.equal(s.repository.getScriptHistory({taskId:f.input.taskId,version:1}).text,"旧历史正文");}finally{reopened.close();}
 }finally{f.close();}
});
test("unsaved, declined, forged, other-task and stale contexts cannot reuse history",async()=>{
 const f=await fixture();try{
 const preview=f.preview();
 for(const patch of [{accepted:false},{taskId:randomUUID()},{revision:f.input.revision+1},{planStyle:"realistic" as const},
 ...[{dirty:true},{saving:true},{conflict:true},{error:"private"}].map(p=>({saveState:{...f.input.saveState,...p}}))])assert.equal(f.service.apply(preview,{...f.input,...patch}).status,"blocked");
 assert.equal(f.service.apply(structuredClone(preview),f.input).status,"blocked");assert.equal(new ScriptReuseService(f.database).apply(preview,f.input).status,"blocked");
 assert.equal(f.service.apply(preview,{...f.input,workspace:{...f.input.workspace,script:"草稿"}}).status,"blocked");
 const other=f.services.repository.snapshot().tasks[1]!;assert.equal(f.service.preview({taskId:other.id,expectedRevision:other.revision,historyVersion:1}).status,"blocked");
 f.database.connection.prepare("UPDATE plans SET style_notes='changed' WHERE id=(SELECT plan_id FROM tasks WHERE id=?)").run(f.input.taskId);
 assert.equal(f.service.apply(preview,f.input).status,"blocked");
 }finally{f.close();}
});
test("same text no-change consumes once without history; bad input and nested apply have fixed failures",async()=>{
 const f=await fixture();try{
 assert.equal(f.service.preview({get taskId(){throw Error("secret");}} as never).status,"blocked");
 const preview=f.preview(2);const before=f.services.repository.listScriptHistory({taskId:f.input.taskId});let nested:unknown;
 const input={...f.input,get accepted(){nested=f.service.apply(preview,f.input);return true;}};
 assert.equal(f.service.apply(preview,input).status,"no-change");assert.deepEqual(nested,{status:"blocked",reason:"APPLYING"});assert.equal(f.service.apply(preview,f.input).status,"blocked");
 assert.deepEqual(f.services.repository.listScriptHistory({taskId:f.input.taskId}),before);
 }finally{f.close();}
});

test("actual concurrent save rejects old preview and empty history reuses as new blank draft/version",async()=>{
 const f=await fixture();try{
 const old=f.preview();
 for(const script of ["","之后的新稿"]){const t=f.services.repository.getTask(f.input.taskId);assert.equal((await f.send("tasks.saveWorkspace",{id:t.id,expectedRevision:t.revision,workspace:{...t.workspace,script}})).ok,true);}
 assert.equal(f.service.apply(old,f.input).status,"blocked");
 const task=f.services.repository.getTask(f.input.taskId),preview=f.service.preview({taskId:task.id,expectedRevision:task.revision,historyVersion:3});
 assert.equal(preview.status,"draft-preview");if(preview.status!=="draft-preview")throw Error("blocked");assert.equal(preview.history.text,"");
 const result=f.service.apply(preview,{...f.input,revision:task.revision,workspace:task.workspace});assert.equal(result.status,"draft-applied");if(result.status!=="draft-applied")throw Error("blocked");assert.equal(result.workspace.script,"");
 assert.equal((await f.send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:result.workspace})).ok,true);
 assert.equal(f.services.repository.getScriptHistory({taskId:task.id,version:5}).text,"");assert.equal(f.services.repository.getScriptHistory({taskId:task.id,version:4}).text,"之后的新稿");
 }finally{f.close();}
});
