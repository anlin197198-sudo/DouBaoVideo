import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {TemplateDraftSelection,type TemplateDraftSelectionContext} from "../src/shared/template-draft-selection";
import {emptyTemplateSlotFields,updateTemplateSlotField} from "../src/shared/template-slot-fields";
import type {TaskWorkspace} from "../src/shared/models";
function context(kind:"shot"|"firstFrame"|"lastFrame"="shot"):TemplateDraftSelectionContext{
 const w:TaskWorkspace={script:"合成",shots:[{id:randomUUID(),title:"合成镜头",description:"",action:"",audio:"",shotSize:"",cameraMovement:"",position:{x:0,y:0},needsReview:false}],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};
 const shotId=kind==="shot"?w.shots[0]!.id:null;let slot=emptyTemplateSlotFields(w,kind,shotId);
 for(const key of kind==="shot"?["duration","continuity"]:["composition","state"])slot=updateTemplateSlotField(slot,key,"明确输入");
 return{taskId:randomUUID(),revision:3,workspace:w,plan:"comic",kind,shotId,globalFields:{tone:"基调",lighting:"光线",colorAnchor:"色彩"},slotFields:slot,saveState:{dirty:false,saving:false,error:null,conflict:false}};
}
test("structural selection returns only immutable text, not a workspace or autosave; optional empty content stays informational",()=>{
 for(const kind of ["shot","firstFrame","lastFrame"] as const){const c=context(kind),before=structuredClone(c),session=new TemplateDraftSelection(c);
 assert.equal(session.preview.status,"structural-preview");assert.equal(session.select(c,false).status,"blocked");
 const result=session.select(c,true);assert.equal(result.status,"selected-text-only");if(result.status!=="selected-text-only")throw Error("blocked");
 assert.equal(result.notApplied,true);assert.equal("workspace" in result,false);assert.ok(Object.isFrozen(result));assert.deepEqual(c,before);
 assert.equal(session.select(c,true).status,"blocked");}
});
test("only exactly empty target accepts; manual whitespace, video, missing fields and reference mapping block",()=>{
 for(const text of [" ","\n","manual"]){const c=context();c.workspace.prompts=[{kind:"shot",shotId:c.shotId,text,version:1,source:"manual",inputSnapshot:"old"}];assert.equal(new TemplateDraftSelection(c).preview.status,"blocked");}
 const empty=context();empty.workspace.prompts=[{kind:"shot",shotId:empty.shotId,text:"",version:2,source:"manual",inputSnapshot:"old"}];assert.equal(new TemplateDraftSelection(empty).preview.status,"structural-preview");
 const video={...context(),kind:"video" as const,shotId:null};assert.equal(new TemplateDraftSelection(video).preview.status,"blocked");
 const noEndpoint=context("firstFrame");noEndpoint.workspace.shots=[];noEndpoint.slotFields=emptyTemplateSlotFields(noEndpoint.workspace,"firstFrame",null);assert.deepEqual(new TemplateDraftSelection(noEndpoint).preview,{status:"blocked",reason:"INVALID_CONTEXT"});
 const missing=context();missing.globalFields.lighting=" ";assert.equal(new TemplateDraftSelection(missing).preview.status,"blocked");
 const linked=context();linked.workspace.assets=[{id:"asset",name:"人物",description:"",type:"person",referenceImageId:"image",version:1,position:{x:0,y:0},needsReview:false}];linked.workspace.assetLinks=[{assetId:"asset",shotId:linked.shotId!}];assert.equal(new TemplateDraftSelection(linked).preview.status,"blocked");
});
test("stale context, temporary text, roles and save states reject without consuming successful future selection",()=>{
 const c=context(),session=new TemplateDraftSelection(c);
 const patches=[{revision:4},{taskId:randomUUID()},{plan:"realistic" as const},{globalFields:{...c.globalFields,tone:"新"}},
 ...[{dirty:true},{saving:true},{conflict:true},{error:"private"}].map(p=>({saveState:{...c.saveState,...p}}))];
 for(const patch of patches)assert.equal(session.select({...c,...patch},true).status,"blocked");
 const slotChanged={...c,slotFields:updateTemplateSlotField(c.slotFields,"duration","新时长")};assert.equal(session.select(slotChanged,true).status,"blocked");
 const changed=structuredClone(c);changed.workspace.viewport.x=99;assert.equal(session.select(changed,true).status,"blocked");
 assert.equal(session.select(c,true).status,"selected-text-only");
 const staticContext=context("firstFrame"),staticSession=new TemplateDraftSelection(staticContext);staticContext.workspace.shots[0]!.id=randomUUID();assert.equal(staticSession.select(staticContext,true).status,"blocked");
});
test("oversized formatter output and reentrant reads fail boundedly with no raw exception echo",()=>{
 const big=context();big.workspace.shots[0]!.description="x".repeat(100001);assert.deepEqual(new TemplateDraftSelection(big).preview,{status:"blocked",reason:"TOO_LONG"});
 const c=context(),session=new TemplateDraftSelection(c);let nested:unknown;
 const wrapped={...c,get taskId(){nested=session.select(c,true);return c.taskId;}};
 assert.equal(session.select(wrapped,true).status,"selected-text-only");assert.deepEqual(nested,{status:"blocked",reason:"SELECTING"});
 const throwing={get taskId(){throw Error("secret");}} as never;assert.doesNotMatch(JSON.stringify(new TemplateDraftSelection(throwing).preview),/secret/);
});
