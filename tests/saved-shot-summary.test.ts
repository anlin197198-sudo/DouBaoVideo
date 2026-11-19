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
