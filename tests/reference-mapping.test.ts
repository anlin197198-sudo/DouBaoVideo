import assert from "node:assert/strict";
import { test } from "node:test";
import { ReferenceMappingSession, type ReferenceMappingContext } from "../src/shared/reference-mapping";
import { getTemplateInputGaps } from "../src/shared/template-input-gaps";
import { TemplateDraftSelection } from "../src/shared/template-draft-selection";
import { emptyTemplateSlotFields, updateTemplateSlotField } from "../src/shared/template-slot-fields";
import type { TaskWorkspace } from "../src/shared/models";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture():ReferenceMappingContext {
 const shots=[1,2].map(n=>({id:id(n),title:`镜头${n}`,description:"描述",action:"",shotSize:"近景",cameraMovement:"",audio:"",position:{x:0,y:0},needsReview:false}));
 const assets=[3,4,5,6].map((n,i)=>({id:id(n),type:(["person","prop","scene","person"] as const)[i]!,name:`资产${n}`,description:"",referenceImageId:id(n===4?10:n===3?10:n+10),version:1,position:{x:0,y:0},needsReview:false}));
 const workspace:TaskWorkspace={script:"合成",shots,assets,assetLinks:[{shotId:id(1),assetId:id(3)},{shotId:id(1),assetId:id(4)},{shotId:id(2),assetId:id(5)}],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0}};
 return {taskId:id(20),revision:2,workspace,plan:"comic",kind:"shot",shotId:id(1),templateText:"原格式预览"};
}
test("scoped shared-image author mapping has no defaults, preserves data and never enables template application",()=>{
 const c=fixture(),before=structuredClone(c),s=new ReferenceMappingSession(c);
 assert.equal(s.rows.length,1);assert.equal(s.rows[0]!.assets.length,2);assert.equal(s.preview(c).text,"");
 s.update(c,id(10),2);const p=s.preview(c);assert.match(p.text,/计划 @图片2（本地图片 ID：[^）]+）：人物：资产3；道具：资产4/);assert.doesNotMatch(p.text,/资产5|资产6/);
 assert.match(p.text,/未上传、未验证/);assert.equal(p.canSubmit,false);assert.equal(p.applied,false);assert.ok(Object.isFrozen(p.entries[0]!.assets[0]));
 assert.deepEqual(c,before);assert.ok(getTemplateInputGaps(c.workspace,c.kind,c.shotId).gaps.some(g=>g.code==="referenceMapping"));
 let slot=emptyTemplateSlotFields(c.workspace,"shot",c.shotId)!;slot=updateTemplateSlotField(slot,"duration","作者时长");slot=updateTemplateSlotField(slot,"continuity","作者连续性");
 const selection=new TemplateDraftSelection({taskId:c.taskId,revision:c.revision,workspace:c.workspace,plan:c.plan,kind:"shot",shotId:c.shotId,globalFields:{tone:"基调",lighting:"光",colorAnchor:"色"},slotFields:slot,saveState:{dirty:false,saving:false,error:null,conflict:false}});
 assert.notEqual(selection.preview.status,"structural-preview");s.update(c,id(10),null);assert.equal(s.preview(c).text,"");
});
test("unique bounded integer indices and exact linked identities; first/last/video scopes remain separate",()=>{
 const c=fixture();c.kind="video";c.shotId=null;const s=new ReferenceMappingSession(c);assert.equal(s.rows.length,2);
 s.update(c,id(10),200);for(const index of [0,-1,201,1.2,NaN,Infinity])assert.throws(()=>s.update(c,id(15),index));
 assert.throws(()=>s.update(c,id(15),200));assert.throws(()=>s.update(c,id(16),1));s.update(c,id(15),1);
 assert.equal(s.preview(c).entries.length,2);assert.ok(s.preview(c).text.includes(id(10)));assert.ok(s.preview(c).text.includes(id(15)));
 const first={...c,kind:"firstFrame" as const},last={...c,kind:"lastFrame" as const};
 assert.deepEqual(new ReferenceMappingSession(first).rows.map(r=>r.imageId),[id(10)]);assert.deepEqual(new ReferenceMappingSession(last).rows.map(r=>r.imageId),[id(15)]);
 assert.throws(()=>new ReferenceMappingSession({...c,kind:"shot",shotId:id(999)}));
});
test("task/revision/asset/link/endpoint/plan/template changes invalidate and A-B-A does not revive",()=>{
 const base=fixture();
 for(const change of [(c:ReferenceMappingContext)=>{c.taskId=id(21)},(c:ReferenceMappingContext)=>{c.revision++},(c:ReferenceMappingContext)=>{c.plan="realistic"},(c:ReferenceMappingContext)=>{c.templateText="changed"},(c:ReferenceMappingContext)=>{c.workspace.assets[0]!.referenceImageId=id(99)},(c:ReferenceMappingContext)=>{c.workspace.assetLinks=[]},(c:ReferenceMappingContext)=>{c.workspace.shots.reverse()}]){
 const s=new ReferenceMappingSession(base);s.update(base,id(10),1);const changed=structuredClone(base);change(changed);
 assert.equal(s.preview(changed).current,false);assert.equal(s.preview(base).text,"");assert.throws(()=>s.update(base,id(10),2));
 const fresh=new ReferenceMappingSession(base);assert.equal(fresh.preview(base).entries.length,0);
 }
});
