import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { appendStoryboardDraft } from "../src/shared/storyboard-draft";
import { canvasBoxes, boxesOverlap } from "../src/shared/canvas-layout";
import { addAsset } from "../src/shared/assets";
import { addShot, moveShot, removeShot } from "../src/shared/storyboard";
import { editPrompt } from "../src/shared/prompts";
import { arrangeCanvas, placeAddedNodes, preserveProductionPositions, resolvedProductionPositions } from "../src/shared/canvas-layout";
import { productionNodes, productionEdges } from "../src/shared/canvas-production";
import { addFrameCandidate, chooseFrame } from "../src/shared/frames";
import type { TaskWorkspace } from "../src/shared/models";
const empty=():TaskWorkspace=>({script:"合成剧本",shots:[],assets:[],assetLinks:[],scriptPosition:{x:80,y:80},viewport:{x:1,y:2,zoom:.7}});
function scene(){let w=empty();for(let i=0;i<3;i++)w=addShot(w,randomUUID());return w;}
function endpoint(w:TaskWorkspace,kind:"firstFrame"|"lastFrame") {return productionEdges(w).find(e=>e.target===`prompt:${kind}`)!.source;}
test("endpoint role source edges change while selected candidate provenance and role navigation stay intact",()=>{
 let w=scene();const [a,,c]=w.shots;const sharedImage=randomUUID();
 for(const slot of ["first","last"] as const){const key=randomUUID();w=chooseFrame(addFrameCandidate(w,"comic",slot,sharedImage,key,"2026-11-19T00:00:00.000Z"),slot,key);}
 w=arrangeCanvas(w);const original=structuredClone(w),positions=resolvedProductionPositions(w);
 const moved=preserveProductionPositions(w,moveShot(w,a!.id,1));
 assert.notEqual(endpoint(moved,"firstFrame"),a!.id);assert.equal(endpoint(moved,"lastFrame"),c!.id);
 assert.deepEqual(moved.frames,w.frames);assert.deepEqual(moved.productionPositions,positions);
 const deleted=removeShot(moved,c!.id);assert.equal(endpoint(deleted,"lastFrame"),a!.id);assert.deepEqual(deleted.frames,w.frames);
 const nodes=productionNodes(deleted,"comic");assert.deepEqual(nodes.frames.map(n=>[n.id,n.slot,n.candidate?.imageId]),[["frame:first","first",sharedImage],["frame:last","last",sharedImage]]);
 for(const shot of deleted.shots){const p=nodes.prompts.find(n=>n.shotId===shot.id)!;assert.equal(p.selection,`shot:${shot.id}`);assert.deepEqual(p.position,positions[`prompt:shot:${shot.id}`]);}
 assert.ok(!productionEdges(deleted).some(e=>e.source.includes(c!.id)||e.target.includes(c!.id)));assert.deepEqual(w,original);
});
test("saved long prompt navigation retains stable identity/manual position through reorder, new content and reopen",()=>{
 const dir=mkdtempSync(join(tmpdir(),"doubao-canvas-nav-")),path=join(dir,"workspace.sqlite");let db=new ApplicationDatabase(path);
 try{let repo=new WorkspaceRepository(db);const task=db.transaction(()=>repo.createPlan({title:"合成",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 let w=scene();const target=w.shots[1]!.id;
 w=editPrompt(w,"comic","shot",target,"合成长提示词".repeat(1000));w=arrangeCanvas(w);w.productionPositions![`prompt:shot:${target}`]={x:-321,y:987};
 let saved=db.transaction(()=>repo.saveWorkspace({id:task.id,expectedRevision:0,workspace:w}));const oldPrompt=structuredClone(saved.workspace.prompts![0]!);
 const reordered=preserveProductionPositions(saved.workspace,moveShot(saved.workspace,target,-1));const added=placeAddedNodes(reordered,addShot(reordered,randomUUID()));
 assert.deepEqual(added.productionPositions![`prompt:shot:${target}`],{x:-321,y:987});
 saved=db.transaction(()=>repo.saveWorkspace({id:task.id,expectedRevision:saved.revision,workspace:added}));
 const history=repo.listPromptHistory({taskId:task.id,kind:"shot",shotId:target,limit:20});
 db.close();db=new ApplicationDatabase(path);repo=new WorkspaceRepository(db);const restored=repo.getTask(task.id).workspace;
 assert.deepEqual(restored,saved.workspace);assert.deepEqual(restored.prompts![0],oldPrompt);
 const node=productionNodes(restored,"comic").prompts[0]!;assert.equal(node.shotId,target);assert.equal(node.selection,`shot:${target}`);assert.equal(node.summary,oldPrompt.text);assert.equal(node.status,"待更新");assert.deepEqual(node.position,{x:-321,y:987});
 assert.equal(endpoint(restored,"firstFrame"),target);assert.equal(endpoint(restored,"lastFrame"),restored.shots.at(-1)!.id);
 assert.deepEqual(repo.listPromptHistory({taskId:task.id,kind:"shot",shotId:target,limit:20}),history);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("approved storyboard additions avoid a manually positioned existing asset without moving old nodes",()=>{
 const base=addAsset(empty(),randomUUID(),"person");base.assets[0]!.position={x:440,y:80};
 const before=structuredClone(base),shot=addShot(empty(),randomUUID()).shots[0]!;
 const draft=appendStoryboardDraft({taskId:"task",revision:4,workspace:base,state:{dirty:false,saving:false,error:null,conflict:false,requestId:null}},
  {taskId:"task",revision:4,prefix:[],shots:[shot]})!;
 const naive=canvasBoxes(draft);assert.equal(boxesOverlap(naive.find(b=>b.id===shot.id)!,naive.find(b=>b.id===base.assets[0]!.id)!),true);
 const placed=placeAddedNodes(base,draft),boxes=canvasBoxes(placed),old=canvasBoxes(base);
 for(const node of old)assert.deepEqual(boxes.find(b=>b.id===node.id)!.position,node.position);
 for(const node of boxes.filter(b=>!old.some(o=>o.id===b.id)))for(const other of boxes.filter(b=>b.id!==node.id))assert.equal(boxesOverlap(node,other),false);
 assert.deepEqual(placed.assets,base.assets);assert.equal(placed.shots[0]!.id,shot.id);assert.deepEqual(base,before);
});
