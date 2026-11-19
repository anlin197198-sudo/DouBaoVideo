import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasOpenIntent, type CanvasOpenContext } from "../src/shared/canvas-open-intent";
import { editPrompt } from "../src/shared/prompts";
import { addShot } from "../src/shared/storyboard";
import { randomUUID } from "node:crypto";
const clean={dirty:false,saving:false,error:null,conflict:false};
const context=():CanvasOpenContext=>({taskId:randomUUID(),revision:3,plan:"comic",workspace:{script:"",shots:[],assets:[],assetLinks:[],scriptPosition:{x:40,y:70},viewport:{x:-555,y:222,zoom:.3}}});
test("generic opens have no intent; explicit continue uses current production resolver once without writes",()=>{
 const c=context(),before=structuredClone(c);assert.equal(CanvasOpenIntent.prepare("open-canvas",c),null);
 const intent=CanvasOpenIntent.prepare("open-current-local-step",c)!;
 assert.deepEqual(intent.consume(c,clean,false),{taskId:c.taskId,target:"script"});assert.equal(intent.consume(c,clean,false),null);assert.deepEqual(c,before);
 c.workspace=editPrompt(c.workspace,c.plan,"video",null,"合成视频正文");
 assert.equal(CanvasOpenIntent.prepare("open-current-local-step",c)!.consume(c,clean,false)!.target,"frame:first");
});
test("non-node steps do not implicitly add shots/open asset library; cancellation and invalid IDs fail closed",()=>{
 const c=context();c.workspace.script="合成";assert.equal(CanvasOpenIntent.prepare("open-current-local-step",c),null);
 c.workspace=addShot(c.workspace,randomUUID());assert.equal(CanvasOpenIntent.prepare("open-current-local-step",c),null);
 const fresh=context(),intent=CanvasOpenIntent.prepare("open-current-local-step",fresh)!;intent.cancel();assert.equal(intent.consume(fresh,clean,false),null);
 assert.equal(CanvasOpenIntent.prepare("open-current-local-step",{...fresh,taskId:"bad"}),null);
});
test("new task/revision/content/plan or unsaved state cannot consume or later resurrect an old route intent",()=>{
 const c=context();
 const changed=[{...c,taskId:randomUUID()},{...c,revision:4},{...c,plan:"realistic" as const},{...c,workspace:{...c.workspace,script:"changed"}}];
 for(const current of changed){const intent=CanvasOpenIntent.prepare("open-current-local-step",c)!;assert.equal(intent.consume(current,clean,false),null);assert.equal(intent.consume(c,clean,false),null);}
 for(const state of [{...clean,dirty:true},{...clean,saving:true},{...clean,error:"save failed"},{...clean,conflict:true}]){
 const intent=CanvasOpenIntent.prepare("open-current-local-step",c)!;assert.equal(intent.consume(c,state,false),null);assert.equal(intent.consume(c,clean,false),null);}
 const intent=CanvasOpenIntent.prepare("open-current-local-step",c)!;assert.equal(intent.consume(c,clean,true),null);assert.equal(intent.consume(c,clean,false),null);
});
