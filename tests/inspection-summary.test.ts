import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInspectionSummary, type InspectionSaveState } from "../src/shared/inspection-summary";
import { addFrameCandidate, chooseFrame, confirmationInput } from "../src/shared/frames";
import { editPrompt } from "../src/shared/prompts";
import type { TaskWorkspace, ReferenceImage } from "../src/shared/models";
const clean:InspectionSaveState={dirty:false,saving:false,error:null,conflict:false};
function fixture(){
 let w:TaskWorkspace={script:"合成",shots:[],assets:[],assetLinks:[],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0}};
 w=editPrompt(w,"comic","video",null,"精确原文\n保留空白 ");
 for(const slot of ["first","last"] as const)w=chooseFrame(addFrameCandidate(w,"comic",slot,"shared-image",slot+"-candidate","2026-11-19T00:00:00Z"),slot,slot+"-candidate");
 w.frames!.confirmation={inputSnapshot:confirmationInput(w,"comic"),confirmedAt:"2026-11-19T00:00:00Z",invalidated:false};
 const images:ReferenceImage[]=[{id:"shared-image",taskId:"task",originalName:"not-displayed.png",width:32,height:64,createdAt:"fixed"}];
 return {w,images};
}
test("saved inspection preserves exact prompt, separate same-image roles and never implies send readiness",()=>{
 const {w,images}=fixture(),before=structuredClone(w);
 const result=buildInspectionSummary(w,"comic","task",12,clean,images,{"shared-image":{epoch:2,status:"ready"}});
 assert.equal(result.status,"saved-local-only");if(!result.saved)throw Error("hidden");
 assert.deepEqual(result.saved.video,{text:"精确原文\n保留空白 ",version:1});assert.equal(result.saved.revision,12);
 assert.equal(result.saved.confirmation.coherent,true);assert.deepEqual(result.saved.frames.map(f=>f.role),["first","last"]);
 assert.equal(result.saved.frames[0]!.imageId,result.saved.frames[1]!.imageId);assert.notEqual(result.saved.frames[0]!.candidateId,result.saved.frames[1]!.candidateId);
 for(const frame of result.saved.frames){assert.equal(frame.width,32);assert.equal(frame.previewStatus,"ready");assert.equal(frame.digest,"unavailable");}
 assert.equal(result.submitted,false);assert.ok(Object.values(result.availability).every(v=>v==="unavailable"));
 assert.deepEqual(w,before);assert.equal(Object.isFrozen(result.saved.frames),true);assert.doesNotMatch(JSON.stringify(result),/not-displayed.png/);
 assert.deepEqual(buildInspectionSummary(JSON.parse(JSON.stringify(w)),"comic","task",12,clean,structuredClone(images),{"shared-image":{epoch:2,status:"ready"}}),result);
});
test("dirty, saving, conflict and save failure hide all saved prompt and frame details",()=>{
 const {w,images}=fixture();
 for(const patch of [{dirty:true},{saving:true},{conflict:true},{error:"sensitive raw error"}]){
 const result=buildInspectionSummary(w,"comic","task",12,{...clean,...patch},images,{});
 assert.equal(result.status,"hidden-unsaved");assert.equal(result.saved,null);assert.doesNotMatch(JSON.stringify(result),/精确原文|shared-image|sensitive raw error|candidate/);
 }
 for(const revision of [NaN,-1,1.5,Infinity])assert.equal(buildInspectionSummary(w,"comic","task",revision,clean,images,{}).saved,null);
});
test("missing or stale confirmation, pending and failed images are separate from saved-input coherence",()=>{
 const {w,images}=fixture();
 const pending=buildInspectionSummary(w,"comic","task",1,clean,images,{});
 assert.equal(pending.saved?.confirmation.coherent,true);assert.equal(pending.saved?.frames[0]!.previewStatus,"pending");
 const failed=buildInspectionSummary(w,"comic","task",1,clean,images,{"shared-image":{epoch:1,status:"failed"}});
 assert.equal(failed.saved?.frames[0]!.previewStatus,"failed");assert.equal(failed.saved?.confirmation.coherent,true);
 const stale=buildInspectionSummary({...w,script:"新剧本"},"comic","task",2,clean,images,{});
 assert.equal(stale.saved?.confirmation.coherent,false);assert.equal(stale.saved?.confirmation.confirmedAt,null);assert.ok(stale.saved?.confirmation.issue);
 const missing=buildInspectionSummary({...w,frames:undefined,prompts:[]},"comic","task",3,clean,images,{});
 assert.equal(missing.saved?.video,null);assert.equal(missing.saved?.frames[0]!.previewStatus,"missing");assert.equal(missing.saved?.confirmation.coherent,false);
});
test("foreign task metadata or invalid dimensions never inherit loaded state",()=>{
 const {w,images}=fixture();
 for(const rows of [[],[{...images[0]!,taskId:"other"}],[{...images[0]!,width:0}],[{...images[0]!,height:NaN}]]){
 const result=buildInspectionSummary(w,"comic","task",4,clean,rows,{"shared-image":{epoch:0,status:"ready"}});
 assert.equal(result.saved?.frames[0]!.previewStatus,"metadata-unavailable");assert.equal(result.saved?.frames[0]!.width,null);
 }
});
