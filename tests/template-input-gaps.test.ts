import assert from "node:assert/strict";
import {test} from "node:test";
import {getTemplateInputGaps} from "../src/shared/template-input-gaps";
import type {TaskWorkspace} from "../src/shared/models";
function fixture():TaskWorkspace{return {script:"完整合成剧本",promptSettings:{style:"comic",notes:"基调光线及色彩自由描述"},shots:["a","b"].map(id=>({id,title:id,description:"完整描述",action:"动作",shotSize:"近景",cameraMovement:"横移",audio:"环境声",position:{x:0,y:0},needsReview:false})),assets:[{id:"asset",type:"person",name:"人物",description:"设定",referenceImageId:"image",version:1,position:{x:0,y:0},needsReview:false}],assetLinks:[{shotId:"a",assetId:"asset"}],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0},frames:{candidates:[],firstId:null,lastId:null,parameters:{aspectRatio:"16:9",durationSeconds:10},confirmation:null}};}
test("rich current workspace still lacks structured fields and never becomes fill-ready",()=>{
 const w=fixture(),before=structuredClone(w),result=getTemplateInputGaps(w,"video",null);
 assert.equal(result.readiness,"manual-completion-required");assert.equal(result.canFill,false);
 assert.deepEqual(result.gaps.filter(g=>g.scope==="global").map(g=>g.code),["tone","lighting","colorAnchor"]);
 assert.deepEqual(result.gaps.filter(g=>g.code==="duration").map(g=>g.shotId),["a","b"]);
 assert.deepEqual(result.gaps.filter(g=>g.code==="continuity").map(g=>g.shotId),["a","b"]);
 assert.ok(result.gaps.some(g=>g.code==="referenceMapping"&&g.shotId==="a"));assert.deepEqual(w,before);
 assert.equal(Object.isFrozen(result.gaps[0]),true);
 w.frames!.parameters.durationSeconds=5;assert.deepEqual(getTemplateInputGaps(w,"video",null),result);
});
test("only selected shot contributes local gaps; empty content is informational not mandatory",()=>{
 const w=fixture();w.shots[1] = {...w.shots[1]!,description:"",audio:"",shotSize:"",cameraMovement:""};
 const one=getTemplateInputGaps(w,"shot","a"),two=getTemplateInputGaps(w,"shot","b");
 assert.ok(one.gaps.every(g=>g.shotId===null||g.shotId==="a"));assert.equal(one.gaps.some(g=>g.category==="content-empty"),false);
 for(const code of ["description","audio","camera","assetLinks"])assert.ok(two.gaps.some(g=>g.code===code&&g.category==="content-empty"));
 assert.doesNotMatch(JSON.stringify(two),/动作要求|负面约束/); // Optional absences are not promoted to mandatory requirements.
});
test("static endpoints expose distinct composition/state, not inferred timeline or sound requirements",()=>{
 const w=fixture();for(const kind of ["firstFrame","lastFrame"] as const){const result=getTemplateInputGaps(w,kind,null);
 const states=result.gaps.filter(g=>["composition","state"].includes(g.code));assert.equal(states.length,2);assert.ok(states.every(g=>g.scope===kind&&g.shotId===(kind==="firstFrame"?"a":"b")));
 assert.ok(result.gaps.every(g=>!["duration","continuity","audio","description"].includes(g.code)));}
 const empty=getTemplateInputGaps({...w,shots:[]},"firstFrame",null);assert.ok(empty.gaps.some(g=>g.code==="shots"));
 assert.throws(()=>getTemplateInputGaps(w,"shot","missing"));assert.throws(()=>getTemplateInputGaps(w,"video","a"));assert.throws(()=>getTemplateInputGaps(w,"bad" as never,null));
});
