import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyPreviewGlobalFields, updatePreviewGlobalField, getPreviewTemplateInputGaps, MAX_PREVIEW_GLOBAL_CHARS } from "../src/shared/template-preview-fields";
import { getTemplateInputGaps } from "../src/shared/template-input-gaps";
import { formatPromptTemplate } from "../src/shared/prompt-template";
import type { TaskWorkspace } from "../src/shared/models";
function workspace(): TaskWorkspace { return { script:"合成内容",shots:[{id:"shot",title:"合成镜头",description:"动态描述",action:"动态动作",shotSize:"近景",cameraMovement:"横移",audio:"声音",position:{x:0,y:0},needsReview:false}],assets:[],assetLinks:[],viewport:{x:0,y:0,zoom:1},scriptPosition:{x:0,y:0},frames:{candidates:[],firstId:null,lastId:null,parameters:{aspectRatio:"16:9",durationSeconds:10},confirmation:null} }; }
test("explicit temporary updates preserve exact text, reject invalid size/type/key and reset independently",()=>{
 const blank=emptyPreviewGlobalFields(),next=updatePreviewGlobalField(blank,"tone","  用户基调\n原文  ");
 assert.equal(next.tone,"  用户基调\n原文  ");assert.equal(blank.tone,"");assert.ok(Object.isFrozen(next));
 assert.equal(updatePreviewGlobalField(next,"lighting","x".repeat(MAX_PREVIEW_GLOBAL_CHARS)).lighting.length,2000);
 for(const run of [()=>updatePreviewGlobalField(next,"tone","x".repeat(2001)),()=>updatePreviewGlobalField(next,"bad" as never,"v"),()=>updatePreviewGlobalField(next,"tone",123 as never),()=>updatePreviewGlobalField({...next,extra:"bad"} as never,"tone","v")])assert.throws(run,/临时预览字段无效/);
 const reset=emptyPreviewGlobalFields();assert.deepEqual(reset,blank);assert.notEqual(reset,blank);assert.equal(next.tone,"  用户基调\n原文  ");
});
test("all four formatter kinds reflect supplied fields exactly without changing workspace or inferring static motion",()=>{
 const w=workspace(),before=structuredClone(w);let fields=emptyPreviewGlobalFields();
 fields=updatePreviewGlobalField(fields,"tone","用户基调");fields=updatePreviewGlobalField(fields,"lighting","用户光线");fields=updatePreviewGlobalField(fields,"colorAnchor","用户色彩");
 for(const kind of ["shot","video","firstFrame","lastFrame"] as const){const text=formatPromptTemplate(w,"comic",kind,kind==="shot"?"shot":null,fields);
 for(const value of ["影片基调：用户基调","光线设计：用户光线","色彩锚点：用户色彩"])assert.ok(text.includes(value));
 if(kind==="firstFrame"||kind==="lastFrame")assert.doesNotMatch(text,/动态描述|动态动作|横移|声音设计|时长|10秒/);
 }
 assert.deepEqual(w,before);
});
test("only nonblank explicit globals remove their gaps; other gaps and false readiness remain",()=>{
 const w=workspace(),blank=emptyPreviewGlobalFields(),original=getTemplateInputGaps(w,"video",null);
 assert.deepEqual(getPreviewTemplateInputGaps(w,"video",null,blank),original);
 assert.deepEqual(getPreviewTemplateInputGaps(w,"video",null,updatePreviewGlobalField(blank,"tone"," \n ")),original);
 let fields=blank;for(const key of ["tone","lighting","colorAnchor"] as const)fields=updatePreviewGlobalField(fields,key,"明确填写");
 for(const kind of ["shot","video","firstFrame","lastFrame"] as const){const id=kind==="shot"?"shot":null,summary=getPreviewTemplateInputGaps(w,kind,id,fields);
 assert.equal(summary.canFill,false);assert.equal(summary.readiness,"manual-completion-required");
 assert.deepEqual(summary.gaps,getTemplateInputGaps(w,kind,id).gaps.filter(g=>g.scope!=="global"||!["tone","lighting","colorAnchor"].includes(g.code)));
 assert.ok(summary.gaps.some(g=>g.code===(kind==="shot"||kind==="video"?"duration":"composition")));
 }
 assert.deepEqual(getPreviewTemplateInputGaps(w,"video",null,emptyPreviewGlobalFields()),original);
});
