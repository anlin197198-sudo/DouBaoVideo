import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { reconcileSubmissionResults as reconcile, MAX_SUBMISSION_OBSERVATIONS } from "../src/shared/submission-reconciliation";
const attempt=()=>({attemptId:randomUUID(),taskId:randomUUID(),accountId:randomUUID(),inputRevision:2,inputSnapshotSha256:"a".repeat(64)});
const ack=(a:ReturnType<typeof attempt>,remoteTaskId="ref_a")=>({...a,status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId});
const decline=(a:ReturnType<typeof attempt>)=>({...a,status:"declined",protocolEvidence:"verified-no-remote-task",remoteTaskCreated:false});
test("accepted identity is retained across duplicate, late unknown and foreign observations without retry authorization",()=>{
 const a=attempt(),e=[ack(a),null,{status:"timeout"},ack(a),ack({...a,taskId:randomUUID()},"foreign")],before=structuredClone({a,e});
 const result=reconcile(a,e);assert.equal(result.status,"remote-acknowledged");assert.ok("acceptedReferences" in result);assert.deepEqual(result.acceptedReferences,["ref_a"]);
 assert.equal(result.unconditionalRetry,false);assert.ok("videoCompleted" in result);assert.equal(result.videoCompleted,false);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.acceptedReferences));
 assert.deepEqual({a,e},before);assert.deepEqual(reconcile(a,[...e].reverse()),result);
 for(const key of ["attemptId","accountId","taskId"] as const)assert.equal(reconcile(a,[ack({...a,[key]:randomUUID()})]).status,"requires-check");
 assert.equal(reconcile(a,[ack({...a,inputRevision:3})]).status,"requires-check");assert.equal(reconcile(a,[ack({...a,inputSnapshotSha256:"b".repeat(64)})]).status,"requires-check");
});
test("conflicting IDs and verified no-task contradictions remain human-check with complete list regardless of later evidence",()=>{
 const a=attempt();for(const evidence of [[ack(a,"z"),ack(a,"a")],[ack(a),decline(a)]]){
 for(const suffix of [[],[null],[ack(a)],[decline(a)]]){const r=reconcile(a,[...evidence,...suffix]);assert.equal(r.status,"requires-human-check");assert.equal(r.unconditionalRetry,false);assert.ok("acceptedReferences" in r);assert.ok(r.acceptedReferences.length>0);}
 assert.deepEqual(reconcile(a,evidence),reconcile(a,[...evidence].reverse()));}
 const sorted=reconcile(a,[ack(a,"z"),ack(a,"a")]);assert.ok("acceptedReferences" in sorted);assert.deepEqual(sorted.acceptedReferences,["a","z"]);
 assert.equal(reconcile(a,[decline(a),decline(a)]).status,"declined-no-remote-task");assert.equal(reconcile(a,[decline(a),null]).status,"requires-check");assert.equal(reconcile(a,[]).status,"requires-check");
});
test("bounded admission and hostile evidence use fixed outcomes without payload leaks or executing array getters",()=>{
 const a=attempt();for(const list of [null,{},new Array(1),Array(MAX_SUBMISSION_OBSERVATIONS+1).fill(ack(a))]){const r=reconcile(a,list);assert.equal(r.status,"requires-human-check");assert.equal(r.unconditionalRetry,false);}
 let invoked=false;const list:unknown[]=[];Object.defineProperty(list,"0",{get(){invoked=true;throw Error("private secret")}});assert.equal(reconcile(a,list).status,"requires-human-check");assert.equal(invoked,false);
 for(const raw of [{get status(){throw Error("private secret")}}, {...ack(a),payload:"private secret"},ack(a,"/private/path")]){const result=reconcile(a,[raw]);assert.equal(result.status,"requires-check");assert.doesNotMatch(JSON.stringify(result),/private|secret/);}
 assert.equal(reconcile({...a,taskId:"private secret"},[]).status,"invalid-attempt");assert.equal(reconcile(a,Array(MAX_SUBMISSION_OBSERVATIONS).fill(ack(a))).status,"remote-acknowledged");
});

test("array proxy length is read once and rejected lists do not masquerade as an empty ledger",()=>{
 const a=attempt();let reads=0,slots=0;
 const proxy=new Proxy(Array(101).fill(ack(a)),{get(target,key,receiver){if(key==="length")return ++reads===1?1:Infinity;return Reflect.get(target,key,receiver)},getOwnPropertyDescriptor(target,key){slots++;return Reflect.getOwnPropertyDescriptor(target,key)}});
 const result=reconcile(a,proxy);assert.equal(result.status,"remote-acknowledged");assert.equal(reads,1);assert.equal(slots,1);
 for(const invalid of [null,Array(101).fill(ack(a)),new Proxy([],{get(t,k,r){return k==="length"?NaN:Reflect.get(t,k,r)}})]){
 const rejected=reconcile(a,invalid);assert.ok("evaluated" in rejected);assert.equal(rejected.evaluated,false);assert.equal("acceptedReferences" in rejected,false);
 }
});
