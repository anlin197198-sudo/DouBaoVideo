import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AssetCandidateSession } from "../src/shared/asset-candidate";
import { AssetAdoptionSession, type AssetAdoptionInput } from "../src/shared/asset-adoption";
import { addAsset } from "../src/shared/assets";
import { addShot } from "../src/shared/storyboard";
import { addFrameCandidate, chooseFrame, confirmationInput, hasCurrentConfirmation } from "../src/shared/frames";
import { editPrompt, promptInput } from "../src/shared/prompts";
import type { TaskWorkspace } from "../src/shared/models";
function fixture(entries?: Array<{key:string;name:string;description:string;shotIds:string[]}>) {
 const taskId=randomUUID(), shotId=randomUUID();let w:TaskWorkspace={script:"合成",shots:[],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};
 w=addAsset(addShot(w,shotId),randomUUID(),"scene");w.assets[0]!.name="手动保留场景";
 w=editPrompt(w,"comic","video",null,"手动提示词保留");
 for(const role of ["first","last"] as const){const id=randomUUID();w=chooseFrame(addFrameCandidate(w,"comic",role,randomUUID(),id,"2026-11-19T00:00:00Z"),role,id);}
 w.frames!.confirmation={inputSnapshot:confirmationInput(w,"comic"),confirmedAt:"fixed",invalidated:false};
 const source=new AssetCandidateSession(JSON.stringify({formatVersion:1,people:entries??[{key:"a",name:"候选人物",description:"合成设定",shotIds:[shotId]},{key:"b",name:"未关联人物",description:"",shotIds:[]}],scenes:[],props:[]}));
 const input:AssetAdoptionInput={taskId,revision:3,workspace:w,planStyle:"comic",saveState:{dirty:false,saving:false,error:null,conflict:false},accepted:true,selectedKeys:["a"]};
 return {source,input,session:new AssetAdoptionSession(source,input)};
}
test("selective append preserves existing manual content, links and prompt snapshots while invalidating dependencies",()=>{
 const f=fixture(),before=structuredClone(f.input.workspace),id=randomUUID();const result=f.session.apply(f.input,()=>id);
 assert.equal(result.status,"draft-applied");if(result.status!=="draft-applied")throw Error("blocked");
 assert.deepEqual(f.input.workspace,before);assert.deepEqual(result.workspace.assets[0],before.assets[0]);
 const asset=result.workspace.assets[1]!;assert.equal(asset.id,id);assert.equal(asset.name,"候选人物");assert.equal(asset.referenceImageId,null);assert.equal(asset.version,1);
 assert.deepEqual(result.workspace.prompts,before.prompts);assert.equal(result.workspace.assets.length,2);assert.equal(result.workspace.assetLinks.length,1);
 assert.equal(result.workspace.shots[0]!.assetsNeedReview,true);assert.equal(result.workspace.frames!.confirmation!.invalidated,true);
 assert.notEqual(promptInput(result.workspace,"comic","video",null),before.prompts![0]!.inputSnapshot);
 assert.equal(hasCurrentConfirmation(result.workspace,"comic"),false);
 assert.deepEqual(f.session.apply(f.input,randomUUID),{status:"blocked",reason:"ALREADY_APPLIED"});
});
test("explicit acceptance, saved context, task revision, style and source lifetime guard adoption",()=>{
 for(const patch of [{accepted:false},{taskId:randomUUID()},{revision:4},{planStyle:"realistic" as const},
 ...[{dirty:true},{saving:true},{conflict:true},{error:"error"}].map(p=>({saveState:{dirty:false,saving:false,error:null,conflict:false,...p}}))]){
 const f=fixture();let called=false;assert.equal(f.session.apply({...f.input,...patch},()=>{called=true;return randomUUID();}).status,"blocked");assert.equal(called,false);
 }
 const f=fixture();f.source.discard();assert.equal(f.session.apply(f.input,randomUUID).status,"blocked");
 const g=fixture();g.input.workspace.script+=" changed";assert.equal(g.session.apply(g.input,randomUUID).status,"blocked");
});
test("unknown repeated unmatched keys and ambiguous names reject atomically without automatic merging",()=>{
 for(const selectedKeys of [[],["absent"],["a","a"]]){const f=fixture();assert.equal(f.session.apply({...f.input,selectedKeys},randomUUID).status,"blocked");}
 for(const entries of [[{key:"a",name:"候选",description:"",shotIds:[randomUUID()]}],[{key:"a",name:" 手动保留场景 ",description:"",shotIds:[]}],
 [{key:"a",name:"Ａ",description:"",shotIds:[]},{key:"b",name:" a ",description:"",shotIds:[]}]]){
 const f=fixture(entries);assert.equal(f.session.apply({...f.input,selectedKeys:entries.map(e=>e.key)},randomUUID).status,"blocked");
 }
 const f=fixture();const result=f.session.apply({...f.input,selectedKeys:["b"]},randomUUID);assert.equal(result.status,"draft-applied");
 if(result.status==="draft-applied"){assert.equal(result.workspace.assetLinks.length,0);assert.equal(result.workspace.frames!.confirmation!.invalidated,false);}
});
test("capacity and failed/colliding IDs leave inputs intact and permit a safe retry",()=>{
 const f=fixture();for(let i=0;i<199;i++)f.input.workspace=addAsset(f.input.workspace,randomUUID(),"prop");
 const full=new AssetAdoptionSession(f.source,f.input);assert.deepEqual(full.apply(f.input,randomUUID),{status:"blocked",reason:"CAPACITY"});
 for(const factory of [()=>"bad",()=>{throw Error("secret");}]){const g=fixture(),before=structuredClone(g.input.workspace);assert.deepEqual(g.session.apply(g.input,factory),{status:"blocked",reason:"INVALID_ID"});assert.deepEqual(g.input.workspace,before);assert.equal(g.session.apply(g.input,randomUUID).status,"draft-applied");}
 const g=fixture();assert.equal(g.session.apply(g.input,()=>g.input.workspace.shots[0]!.id).status,"blocked");
 const h=fixture(),id=randomUUID();assert.deepEqual(h.session.apply({...h.input,selectedKeys:["a","b"]},()=>id),{status:"blocked",reason:"INVALID_ID"});assert.equal(h.input.workspace.assets.length,1);
 const reentrant=fixture();let inner:unknown;
 assert.equal(reentrant.session.apply(reentrant.input,()=>{inner=reentrant.session.apply(reentrant.input,randomUUID);return randomUUID();}).status,"draft-applied");
 assert.deepEqual(inner,{status:"blocked",reason:"APPLYING"});
 const dirty=fixture();assert.equal(dirty.session.apply(dirty.input,()=>{dirty.input.saveState.dirty=true;return randomUUID();}).status,"blocked");
 for(const mutate of [(f:ReturnType<typeof fixture>)=>{f.input.accepted=false;},(f:ReturnType<typeof fixture>)=>{f.input.selectedKeys=["b"];},(f:ReturnType<typeof fixture>)=>{f.input.revision++;},(f:ReturnType<typeof fixture>)=>{f.input.planStyle="realistic";},(f:ReturnType<typeof fixture>)=>{f.source.discard();}]){
 const changed=fixture();assert.equal(changed.session.apply(changed.input,()=>{mutate(changed);return randomUUID();}).status,"blocked");}
 const k=fixture();assert.equal(k.session.apply(k.input,()=>{k.input.workspace.script+="changed";return randomUUID();}).status,"blocked");
});
