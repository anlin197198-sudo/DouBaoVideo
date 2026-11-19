import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AssetCandidateSession, MAX_ASSET_REPLY_CHARS } from "../src/shared/asset-candidate";
import { addShot } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import type { TaskWorkspace } from "../src/shared/models";
const one=randomUUID(), unknown=randomUUID();
const entry={key:"person-1",name:"合成名称",description:"合成设定",shotIds:[one,unknown]};
const payload=()=>({formatVersion:1,people:[entry],scenes:[{...entry,key:"scene-1",shotIds:[]}],props:[{...entry,key:"prop-1",shotIds:[one]}]});
function workspace(){const w:TaskWorkspace={script:"合成测试",shots:[],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};return addAsset(addShot(w,one),randomUUID(),"person");}
test("groups map new suggestions only; explicit shot ids match or surface unmatched without touching manual entities",()=>{
 const w=workspace();w.assets[0]!.name=entry.name;const before=structuredClone(w),session=new AssetCandidateSession(JSON.stringify(payload()));
 const preview=session.preview(w);assert.deepEqual(preview.candidates.map(c=>c.type),["person","scene","prop"]);
 assert.deepEqual(preview.candidates[0]!.matchedShotIds,[one]);assert.deepEqual(preview.candidates[0]!.unmatchedShotIds,[unknown]);assert.deepEqual(preview.candidates[1]!.matchedShotIds,[]);
 assert.equal("id" in preview.candidates[0]!,false);assert.equal("existingAssetId" in preview.candidates[0]!,false);
 assert.equal(Object.isFrozen(preview.candidates[0]!.matchedShotIds),true);assert.equal(Reflect.set(preview.candidates[0]!,"name","overwrite"),false);assert.deepEqual(w,before);
 assert.equal(session.isCurrent(preview,w),true);assert.equal(session.isCurrent(structuredClone(preview),w),false);
 assert.equal(new AssetCandidateSession(JSON.stringify(payload())).isCurrent(preview,w),false);
 for(const change of [(v:TaskWorkspace)=>{v.script+="x";},(v:TaskWorkspace)=>{v.assets[0]!.name="edit";},(v:TaskWorkspace)=>{v.shots=[];},(v:TaskWorkspace)=>{v.viewport.x=4;}]){const copy=structuredClone(w);change(copy);assert.equal(session.isCurrent(preview,copy),false);}
 session.discard();assert.equal(session.isCurrent(preview,w),false);assert.equal(session.readRawReply(),null);assert.throws(()=>session.preview(w),/没有可预览/);
});
test("strict malformed replies retain full private raw with safe status and errors",()=>{
 const bad=["SECRET-raw","```json\n{}\n```",JSON.stringify({...payload(),extra:"SECRET"}),JSON.stringify({...payload(),formatVersion:2}),
 JSON.stringify({...payload(),scenes:undefined}),JSON.stringify({...payload(),people:[{...entry,existingAssetId:randomUUID()}]}),
 JSON.stringify({...payload(),people:[{...entry,shotIds:[one,one]}]}),JSON.stringify({...payload(),people:[{...entry,shotIds:["invalid"]}]}),
 JSON.stringify({...payload(),props:[entry]}),JSON.stringify({...payload(),people:[{...entry,name:" "}]}),JSON.stringify({...payload(),people:[{...entry,key:"bad key"}]})];
 for(const raw of bad){const session=new AssetCandidateSession(raw);assert.equal(session.status.status,"failed");assert.equal(session.readRawReply(),raw);assert.equal(JSON.stringify(session),"{}");assert.doesNotMatch(JSON.stringify(session.status),/SECRET|合成名称|existingAssetId/);session.discard();assert.equal(session.readRawReply(),null);}
});
test("bounded fields and total entries, empty extraction honest, oversized text and objects never retained",()=>{
 assert.equal(new AssetCandidateSession(JSON.stringify({formatVersion:1,people:[],scenes:[],props:[]})).status.status,"ready");
 const people=Array.from({length:200},(_,i)=>({...entry,key:`p${i}`,shotIds:[]}));
 assert.equal(new AssetCandidateSession(JSON.stringify({formatVersion:1,people,scenes:[],props:[]})).status.status,"ready");
 assert.equal(new AssetCandidateSession(JSON.stringify({formatVersion:1,people,scenes:[{...entry,key:"overflow"}],props:[]})).status.status,"failed");
 for(const patch of [{name:"x".repeat(121)},{description:"x".repeat(10001)},{shotIds:Array.from({length:201},()=>randomUUID())}])assert.equal(new AssetCandidateSession(JSON.stringify({...payload(),people:[{...entry,...patch}]})).status.status,"failed");
 const large=new AssetCandidateSession("x".repeat(MAX_ASSET_REPLY_CHARS+1));assert.equal(large.status.rawRetained,false);assert.equal(large.readRawReply(),null);
 let accessed=false;const object={get value(){accessed=true;throw Error("SECRET");},toJSON(){accessed=true;throw Error("SECRET");}};
 assert.equal(new AssetCandidateSession(object).status.rawRetained,false);assert.equal(accessed,false);
});
