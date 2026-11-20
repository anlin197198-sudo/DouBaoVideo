import assert from "node:assert/strict";
import {test} from "node:test";
import {getSavedShotSummary} from "../src/shared/saved-shot-summary";
import {editPrompt,reviewPrompt} from "../src/shared/prompts";
import type {TaskWorkspace} from "../src/shared/models";
const clean={dirty:false,saving:false,error:null,conflict:false};
function workspace(){let w:TaskWorkspace={script:"合成",shots:["a","b","c"].map(id=>({id,title:id,description:"内容",action:"动作",shotSize:"近景",cameraMovement:"",audio:"",position:{x:0,y:0},needsReview:false})),assets:[{id:"p",type:"prop",name:"关联道具",description:"旧",referenceImageId:null,version:1,position:{x:0,y:0},needsReview:false},{id:"other",type:"scene",name:"不相关场景",description:"不应加到汇总",referenceImageId:null,version:1,position:{x:0,y:0},needsReview:false}],assetLinks:[{shotId:"b",assetId:"p"}],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0}};w=editPrompt(w,"comic","shot","a","  第一镜原文\n换行  ");w=editPrompt(w,"comic","shot","b","第二镜原文");return w;}
test("exact current saved shot texts and versions appear in narrative order, missing flagged, no asset prose added",()=>{
 const w=workspace(),before=structuredClone(w),summary=getSavedShotSummary(w,"comic",7,clean);
 assert.equal(summary.status,"saved-local-only");assert.equal(summary.revision,7);assert.deepEqual(summary.sections.map(s=>s.status),["current","current","missing"]);
 assert.equal(summary.sections[0]!.text,"  第一镜原文\n换行  ");assert.equal(summary.sections[0]!.version,1);assert.equal(summary.sections[2]!.text,null);
 assert.ok(summary.text.indexOf("Shot 01")<summary.text.indexOf("Shot 02"));assert.doesNotMatch(summary.text,/不相关场景|不应加到汇总/);
 assert.deepEqual(w,before);assert.ok(Object.isFrozen(summary.sections[0]));
});
test("reorder, plan and referenced asset changes exclude stale text until explicit existing review",()=>{
 const w=workspace(),moved={...w,shots:[w.shots[1]!,w.shots[0]!,w.shots[2]!]};
 const summary=getSavedShotSummary(moved,"comic",8,clean);assert.deepEqual(summary.sections.map(s=>s.status),["stale","stale","missing"]);assert.doesNotMatch(summary.text,/第一镜原文|第二镜原文/);
 const reviewed=reviewPrompt(moved,"comic","shot","b");assert.equal(getSavedShotSummary(reviewed,"comic",9,clean).sections[0]!.text,"第二镜原文");
 assert.equal(getSavedShotSummary(w,"realistic",7,clean).sections[0]!.status,"stale");
 const linked=structuredClone(w);linked.assets[0]!.description="变化";assert.deepEqual(getSavedShotSummary(linked,"comic",8,clean).sections.map(s=>s.status),["current","stale","missing"]);
 const unrelated=structuredClone(w);unrelated.assets[1]!.description="变化";assert.deepEqual(getSavedShotSummary(unrelated,"comic",7,clean),getSavedShotSummary(w,"comic",7,clean));
});
test("nonclean autosave and invalid revisions hide all saved texts; whitespace and empty shots stay honest",()=>{
 const w=workspace();for(const patch of [{dirty:true},{saving:true},{conflict:true},{error:"secret"}]){const summary=getSavedShotSummary(w,"comic",7,{...clean,...patch});assert.equal(summary.status,"hidden-unsaved");assert.deepEqual(summary.sections,[]);assert.doesNotMatch(summary.text,/第一镜原文|第二镜原文|secret/);}
 for(const revision of [-1,NaN,Infinity,1.5])assert.equal(getSavedShotSummary(w,"comic",revision,clean).status,"hidden-unsaved");
 const blank=editPrompt(w,"comic","shot","a"," \n ");assert.equal(getSavedShotSummary(blank,"comic",8,clean).sections[0]!.status,"missing");
 assert.match(getSavedShotSummary({...w,shots:[]},"comic",8,clean).text,/尚无镜头/);
});

test("composition copies exact saved bodies in order and touches only the empty video draft", async () => {
 const {prepareSavedShotVideoDraft,applySavedShotVideoDraft}=await import("../src/shared/saved-shot-video-draft");
 let w=editPrompt(workspace(),"comic","shot","c","第三镜原文");
 w=editPrompt(editPrompt(w,"comic","firstFrame",null,"首帧手稿"),"comic","lastFrame",null,"尾帧手稿");
 const context={taskId:"safe",revision:7,workspace:w,plan:"comic" as const,saveState:clean};
 const preview=prepareSavedShotVideoDraft(context);
 assert.equal(preview.status,"ready");
 if(preview.status!=="ready")throw new Error("preview expected");
 assert.equal(preview.draft.text,"  第一镜原文\n换行  \n\n第二镜原文\n\n第三镜原文");
 const edited=preview.draft.text+"\n显式编辑";
 const next=applySavedShotVideoDraft(context,preview.draft,edited);
 assert.ok(next);
 const target=next.prompts?.find(p=>p.kind==="video");
 assert.equal(target?.text,edited);
 assert.deepEqual(next.prompts?.filter(p=>p.kind!=="video"),w.prompts);
 assert.deepEqual({...next,prompts:w.prompts},w);
 assert.equal(applySavedShotVideoDraft({...context,workspace:next},preview.draft,edited),null);
});

test("composition refuses missing or stale shots, any unsaved state and stale or occupied target", async () => {
 const {prepareSavedShotVideoDraft,applySavedShotVideoDraft,VIDEO_PROMPT_MAX}=await import("../src/shared/saved-shot-video-draft");
 const w=editPrompt(workspace(),"comic","shot","c","第三镜原文");
 const context={taskId:"safe",revision:7,workspace:w,plan:"comic" as const,saveState:clean};
 const ready=prepareSavedShotVideoDraft(context);
 if(ready.status!=="ready")throw new Error("preview expected");
 for(const patch of [{dirty:true},{saving:true},{conflict:true},{error:"failure"}]){
  assert.equal(applySavedShotVideoDraft({...context,saveState:{...clean,...patch}},ready.draft,ready.draft.text),null);
 }
 for(const patch of [{taskId:"another"},{revision:8},{plan:"realistic" as const},{workspace:workspace()},{workspace:editPrompt(w,"comic","video",null," \n ")},
  {workspace:{...w,shots:[w.shots[1]!,w.shots[0]!,w.shots[2]!]}}]){
  assert.equal(applySavedShotVideoDraft({...context,...patch},ready.draft,ready.draft.text),null);
 }
 for(const text of [""," \n ","a".repeat(VIDEO_PROMPT_MAX+1)])assert.equal(applySavedShotVideoDraft(context,ready.draft,text),null);
 const emptyTarget=editPrompt(w,"comic","video",null,"");
 const staleTarget=editPrompt(emptyTarget,"comic","shot","c","changed");
 assert.deepEqual(prepareSavedShotVideoDraft({...context,workspace:staleTarget}),{status:"blocked",reason:"target-stale"});
 const over=editPrompt(w,"comic","shot","c","a".repeat(VIDEO_PROMPT_MAX));
 assert.deepEqual(prepareSavedShotVideoDraft({...context,workspace:over}),{status:"blocked",reason:"too-long"});
});

test("explicit edited composition goes through ordinary save and survives SQLite reopen", async () => {
 const [{mkdtempSync,rmSync},{tmpdir},{join},{randomUUID},{ApplicationDatabase},{createApplicationServices},{WorkspaceAutosave},{prepareSavedShotVideoDraft,applySavedShotVideoDraft}]
  =await Promise.all([import("node:fs"),import("node:os"),import("node:path"),import("node:crypto"),import("../src/main/infrastructure/database"),
   import("../src/main/application/services"),import("../src/shared/workspace-autosave"),import("../src/shared/saved-shot-video-draft")]);
 const directory=mkdtempSync(join(tmpdir(),"video-draft-")),databasePath=join(directory,"workspace.sqlite");
 const database=new ApplicationDatabase(databasePath);
 const servicesFor=(database:InstanceType<typeof ApplicationDatabase>)=>createApplicationServices({database,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:directory});
 try{
  const services=servicesFor(database);
  const send=(command:string,input:unknown)=>services.router.dispatch({requestId:randomUUID(),command,input},{trusted:true});
  assert.equal((await send("plans.create",{title:"合成",style:"comic",startDate:"2026-11-20",dailyCount:1,executionTime:"09:00"})).ok,true);
  const task=services.repository.snapshot().tasks[0]!;
  const shotId=randomUUID();
  const sample:TaskWorkspace={...task.workspace,script:"合成剧本",shots:[{id:shotId,title:"合成镜",description:"",action:"",shotSize:"",cameraMovement:"",audio:"",position:{x:0,y:0},needsReview:false}]};
  const initial=editPrompt(editPrompt(sample,"comic","shot",shotId,"合成镜头提示词"),"comic","firstFrame",null,"保留首帧");
  const input=(workspace:TaskWorkspace,revision:number)=>({id:task.id,expectedRevision:revision,workspace});
  assert.equal((await send("tasks.saveWorkspace",input(initial,task.revision))).ok,true);
  const saved=services.repository.getTask(task.id);
  const context={taskId:task.id,revision:saved.revision,workspace:saved.workspace,plan:"comic" as const,saveState:clean};
  const prepared=prepareSavedShotVideoDraft(context);
  if(prepared.status!=="ready")throw Error("preview expected");
  assert.equal(services.repository.getTask(task.id).revision,saved.revision);
  const next=applySavedShotVideoDraft(context,prepared.draft,"合成镜头提示词（人工补写）");
  assert.ok(next);
  let fail=true;
  const controller=new WorkspaceAutosave(saved,async(workspace,revision)=>{
   if(fail){fail=false;throw Error("synthetic storage failure");}
   if(!(await send("tasks.saveWorkspace",input(workspace,revision))).ok)throw Error("store rejected write");
   return services.repository.getTask(task.id);
  },()=>{},60000);
  try{
   controller.update(next);
   assert.equal(await controller.flush(),false);
   assert.equal(controller.workspace.prompts?.find(p=>p.kind==="video")?.text,"合成镜头提示词（人工补写）");
   assert.equal(services.repository.getTask(task.id).revision,saved.revision);
   assert.equal(await controller.flush(true),true);
  }finally{controller.dispose();}
  database.close();
  const reopened=new ApplicationDatabase(databasePath);
  try{
   const workspace=servicesFor(reopened).repository.getTask(task.id).workspace;
   assert.equal(workspace.prompts?.find(p=>p.kind==="video")?.text,"合成镜头提示词（人工补写）");
   assert.equal(workspace.prompts?.find(p=>p.kind==="firstFrame")?.text,"保留首帧");
  }finally{reopened.close();}
 }finally{if(database.connection.isOpen)database.close();rmSync(directory,{recursive:true,force:true});}
});
