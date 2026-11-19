import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { createStoryboardPlannerWorkflow } from "../src/main/application/storyboard-planner-workflow";
import { StoryboardCandidateSession, MAX_STORYBOARD_REPLY_CHARS } from "../src/shared/storyboard-candidate";
import { appendStoryboardDraft } from "../src/shared/storyboard-draft";
import { placeAddedNodes } from "../src/shared/canvas-layout";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { editPrompt } from "../src/shared/prompts";
import { formatPromptTemplate } from "../src/shared/prompt-template";
import { getSavedShotSummary } from "../src/shared/saved-shot-summary";
const clean={dirty:false,saving:false,error:null,conflict:false,requestId:null};
const payload=(count=48)=>JSON.stringify({formatVersion:1,shots:Array.from({length:count},(_,i)=>({order:i+1,title:`合成镜头${String(i+1).padStart(2,"0")}`,visual:`合成方块${i+1}放在白色平面`,action:"保持静止",framing:"中景",motion:"固定",dialogue:`合成音效${i+1}`}))});
const planner=(raw:string)=>({readiness:()=>({state:"configured" as const,model:"deepseek-flash" as const,modelVersion:"DeepSeek-V4.1-Flash-1017" as const}),generateJson:async()=>raw});
test("48 supplied synthetic candidates adopt explicitly, save and reopen as exact ordered isolated-asset prompt summary",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"long-storyboard-")),path=join(dir,"workspace.sqlite");let db=new ApplicationDatabase(path);
 try{let repo=new WorkspaceRepository(db);let task=db.transaction(()=>repo.createPlan({title:"合成长分镜",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 task=db.transaction(()=>repo.saveWorkspace({id:task.id,expectedRevision:task.revision,workspace:{...task.workspace,script:"纯合成：四十八个编号方块依次展示。"}}));
 const scriptHistory=repo.listScriptHistory({taskId:task.id}),before=structuredClone(task);let confirmations=0,calls=0;
 const workflow=createStoryboardPlannerWorkflow({getTask:id=>repo.getTask(id),confirm:async()=>{confirmations++;return true;},planner:{...planner(payload()),generateJson:async input=>{calls++;assert.equal(input.user,task.workspace.script);return payload();}}});
 const generated=await workflow.generate({taskId:task.id,expectedRevision:task.revision});assert.equal(generated.status,"ready");if(generated.status!=="ready")throw Error("not ready");assert.ok(generated.adoptionToken);assert.equal(generated.preview.rows.length,48);assert.deepEqual(repo.getTask(task.id),before);
 const approved=workflow.adopt({taskId:task.id,expectedRevision:task.revision,token:generated.adoptionToken});
 let w=appendStoryboardDraft({taskId:task.id,revision:task.revision,workspace:task.workspace,state:clean},approved)!;assert.ok(w);w=placeAddedNodes(task.workspace,w);
 assert.throws(()=>workflow.adopt({taskId:task.id,expectedRevision:task.revision,token:generated.adoptionToken!}));
 const assetA=randomUUID(),assetB=randomUUID();w=addAsset(addAsset(w,assetA,"person"),assetB,"prop");w.assets=w.assets.map((a,i)=>({...a,name:i?"ONLY_BETA_ASSET":"ONLY_ALPHA_ASSET"}));
 for(const [i,shot] of w.shots.entries())w=setAssetLink(w,i%2?assetB:assetA,shot.id,true);
 const texts=w.shots.map((shot,i)=>{const text=formatPromptTemplate(w,"comic","shot",shot.id);assert.ok(text.includes(i%2?"ONLY_BETA_ASSET":"ONLY_ALPHA_ASSET"));assert.ok(!text.includes(i%2?"ONLY_ALPHA_ASSET":"ONLY_BETA_ASSET"));return text;});
 for(const [i,shot] of w.shots.entries())w=editPrompt(w,"comic","shot",shot.id,texts[i]!);
 task=db.transaction(()=>repo.saveWorkspace({id:task.id,expectedRevision:task.revision,workspace:w}));const saved=structuredClone(task);
 assert.equal(confirmations,1);assert.equal(calls,1);db.close();db=new ApplicationDatabase(path);repo=new WorkspaceRepository(db);task=repo.getTask(task.id);assert.deepEqual(task,saved);
 const summary=getSavedShotSummary(task.workspace,"comic",task.revision,clean);assert.deepEqual(summary.sections.map(s=>s.order),Array.from({length:48},(_,i)=>i+1));assert.deepEqual(summary.sections.map(s=>s.text),texts);assert.ok(summary.sections.every(s=>s.status==="current"&&s.version===1));
 assert.deepEqual(task.workspace.shots.map(s=>s.title),JSON.parse(payload()).shots.map((s:{title:string})=>s.title));
 for(const [i,shot] of task.workspace.shots.entries())assert.equal(repo.getPromptHistory({taskId:task.id,kind:"shot",shotId:shot.id,version:1}).text,texts[i]);
 assert.deepEqual(repo.listScriptHistory({taskId:task.id}),scriptHistory);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test("truncated, oversized and over-count supplied long replies never produce candidates or adoption",async()=>{
 const db=new ApplicationDatabase(":memory:");try{const repo=new WorkspaceRepository(db);let task=db.transaction(()=>repo.createPlan({title:"合成拒绝",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 task=db.transaction(()=>repo.saveWorkspace({id:task.id,expectedRevision:0,workspace:{...task.workspace,script:"合成剧本"}}));const before=structuredClone(task);
 for(const raw of [payload().slice(0,-20)," ".repeat(MAX_STORYBOARD_REPLY_CHARS+1),payload(201)]){
 const candidate=new StoryboardCandidateSession(raw);assert.equal(candidate.status.status,"failed");assert.throws(()=>candidate.preview(task.workspace));assert.deepEqual(repo.getTask(task.id),before);
 const workflow=createStoryboardPlannerWorkflow({getTask:id=>repo.getTask(id),planner:planner(raw),confirm:async()=>true});
 await assert.rejects(workflow.generate({taskId:task.id,expectedRevision:task.revision}));assert.throws(()=>workflow.adopt({taskId:task.id,expectedRevision:task.revision,token:randomUUID()}));assert.deepEqual(repo.getTask(task.id),before);candidate.discard();assert.equal(candidate.readRawReply(),null);
 }
 }finally{db.close();}
});
