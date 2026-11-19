import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { createApplicationServices } from "../src/main/application/services";
import { VideoPreflight, type VideoCapabilityEvidence, type VideoPreflightInput } from "../src/main/application/video-preflight";
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
 let w=editPrompt(task.workspace,"comic","video",null,"已确认原文，不能被格式化器替换");
 for(const role of ["first","last"] as const){ const id=randomUUID(); w=chooseFrame(addFrameCandidate(w,"comic",role,image.id,id,"2026-11-19T00:00:00.000Z"),role,id); }
 assert.equal((await send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:w})).ok,true);
 assert.equal((await send("tasks.confirmFrames",{id:task.id,expectedRevision:services.repository.getTask(task.id).revision})).ok,true);
 const input: VideoPreflightInput={taskId:task.id,accountId:account.id,expectedRevision:services.repository.getTask(task.id).revision,selectedExtraAssetIds:[],requiredExtraAssetIds:[]};
 const evidence: VideoCapabilityEvidence={provider:"doubao",accountId:account.id,evidenceId:randomUUID(),observedAt:100,expiresAt:200,login:"verified",charge:"verified-free",roles:["first","last"],aspectRatios:["16:9"],durations:[5]};
 return {database,store,services,send,input,evidence,dir,image,tasks, check:(value:unknown=evidence,request=input)=>new VideoPreflight(database,store,{read(){return value;}},()=>150).check(request),close(){database.close();rmSync(dir,{recursive:true,force:true});}};
}
test("preflight reads saved confirmed content and exact hashed same-image roles without writing or sending",async()=>{
 const f=await fixture(); try{
 const before=f.services.repository.snapshot(), receipts=f.database.connection.prepare("SELECT count(*) n FROM command_receipts").get()!.n;
 const result=f.check(); assert.equal(result.status,"preflight-only"); if(result.status!=="preflight-only")throw Error("Unexpected blocker");
 const saved=f.services.repository.getTask(f.input.taskId).workspace.prompts!.find(p=>p.kind==="video")!;
 assert.equal(result.video.version,saved.version); assert.equal(result.video.inputSnapshot,saved.inputSnapshot);
 assert.equal(result.submitted,false); assert.equal(result.video.text,"已确认原文，不能被格式化器替换");
 assert.deepEqual(result.images.map(i=>i.role),["first","last"]); assert.equal(result.images[0]!.imageId,result.images[1]!.imageId);assert.notEqual(result.images[0]!.candidateId,result.images[1]!.candidateId);
 assert.equal(result.images[0]!.sha256.length,64); assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.images)&&Object.isFrozen(result.video));
 assert.doesNotMatch(JSON.stringify(result),/synthetic.png|references\/|Buffer/);
 assert.deepEqual(f.services.repository.snapshot(),before);assert.equal(f.database.connection.prepare("SELECT count(*) n FROM command_receipts").get()!.n,receipts);
 }finally{f.close();}
});
test("evidence fails closed for unknown paid stale scope and unsupported parameters; extras must be declared",async()=>{
 const f=await fixture();try{
 for(const evidence of [null,{}, {...f.evidence,charge:"paid"},{...f.evidence,login:"unknown"},{...f.evidence,accountId:randomUUID()}, {...f.evidence,provider:"other"},{...f.evidence,observedAt:151},{...f.evidence,expiresAt:150},{...f.evidence,extra:true}]) assert.equal(f.check(evidence).status,"blocked");
 for(const patch of [{roles:["first"]},{durations:[10]},{aspectRatios:["1:1"]}]) assert.deepEqual(f.check({...f.evidence,...patch}),{status:"blocked",reason:"UNSUPPORTED_INPUT",submitted:false});
 assert.equal(f.check(f.evidence,{...f.input,selectedExtraAssetIds:[randomUUID()]}).status,"blocked");
 assert.equal(f.check(f.evidence,{...f.input,requiredExtraAssetIds:[randomUUID()]}).status,"blocked");
 const missing={...f.input};delete (missing as Partial<typeof missing>).selectedExtraAssetIds;assert.equal(f.check(f.evidence,missing).status,"blocked");
 f.database.connection.prepare("UPDATE accounts SET login_state='signed_in',video_capability='available' WHERE id=?").run(f.input.accountId);
 assert.equal(f.check(null).status,"blocked");
 }finally{f.close();}
});
test("damaged archive, foreign ownership, stale task and changed confirmation block; repaired bytes recover",async()=>{
 const f=await fixture();try{
 const bytes=f.store.readVerifiedBytes(f.image.id)!;
 writeFileSync(join(f.dir,"references",`${f.image.id}.png`),await sharp({create:{width:8,height:8,channels:3,background:"blue"}}).png().toBuffer());
 assert.deepEqual(f.check(),{status:"blocked",reason:"IMAGE_UNAVAILABLE",submitted:false});
 writeFileSync(join(f.dir,"references",`${f.image.id}.png`),bytes);assert.equal(f.check().status,"preflight-only");
 f.database.connection.prepare("UPDATE reference_images SET task_id=? WHERE id=?").run(f.tasks[1]!.id,f.image.id);assert.equal(f.check().status,"blocked");
 f.database.connection.prepare("UPDATE reference_images SET task_id=? WHERE id=?").run(f.input.taskId,f.image.id);
 assert.equal(f.check(f.evidence,{...f.input,expectedRevision:0}).status,"blocked");
 const task=f.services.repository.getTask(f.input.taskId);
 assert.equal((await f.send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:editPrompt(task.workspace,"comic","video",null,"新文字")})).ok,true);
 assert.deepEqual(f.check(f.evidence,{...f.input,expectedRevision:f.services.repository.getTask(task.id).revision}),{status:"blocked",reason:"CONFIRMATION_REQUIRED",submitted:false});
 }finally{f.close();}
});
test("account removal gates, unavailable verifier, expired or invalid finishing clocks fail closed",async()=>{
 const f=await fixture();try{
 const badInput={get taskId(){throw Error("secret raw payload");}};
 let called=false; const malformedService=new VideoPreflight(f.database,f.store,{read(){called=true;return f.evidence;}},()=>150);
 assert.deepEqual(malformedService.check(badInput as never),{status:"blocked",reason:"INVALID_REQUEST",submitted:false});assert.equal(called,false);
 for(const finish of [NaN,149,200]){let reads=0;const service=new VideoPreflight(f.database,f.store,{read:()=>f.evidence},()=>reads++?finish:150);assert.deepEqual(service.check(f.input),{status:"blocked",reason:"CAPABILITY_UNVERIFIED",submitted:false});}
 const throws=new VideoPreflight(f.database,f.store,{read(){throw Error("private secret path");}},()=>150);
 assert.deepEqual(throws.check(f.input),{status:"blocked",reason:"READ_FAILED",submitted:false});
 f.database.connection.prepare("UPDATE accounts SET enabled=0 WHERE id=?").run(f.input.accountId);
 assert.deepEqual(f.check(),{status:"blocked",reason:"ACCOUNT_BLOCKED",submitted:false});
 f.database.connection.prepare("UPDATE account_removal SET state='pending',operation_id=?,lease_token=? WHERE account_id=?").run(randomUUID(),randomUUID(),f.input.accountId);
 assert.deepEqual(f.check(),{status:"blocked",reason:"ACCOUNT_BLOCKED",submitted:false});
 }finally{f.close();}
});

test("operator matrix rejects unverified free/login and non-two-role capabilities without side effects",async()=>{
 const f=await fixture();try{
 const before=f.services.repository.snapshot();
 const cases:Array<[string,unknown,string]>=[
  ["login absent",{...f.evidence,login:undefined},"CAPABILITY_UNVERIFIED"],
  ["login expired",{...f.evidence,login:"expired"},"CAPABILITY_UNVERIFIED"],
  ["charge unknown",{...f.evidence,charge:"unknown"},"CAPABILITY_UNVERIFIED"],
  ["charge absent",{...f.evidence,charge:undefined},"CAPABILITY_UNVERIFIED"],
  ["no roles",{...f.evidence,roles:[]},"UNSUPPORTED_INPUT"],
  ["duplicate first",{...f.evidence,roles:["first","first"]},"UNSUPPORTED_INPUT"],
  ["duplicate last",{...f.evidence,roles:["last","last"]},"UNSUPPORTED_INPUT"],
  ["third role",{...f.evidence,roles:["first","last","extra"]},"CAPABILITY_UNVERIFIED"],
  ["unknown mode claim",{...f.evidence,mode:"unverified"},"CAPABILITY_UNVERIFIED"],
 ];
 for(const [name,evidence,reason] of cases)assert.deepEqual(f.check(evidence),{status:"blocked",reason,submitted:false},name);
 const extra=randomUUID();
 for(const [selectedExtraAssetIds,requiredExtraAssetIds] of [[[],[extra]],[[extra],[]],[[extra],[extra]]])
  assert.deepEqual(f.check(f.evidence,{...f.input,selectedExtraAssetIds:selectedExtraAssetIds!,requiredExtraAssetIds:requiredExtraAssetIds!}),{status:"blocked",reason:"EXTRA_ASSETS_UNCONFIRMED",submitted:false});
 const valid=f.check({...f.evidence,roles:["last","first"]});assert.equal(valid.status,"preflight-only");
 if(valid.status==="preflight-only")assert.deepEqual(valid.images.map(image=>image.role),["first","last"]);
 assert.deepEqual(f.services.repository.snapshot(),before);
 }finally{f.close();}
});
