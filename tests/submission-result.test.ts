import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {resolveSubmissionResult,type SubmissionAttempt} from "../src/shared/submission-result";
const attempt=():SubmissionAttempt=>({attemptId:randomUUID(),taskId:randomUUID(),accountId:randomUUID(),inputRevision:3,inputSnapshotSha256:"a".repeat(64)});
test("verified acknowledgement binds exact attempt and opaque reference, never completed video or retry permission",()=>{
 const a=attempt(),e={...a,status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId:"opaque_42-Z"},before=structuredClone({a,e});
 const result=resolveSubmissionResult(a,e);assert.equal(result.status,"remote-acknowledged");assert.equal(result.unconditionalRetry,false);
 if(result.status!=="remote-acknowledged")throw Error("unexpected");assert.equal(result.videoCompleted,false);assert.equal(result.remoteTaskId,"opaque_42-Z");assert.deepEqual(result.attempt,a);assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.attempt));assert.deepEqual({a,e},before);
 for(const key of ["attemptId","taskId","accountId"] as const)assert.equal(resolveSubmissionResult(a,{...e,[key]:randomUUID()}).status,"requires-check");
 for(const patch of [{inputRevision:4},{inputSnapshotSha256:"b".repeat(64)}])assert.equal(resolveSubmissionResult(a,{...e,...patch}).status,"requires-check");
});
test("timeouts malformed HTTP decline and unsafe references stay uncertain; explicit verified no-task decline is distinct",()=>{
 const a=attempt();for(const raw of [null,undefined,408,{status:400},{status:"timeout"},{...a,status:"declined"},
 {...a,status:"declined",protocolEvidence:"verified-no-remote-task",remoteTaskCreated:true},
 {...a,status:"accepted",remoteTaskId:"ref"},
 ...["https://example.test/task/1","/tmp/private","../x","contains space","","x".repeat(129)].map(remoteTaskId=>({...a,status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId}))]){const result=resolveSubmissionResult(a,raw);assert.equal(result.status,"requires-check");assert.equal(result.unconditionalRetry,false);}
 const declined=resolveSubmissionResult(a,{...a,status:"declined",protocolEvidence:"verified-no-remote-task",remoteTaskCreated:false});assert.equal(declined.status,"declined-no-remote-task");assert.equal(declined.unconditionalRetry,false);
});
test("strict invalid attempts and hostile or extra fields never echo arbitrary data",()=>{
 const a=attempt();for(const bad of [{...a,taskId:"secret"},{...a,inputRevision:-1},{...a,inputSnapshotSha256:"invalid"},{...a,extra:"secret"},{get attemptId(){throw Error("secret");}}]){const result=resolveSubmissionResult(bad,null);assert.equal(result.status,"invalid-attempt");assert.equal(result.unconditionalRetry,false);assert.doesNotMatch(JSON.stringify(result),/secret/);}
 for(const evidence of [{...a,status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId:"ref",payload:"secret"},{get status(){throw Error("secret");}}]){const result=resolveSubmissionResult(a,evidence);assert.equal(result.status,"requires-check");assert.doesNotMatch(JSON.stringify(result),/secret/);}
});

test("same-attempt ambiguity observations never create retry permission or replace prior immutable evidence",()=>{
 const a=attempt(),before=structuredClone(a);
 const uncertain=resolveSubmissionResult(a,{status:"timeout"});assert.equal(uncertain.status,"requires-check");
 const accepted=resolveSubmissionResult(a,{...a,status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId:"synthetic_ref"});
 const wrong=resolveSubmissionResult(a,{...a,attemptId:randomUUID(),status:"accepted",protocolEvidence:"verified-acknowledgement",remoteTaskId:"synthetic_other"});
 const declined=resolveSubmissionResult(a,{...a,status:"declined",protocolEvidence:"verified-no-remote-task",remoteTaskCreated:false});
 const late=resolveSubmissionResult(a,null);
 assert.equal(accepted.status,"remote-acknowledged");assert.equal(wrong.status,"requires-check");assert.equal(declined.status,"declined-no-remote-task");assert.equal(late.status,"requires-check");
 for(const result of [uncertain,accepted,wrong,declined,late]){assert.equal(result.unconditionalRetry,false);if("videoCompleted" in result)assert.equal(result.videoCompleted,false);if("attempt" in result)assert.deepEqual(result.attempt,a);}
 assert.equal(uncertain.status,"requires-check");assert.equal(accepted.status,"remote-acknowledged");assert.deepEqual(a,before);
 // These are independent classifications, not a persisted conflict-resolution state machine.
});
