import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {emptyTemporaryTemplateEditor,prepareTemporaryTemplateEditor,editTemporaryTemplate,resetTemporaryTemplate,closeTemporaryTemplate,temporaryTemplateStale,captureTemporaryCopy,isCurrentTemporaryCopy} from "../src/shared/temporary-template-editor";
import {emptyTemplateSlotFields,updateTemplateSlotField} from "../src/shared/template-slot-fields";
import type {TemplateDraftSelectionContext} from "../src/shared/template-draft-selection";
import type {TaskWorkspace} from "../src/shared/models";
function context():TemplateDraftSelectionContext{
 const w:TaskWorkspace={script:"合成",shots:[{id:randomUUID(),title:"合成镜头",description:"",action:"",audio:"",shotSize:"",cameraMovement:"",position:{x:0,y:0},needsReview:false}],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};
 const id=w.shots[0]!.id;let slot=emptyTemplateSlotFields(w,"shot",id);slot=updateTemplateSlotField(slot,"duration","明确时长");slot=updateTemplateSlotField(slot,"continuity","明确连续性");
 return{taskId:randomUUID(),revision:1,workspace:w,plan:"comic",kind:"shot",shotId:id,globalFields:{tone:"基调",lighting:"光线",colorAnchor:"色彩"},slotFields:slot,saveState:{dirty:false,saving:false,error:null,conflict:false}};
}
test("prepare uses selector, editor stays separate from workspace and keeps original for explicit reset",()=>{
 const c=context(),before=structuredClone(c),empty=emptyTemporaryTemplateEditor(),prepared=prepareTemporaryTemplateEditor(empty,c);
 assert.ok(prepared.buffer);assert.equal(empty.buffer,null);assert.throws(()=>prepareTemporaryTemplateEditor(prepared,c));
 const edited=editTemporaryTemplate(prepared,"独立临时修改");assert.equal(edited.buffer!.text,"独立临时修改");assert.equal(prepared.buffer!.text,prepared.buffer!.original);
 assert.equal(resetTemporaryTemplate(edited).buffer!.text,prepared.buffer!.original);assert.deepEqual(c,before);
 assert.throws(()=>editTemporaryTemplate(edited,"x".repeat(100001)));assert.equal(editTemporaryTemplate(edited,"x".repeat(100000)).buffer!.text.length,100000);
 const dirty={...c,saveState:{...c.saveState,dirty:true}};assert.throws(()=>prepareTemporaryTemplateEditor(empty,dirty));
});
test("source changes only mark stale, never replace buffer; close and reset are explicit",()=>{
 const c=context(),prepared=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),c),edited=editTemporaryTemplate(prepared,"保留临时稿");
 assert.equal(temporaryTemplateStale(edited,c),false);const changed=structuredClone(c);changed.globalFields.tone="新基调";
 assert.equal(temporaryTemplateStale(edited,changed),true);assert.equal(temporaryTemplateStale(edited,null),true);assert.equal(edited.buffer!.text,"保留临时稿");
 const closed=closeTemporaryTemplate(edited);assert.equal(closed.buffer,null);assert.ok(closed.epoch>edited.epoch);
});
test("late clipboard completion cannot mark edited, reset or closed-and-reopened identical content current",async()=>{
 const c=context();let state=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),c);const original=state.buffer!.text;
 let resolve!:()=>void;const pending=new Promise<void>(r=>{resolve=r;});const token=captureTemporaryCopy(state)!;
 const completion=pending.then(()=>isCurrentTemporaryCopy(state,token));
 state=prepareTemporaryTemplateEditor(closeTemporaryTemplate(state),c);assert.equal(state.buffer!.text,original);resolve();assert.equal(await completion,false);
 const editedToken=captureTemporaryCopy(state)!;state=editTemporaryTemplate(state,"different");state=resetTemporaryTemplate(state);assert.equal(state.buffer!.text,original);assert.equal(isCurrentTemporaryCopy(state,editedToken),false);
 const current=captureTemporaryCopy(state)!;assert.equal(isCurrentTemporaryCopy(state,current),true);
});
