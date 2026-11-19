import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { createApplicationServices } from "../src/main/application/services";
import { ExtraAssetDraftService, type ExtraAssetCapabilityEvidence } from "../src/main/application/extra-asset-draft";
import { addShot } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { addFrameCandidate, chooseFrame } from "../src/shared/frames";
import { editPrompt } from "../src/shared/prompts";
async function fixture() {
 const dir = mkdtempSync(join(tmpdir(), "preflight-")), database = new ApplicationDatabase(":memory:");
 const store = new ReferenceImageStore(database, dir, async bytes => { const r = await sharp(bytes).png().toBuffer({ resolveWithObject: true }); return { png:r.data,width:r.info.width,height:r.info.height }; });
 const services = createApplicationServices({database,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:dir,references:{async importForTask(){return null;},isAvailable:id=>store.isAvailable(id)}});
 const send = (command: string, input: unknown) => services.router.dispatch({requestId:randomUUID(),command,input},{trusted:true});
 const made = await send("plans.create",{title:"合成预检",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"}); assert.equal(made.ok,true);
 const tasks = services.repository.snapshot().tasks, task=tasks[0]!, account=services.repository.createAccount("合成账号");
 const file=join(dir,"synthetic.png"); writeFileSync(file,await sharp({create:{width:8,height:8,channels:3,background:"red"}}).png().toBuffer());
 const image=await store.importFile(task.id,file);
 const assetId=randomUUID(),shotId=randomUUID();
 let w=addAsset(addShot({...task.workspace,script:"合成测试正文"},shotId),assetId,"person");
 w={...w,assets:w.assets.map(a=>({...a,referenceImageId:image.id,name:"合成人物",description:"合成描述"}))};
 w=setAssetLink(w,assetId,shotId,true);
 w=editPrompt(w,"comic","video",null,"已确认原文，不能被格式化器替换");
 for(const role of ["first","last"] as const){ const id=randomUUID(); w=chooseFrame(addFrameCandidate(w,"comic",role,image.id,id,"2026-11-19T00:00:00.000Z"),role,id); }
 assert.equal((await send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:w})).ok,true);
 assert.equal((await send("tasks.confirmFrames",{id:task.id,expectedRevision:services.repository.getTask(task.id).revision})).ok,true);
 const input={taskId:task.id,accountId:account.id,expectedRevision:services.repository.getTask(task.id).revision,selectedAssetIds:[assetId]};
 const evidence: ExtraAssetCapabilityEvidence={provider:"doubao",accountId:account.id,evidenceId:randomUUID(),observedAt:100,expiresAt:200,login:"verified",charge:"verified-free",mode:"first-last",roles:["first","last"],aspectRatios:["16:9"],durations:[5],maxExtraImages:1,additionalReferences:[{role:"extra-reference-image",types:["person"]}]};
 let currentEvidence:unknown=evidence;
 const service=new ExtraAssetDraftService(database,store,{read(){return currentEvidence;}},()=>150);
 return {database,store,services,send,input,evidence,dir,image,tasks,assetId,service,setEvidence(value:unknown){currentEvidence=value;},close(){database.close();rmSync(dir,{recursive:true,force:true});}};
}
test("explicit selection seals confirmed prompt, endpoint roles and actual asset bytes without writes",async()=>{
 const f=await fixture();try{
 const before=f.services.repository.snapshot(), draft=f.service.preview(f.input);
 assert.equal(draft.status,"draft-only");if(draft.status!=="draft-only")throw Error("blocked");
 assert.equal(draft.capabilityBlocker,null);assert.equal(draft.snapshot.assets.length,1);
 assert.equal(draft.snapshot.assets[0]!.assetId,f.assetId);assert.equal(draft.snapshot.assets[0]!.metadataFingerprint.length,64);
 assert.deepEqual(draft.snapshot.frames.map(i=>i.role),["first","last"]);
 assert.equal(draft.snapshot.video.text,"已确认原文，不能被格式化器替换");
 assert.equal(Object.isFrozen(draft.snapshot.assets[0]!.metadata),true);
 assert.equal(Reflect.set(draft.snapshot.assets[0]!.metadata,"name","altered"),false);
 assert.equal(f.service.confirm(draft,{accepted:false}).status,"blocked");
 const confirmed=f.service.confirm(draft,{accepted:true});assert.equal(confirmed.status,"local-confirmed-only");assert.equal(confirmed.submitted,false);
 assert.equal(f.service.confirm(structuredClone(draft),{accepted:true}).status,"blocked");
 const other=new ExtraAssetDraftService(f.database,f.store,{read:()=>f.evidence},()=>150);
 assert.equal(other.confirm(draft,{accepted:true}).status,"blocked");
 assert.deepEqual(f.services.repository.snapshot(),before);assert.doesNotMatch(JSON.stringify(confirmed),/synthetic.png|Buffer|references\//);
 }finally{f.close();}
});
test("capability-blocked preview remains useful, but same first-last role/type and verified free login required",async()=>{
 const f=await fixture();try{
 for(const value of [null,{...f.evidence,maxExtraImages:0},{...f.evidence,charge:"paid"},{...f.evidence,mode:"other"},{...f.evidence,roles:["first"]},
 {...f.evidence,additionalReferences:[]},{...f.evidence,additionalReferences:[{role:"extra-reference-image",types:["scene"]}]},
 {...f.evidence,accountId:randomUUID()},{...f.evidence,expiresAt:150}]){
 f.setEvidence(value);const draft=f.service.preview(f.input);assert.equal(draft.status,"draft-only");if(draft.status!=="draft-only")throw Error("blocked");
 assert.ok(draft.capabilityBlocker);assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");
 }
 f.setEvidence(f.evidence);const draft=f.service.preview(f.input);f.setEvidence(null);assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");
 }finally{f.close();}
});
test("unknown, unlinked, missing or damaged asset bytes and missing/duplicate opt-in are rejected",async()=>{
 const f=await fixture();try{
 for(const selectedAssetIds of [[],[randomUUID()],[f.assetId,f.assetId]])assert.equal(f.service.preview({...f.input,selectedAssetIds}).status,"blocked");
 const missing={...f.input};delete(missing as Partial<typeof missing>).selectedAssetIds;assert.equal(f.service.preview(missing).status,"blocked");
 const original=f.services.repository.getTask(f.input.taskId).workspace;
 const unlinkedId=randomUUID(), withUnlinked=addAsset(original,unlinkedId,"prop");
 f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(withUnlinked),f.input.taskId);
 assert.deepEqual(f.service.preview({...f.input,selectedAssetIds:[unlinkedId]}),{status:"blocked",reason:"ASSET_NOT_LINKED",submitted:false});
 f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(original),f.input.taskId);
 const bytes=f.store.readVerifiedBytes(f.image.id)!;
 f.database.connection.prepare("UPDATE reference_images SET task_id=? WHERE id=?").run(f.tasks[1]!.id,f.image.id);
 assert.equal(f.service.preview(f.input).status,"blocked");
 f.database.connection.prepare("UPDATE reference_images SET task_id=? WHERE id=?").run(f.input.taskId,f.image.id);
 const draft=f.service.preview(f.input);
 const archived=join(f.dir,"references",`${f.image.id}.png`);
 renameSync(archived,archived+".missing");assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");renameSync(archived+".missing",archived);
 writeFileSync(join(f.dir,"references",`${f.image.id}.png`),await sharp({create:{width:8,height:8,channels:3,background:"blue"}}).png().toBuffer());
 assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");
 writeFileSync(join(f.dir,"references",`${f.image.id}.png`),bytes);
 assert.equal(f.service.confirm(draft,{accepted:true}).status,"local-confirmed-only");
 writeFileSync(join(f.dir,"references",`${f.image.id}.png`),"broken");
 assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");assert.equal(f.service.preview(f.input).status,"blocked");
 }finally{f.close();}
});
test("saved task changes invalidate old preview; metadata fingerprint also rejects out-of-band changes",async()=>{
 const f=await fixture();try{
 const draft=f.service.preview(f.input), task=f.services.repository.getTask(f.input.taskId);
 const changed={...task.workspace,viewport:{x:1,y:2,zoom:1}};
 assert.equal((await f.send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:changed})).ok,true);
 assert.equal(f.service.confirm(draft,{accepted:true}).status,"blocked");
 const fresh=f.service.preview({...f.input,expectedRevision:f.services.repository.getTask(task.id).revision});assert.equal(fresh.status,"draft-only");
 // Trusted persisted metadata can still be tampered outside normal revision writers: fingerprint notices it.
 const row=f.database.connection.prepare("SELECT workspace_json FROM tasks WHERE id=?").get(task.id)!;
 const w=JSON.parse(String(row.workspace_json));w.assets[0].version+=1;w.assets[0].position.x=999;
 f.database.connection.prepare("UPDATE tasks SET workspace_json=? WHERE id=?").run(JSON.stringify(w),task.id);
 assert.deepEqual(f.service.confirm(fresh,{accepted:true}),{status:"blocked",reason:"STALE_DRAFT",submitted:false});
 }finally{f.close();}
});
