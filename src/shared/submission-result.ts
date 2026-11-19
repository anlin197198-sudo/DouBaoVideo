import { z } from "zod";
const binding = { attemptId:z.string().uuid(),taskId:z.string().uuid(),accountId:z.string().uuid(),
  inputRevision:z.number().int().nonnegative(),inputSnapshotSha256:z.string().regex(/^[0-9a-f]{64}$/) };
const attemptSchema=z.object(binding).strict();
export type SubmissionAttempt=z.infer<typeof attemptSchema>;
const evidenceSchema=z.discriminatedUnion("status",[
 z.object({...binding,status:z.literal("accepted"),protocolEvidence:z.literal("verified-acknowledgement"),remoteTaskId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict(),
 z.object({...binding,status:z.literal("declined"),protocolEvidence:z.literal("verified-no-remote-task"),remoteTaskCreated:z.literal(false)}).strict(),
]);
export type SubmissionProtocolEvidence=z.infer<typeof evidenceSchema>;
/** Pure internal classification ONLY. Evidence must be supplied by a trusted verified protocol
 * adapter; parsing caller data does not authenticate a provider response. No adapter exists here.
 * This is NOT a persisted state machine: contradictory observations require separate adjudication,
 * never last-response-wins replacement. No outcome authorizes retries or claims a completed video. */
export function resolveSubmissionResult(rawAttempt:unknown,rawEvidence:unknown){
 let attempt:SubmissionAttempt;
 try{const parsed=attemptSchema.safeParse(rawAttempt);if(!parsed.success)return Object.freeze({status:"invalid-attempt" as const,reason:"INVALID_ATTEMPT" as const,unconditionalRetry:false as const});attempt=parsed.data;}
 catch{return Object.freeze({status:"invalid-attempt" as const,reason:"INVALID_ATTEMPT" as const,unconditionalRetry:false as const});}
 const bound=Object.freeze({...attempt});
 const unknown=()=>Object.freeze({status:"requires-check" as const,attempt:bound,reason:"UNVERIFIED_OR_MISMATCHED_EVIDENCE" as const,unconditionalRetry:false as const,videoCompleted:false as const});
 try{
 const parsed=evidenceSchema.safeParse(rawEvidence);if(!parsed.success)return unknown();
 const evidence=parsed.data;
 if((Object.keys(binding) as Array<keyof SubmissionAttempt>).some(key=>evidence[key]!==attempt[key]))return unknown();
 if(evidence.status==="accepted")return Object.freeze({status:"remote-acknowledged" as const,attempt:bound,remoteTaskId:evidence.remoteTaskId,unconditionalRetry:false as const,videoCompleted:false as const});
 return Object.freeze({status:"declined-no-remote-task" as const,attempt:bound,unconditionalRetry:false as const,videoCompleted:false as const});
 }catch{return unknown();}
}
