import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { VideoImportCoordinator,type VideoImportPorts,type VideoImportStage } from "../src/main/application/video-import-coordinator";
function fixture(){const fingerprint={sha256:"a".repeat(64),bytes:100},intent={requestId:randomUUID(),taskId:randomUUID(),intentToken:randomUUID(),expectedFingerprint:fingerprint};
 const binding={intent,reservationId:randomUUID(),fenceToken:randomUUID()};const stage:VideoImportStage={binding,stageId:randomUUID(),fingerprint:{...fingerprint},decoder:{status:"verified",fingerprint:{...fingerprint},format:"mp4",width:10,height:10,durationSeconds:1}},artifact={stage,artifactId:randomUUID(),cleanup:"complete" as const};const calls:string[]=[];let reserved=false;
 const ports:VideoImportPorts={reserve:async()=>{calls.push("reserve");const status=reserved?"existing":"reserved";reserved=true;return {status,binding}},stage:async()=>{calls.push("stage");return stage},recheck:async()=>{calls.push("recheck");return true},publish:async()=>{calls.push("publish");return {status:"published",artifact}},commit:async()=>{calls.push("commit");return {status:"committed",artifact}},reconcile:async()=>{calls.push("reconcile");return {status:"committed",artifact}}};return {intent,stage,binding,artifact,ports,calls};}
test("confirmed intent reserves before stage and commits exact receipt; replay never stages or publishes again",async()=>{
 const f=fixture(),before=structuredClone(f.stage),c=new VideoImportCoordinator(f.ports);const r=await c.run(f.intent);assert.equal(r.status,"recorded");assert.equal(r.taskCompleted,false);assert.equal(r.automaticRetry,false);assert.deepEqual(f.calls,["reserve","stage","recheck","publish","commit"]);assert.deepEqual(f.stage,before);
 assert.equal((await new VideoImportCoordinator(f.ports).run(f.intent)).status,"reconcile-required");assert.equal(f.calls.filter(c=>c==="stage").length,1);assert.equal(f.calls.filter(c=>c==="publish").length,1);assert.equal((await c.reconcile(f.intent)).status,"recorded");
});
test("cancel invokes no ports; invalid evidence or changed intent cannot publish and changed same-ID intent cannot reconcile",async()=>{
 const empty=fixture(),c=new VideoImportCoordinator(empty.ports);assert.equal((await c.run(null)).status,"cancelled");assert.equal((await c.run({...empty.intent,path:"secret"})).status,"invalid-request");assert.deepEqual(empty.calls,[]);
 for(const phase of ["decoder","intent"]){const f=fixture();if(phase==="decoder")f.stage.decoder.fingerprint.sha256="b".repeat(64);else f.ports.recheck=async()=>false;assert.notEqual((await new VideoImportCoordinator(f.ports).run(f.intent)).status,"recorded");assert.ok(!f.calls.includes("publish"));}
 for(const patch of [{intentToken:randomUUID()},{taskId:randomUUID()},{expectedFingerprint:{sha256:"b".repeat(64),bytes:100}}])assert.equal((await c.reconcile({...empty.intent,...patch})).status,"reconcile-required");
});
test("ambiguous reservation/stage/publication/commit and cleanup failures require read-only reconciliation",async()=>{
 for(const phase of ["reserve","stage","publish","commit"] as const){const f=fixture();f.ports[phase]=async()=>{throw Error("private failure")};const r=await new VideoImportCoordinator(f.ports).run(f.intent);assert.equal(r.status,"reconcile-required");assert.doesNotMatch(JSON.stringify(r),/private failure/);assert.equal(r.automaticRetry,false);}
 for(const status of ["not-published","uncertain"] as const){const f=fixture();f.ports.publish=async()=>({status,artifact:null});assert.equal((await new VideoImportCoordinator(f.ports).run(f.intent)).status,"reconcile-required");assert.ok(!f.calls.includes("commit"));}
 const f=fixture();f.ports.publish=async()=>({status:"published",artifact:{...f.artifact,cleanup:"retained"}});assert.equal((await new VideoImportCoordinator(f.ports).run(f.intent)).status,"reconcile-required");assert.ok(!f.calls.includes("commit"));
 const mismatch=fixture();mismatch.ports.commit=async()=>({status:"committed",artifact:{...mismatch.artifact,artifactId:randomUUID()}});assert.equal((await new VideoImportCoordinator(mismatch.ports).run(mismatch.intent)).status,"reconcile-required");
});
test("pending publication holds same-request guard until port work settles; durable reservation blocks postfailure restaging",async()=>{
 const f=fixture();let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 f.ports.publish=async()=>{f.calls.push("publish");entered();await gate;throw Error("settled after worker stops")};const c=new VideoImportCoordinator(f.ports),pending=c.run(f.intent);await reached;assert.equal((await c.run(f.intent)).status,"in-flight");assert.equal((await c.reconcile(f.intent)).status,"in-flight");release();assert.equal((await pending).status,"reconcile-required");assert.equal((await c.run(f.intent)).status,"reconcile-required");assert.equal(f.calls.filter(x=>x==="stage").length,1);
});

test("lost metadata receipt preserves committed record and resolves only by explicit read-only inspection",async()=>{
 const f=fixture();let committed:unknown=null;
 f.ports.commit=async artifact=>{f.calls.push("commit");committed=structuredClone(artifact);throw Error("receipt lost after commit");};
 f.ports.reconcile=async()=>{f.calls.push("reconcile");return committed?{status:"committed",artifact:committed}:null;};
 const c=new VideoImportCoordinator(f.ports);assert.equal((await c.reconcile(f.intent)).status,"reconcile-required");
 assert.equal((await c.run(f.intent)).status,"reconcile-required");const retained=structuredClone(committed);
 assert.equal((await c.reconcile(f.intent)).status,"recorded");assert.deepEqual(committed,retained);
 assert.equal((await c.run(f.intent)).status,"reconcile-required");assert.equal(f.calls.filter(x=>x==="publish").length,1);assert.equal(f.calls.filter(x=>x==="commit").length,1);
});
