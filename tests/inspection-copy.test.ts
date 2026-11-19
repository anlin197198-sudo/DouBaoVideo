import assert from "node:assert/strict";
import { test } from "node:test";
import { InspectionCopy } from "../src/shared/inspection-copy";
import { buildInspectionSummary } from "../src/shared/inspection-summary";
import { addFrameCandidate, chooseFrame, confirmationInput } from "../src/shared/frames";
import { editPrompt } from "../src/shared/prompts";
import type { TaskWorkspace, ReferenceImage } from "../src/shared/models";
const clean={dirty:false,saving:false,error:null,conflict:false};
function fixture(){let w:TaskWorkspace={script:"合成",shots:[],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};w=editPrompt(w,"comic","video",null," 精确已保存正文\n尾空格 ");
 for(const role of ["first","last"] as const)w=chooseFrame(addFrameCandidate(w,"comic",role,"image",role,"fixed"),role,role);
 w.frames!.confirmation={inputSnapshot:confirmationInput(w,"comic"),confirmedAt:"fixed",invalidated:false};
 const images:ReferenceImage[]=[{id:"image",taskId:"task",originalName:"synthetic.png",width:10,height:10,createdAt:"fixed"}];
 const previews={image:{epoch:0,status:"ready" as const}};return {w,images,previews};}
test("copy captures exact saved text only with clean coherent confirmation and loaded current task images",()=>{
 const {w,images,previews}=fixture(),before=structuredClone(w),s=new InspectionCopy();const summary=buildInspectionSummary(w,"comic","task",2,clean,images,previews);
 assert.equal(s.observe(summary,previews,false),true);const token=s.begin()!;assert.equal(token.text," 精确已保存正文\n尾空格 ");assert.equal(s.begin(),null);assert.equal(s.finish(token),true);assert.equal(s.finish(token),false);assert.deepEqual(w,before);
 for(const state of [{...clean,dirty:true},{...clean,saving:true},{...clean,error:"error"},{...clean,conflict:true}]){assert.equal(s.observe(buildInspectionSummary(w,"comic","task",2,state,images,previews),previews,false),false);assert.equal(s.begin(),null);}
 for(const status of ["failed","pending"] as const)assert.equal(s.observe(buildInspectionSummary(w,"comic","task",2,clean,images,{image:{epoch:1,status}}),previews,false),false);
 assert.equal(s.observe(buildInspectionSummary({...w,script:"changed"},"comic","task",2,clean,images,previews),previews,false),false);
 assert.equal(s.observe(buildInspectionSummary(w,"comic","foreign",2,clean,images,previews),previews,false),false);assert.equal(s.observe(summary,previews,true),false);
});
test("pending clipboard feedback cannot survive task/revision/source epochs or close/reopen with identical text",async()=>{
 const {w,images,previews}=fixture(),s=new InspectionCopy(),a=buildInspectionSummary(w,"comic","task",2,clean,images,previews);
 s.observe(a,previews,false);const old=s.begin()!;let resolve!:()=>void;const delayed=new Promise<void>(r=>resolve=r).then(()=>s.finish(old));
 s.observe(buildInspectionSummary(w,"comic","task",3,clean,images,previews),previews,false);s.observe(a,previews,false);const newer=s.begin()!;resolve();assert.equal(await delayed,false);assert.equal(s.current(newer),true);
 s.cancel();s.observe(a,previews,false);const reopened=s.begin()!;assert.equal(s.finish(newer),false);assert.equal(s.finish(reopened),true);
 const token=s.begin()!;s.observe(a,{image:{epoch:4,status:"ready"}},false);assert.equal(s.finish(token),false);
});
