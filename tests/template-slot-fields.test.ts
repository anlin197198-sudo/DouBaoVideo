import assert from "node:assert/strict";
import {test} from "node:test";
import {emptyTemplateSlotFields,updateTemplateSlotField,toPromptTemplateSlotFields,getSlotTemplateInputGaps} from "../src/shared/template-slot-fields";
import {formatPromptTemplate} from "../src/shared/prompt-template";
import type {TaskWorkspace} from "../src/shared/models";
function workspace():TaskWorkspace{return{script:"合成",shots:["a","b"].map(id=>({id,title:id,description:"动态描述",action:"动作",shotSize:"近景",cameraMovement:"运镜",audio:"声音",position:{x:0,y:0},needsReview:false})),assets:[],assetLinks:[],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0}};}
test("shot fields preserve explicit text only for bound shot, keep other gaps and do not mutate",()=>{
 const w=workspace(),before=structuredClone(w),empty=emptyTemplateSlotFields(w,"shot","a");let fields=updateTemplateSlotField(empty,"duration","  明确时长  ");fields=updateTemplateSlotField(fields,"continuity","明确连续性");
 assert.deepEqual(empty.values,{duration:"",continuity:""});const optional=toPromptTemplateSlotFields(w,"shot","a",fields);
 assert.deepEqual(optional,{shots:{a:{duration:"  明确时长  ",continuity:"明确连续性"}}});
 assert.match(formatPromptTemplate(w,"comic","shot","a",optional),/时长：  明确时长  /);
 const gaps=getSlotTemplateInputGaps(w,"shot","a",fields);assert.equal(gaps.canFill,false);assert.ok(!gaps.gaps.some(g=>["duration","continuity"].includes(g.code)));assert.ok(gaps.gaps.some(g=>g.code==="tone"));
 assert.throws(()=>toPromptTemplateSlotFields(w,"shot","b",fields));assert.throws(()=>toPromptTemplateSlotFields(w,"video",null,fields));assert.deepEqual(w,before);
});
test("static roles bind actual endpoints and never turn prose into motion, duration or other role",()=>{
 const w=workspace();for(const kind of ["firstFrame","lastFrame"] as const){let fields=emptyTemplateSlotFields(w,kind,null);fields=updateTemplateSlotField(fields,"composition","明确静态构图");fields=updateTemplateSlotField(fields,"state","明确静态状态");
 const text=formatPromptTemplate(w,"comic",kind,null,toPromptTemplateSlotFields(w,kind,null,fields));assert.match(text,/明确静态构图/);assert.match(text,/明确静态状态/);assert.doesNotMatch(text,/动态描述|动作|运镜|声音设计|时长/);
 assert.ok(!getSlotTemplateInputGaps(w,kind,null,fields).gaps.some(g=>["composition","state"].includes(g.code)));
 assert.throws(()=>toPromptTemplateSlotFields(w,kind==="firstFrame"?"lastFrame":"firstFrame",null,fields));
 assert.throws(()=>toPromptTemplateSlotFields({...w,shots:[...w.shots].reverse()},kind,null,fields));}
});
test("limits, blank values, missing endpoints and old scope fail safely without changing original state",()=>{
 const w=workspace(),empty=emptyTemplateSlotFields(w,"shot","a");
 assert.equal((updateTemplateSlotField(empty,"duration","x".repeat(2000)).values as {duration:string}).duration.length,2000);
 for(const run of [()=>updateTemplateSlotField(empty,"duration","x".repeat(2001)),()=>updateTemplateSlotField(empty,"composition","x"),()=>updateTemplateSlotField(empty,"duration",42 as never),()=>toPromptTemplateSlotFields({...w,shots:[]},"shot","a",empty)])assert.throws(run);
 const blank=updateTemplateSlotField(empty,"duration"," \n ");assert.ok(getSlotTemplateInputGaps(w,"shot","a",blank).gaps.some(g=>g.code==="duration"));
 const none={...w,shots:[]};const staticEmpty=emptyTemplateSlotFields(none,"firstFrame",null);assert.equal(staticEmpty.shotId,null);assert.throws(()=>toPromptTemplateSlotFields(w,"firstFrame",null,staticEmpty));
 assert.ok(Object.isFrozen(empty.values));assert.deepEqual(emptyTemplateSlotFields(w,"shot","a"),empty);
});
