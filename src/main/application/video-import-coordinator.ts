import { z } from "zod";
const uuid=z.string().uuid();
const fingerprintSchema=z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/),bytes:z.number().int().positive().max(8*1024**3)}).strict();
const intentSchema=z.object({requestId:uuid,taskId:uuid,intentToken:uuid,expectedFingerprint:fingerprintSchema}).strict();
const bindingSchema=z.object({intent:intentSchema,reservationId:uuid,fenceToken:uuid}).strict();
const stageSchema=z.object({binding:bindingSchema,stageId:uuid,fingerprint:fingerprintSchema,decoder:z.object({status:z.literal("verified"),fingerprint:fingerprintSchema,
 format:z.literal("mp4"),width:z.number().int().positive().max(100000),height:z.number().int().positive().max(100000),durationSeconds:z.number().finite().positive()}).strict()}).strict();
export type VideoImportIntent=z.infer<typeof intentSchema>;
export type VideoImportBinding=z.infer<typeof bindingSchema>;
export type VideoImportStage=z.infer<typeof stageSchema>;
const artifactSchema=z.object({stage:stageSchema,artifactId:uuid,cleanup:z.enum(["complete","retained","unknown"])}).strict();
export type VideoImportArtifact=z.infer<typeof artifactSchema>;
/** Trusted future ports only; no production decoder/store/publisher exists here.
 * Main has already selected and explicitly confirmed the immutable intent. null means cancellation.
 * reserve atomically durably dedupes requestId, rejects rebinding of ANY intent field, and creates a
 * neutral import reservation, never an execution/task-completed record. Existing records aren't resumed.
 * stage belongs to that durable reservation. recheck alone cannot fence asynchronous effects:
 * stage/publish/commit must enforce the same token/current intent/fingerprint throughout operations.
 * publish MUST exclusively create, never overwrite, and report uncertainty rather than assume failure.
 * Every promise settlement, including rejection, MUST mean all background side effects have stopped.
 * commit atomically compares full intent/binding/stage/artifact and returns an authoritative receipt.
 * Parsing decoder evidence is not authentication; only a trusted actual decoder may supply verified.
 * Staging retention/disposal belongs to the ports; this service never deletes source/output or retries. */
export interface VideoImportPorts {
 reserve(intent:Readonly<VideoImportIntent>):Promise<unknown>;
 stage(binding:Readonly<VideoImportBinding>):Promise<unknown>;
 recheck(stage:Readonly<VideoImportStage>):Promise<boolean>;
 publish(stage:Readonly<VideoImportStage>):Promise<unknown>;
 commit(artifact:Readonly<VideoImportArtifact>):Promise<unknown>;
 /** Authoritative read-only inspection; never cleanup, resume or retry. */
 reconcile(intent:Readonly<VideoImportIntent>):Promise<unknown>;
}
export type VideoImportResult=Readonly<{status:"invalid-request"|"in-flight"|"cancelled"|"invalid-stage"|"reconcile-required"|"recorded";
 automaticRetry:false;taskCompleted:false;cleanupRequested:false;staging:"port-managed";reason:string}>;
function result(status:VideoImportResult["status"],reason:string):VideoImportResult{return Object.freeze({status,reason,automaticRetry:false,taskCompleted:false,cleanupRequested:false,staging:"port-managed"});}
function freeze<T>(value:T):T{if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const validStage=(stage:VideoImportStage)=>equal(stage.fingerprint,stage.binding.intent.expectedFingerprint)&&equal(stage.fingerprint,stage.decoder.fingerprint);
export class VideoImportCoordinator {
 #active=new Set<string>();
 constructor(private readonly ports:VideoImportPorts){}
 async run(raw:unknown):Promise<VideoImportResult>{
  if(raw===null)return result("cancelled","CANCELLED_BEFORE_RESERVATION");
  let intent:VideoImportIntent;try{intent=freeze(intentSchema.parse(raw));}catch{return result("invalid-request","INVALID_CONFIRMED_INTENT");}
  if(this.#active.has(intent.requestId))return result("in-flight","REQUEST_IN_FLIGHT");
  this.#active.add(intent.requestId);
  try{
   const reserved=z.object({status:z.enum(["reserved","existing"]),binding:bindingSchema}).strict().parse(await this.ports.reserve(intent));
   const binding=freeze(reserved.binding);
   if(reserved.status!=="reserved"||!equal(binding.intent,intent))return result("reconcile-required","RESERVATION_NOT_NEW_OR_MISMATCHED");
   let stage:VideoImportStage;try{stage=freeze(stageSchema.parse(await this.ports.stage(binding)));}catch{return result("reconcile-required","STAGING_OUTCOME_UNCONFIRMED");}
   if(!equal(stage.binding,binding)||!validStage(stage))return result("invalid-stage","DECODER_OR_STAGED_BYTES_MISMATCH");
   if(await this.ports.recheck(stage)!==true)return result("reconcile-required","INTENT_NO_LONGER_CURRENT");
   const publication=z.object({status:z.enum(["published","not-published","uncertain"]),artifact:artifactSchema.nullable()}).strict().parse(await this.ports.publish(stage));
   if(publication.status!=="published"||!publication.artifact||!equal(publication.artifact.stage,stage))return result("reconcile-required","PUBLICATION_NOT_CONFIRMED");
   const artifact=freeze(publication.artifact);
   if(artifact.cleanup!=="complete")return result("reconcile-required","PUBLICATION_CLEANUP_UNRESOLVED");
   const receipt=z.object({status:z.literal("committed"),artifact:artifactSchema}).strict().parse(await this.ports.commit(artifact));
   if(!equal(receipt.artifact,artifact))return result("reconcile-required","COMMIT_RECEIPT_MISMATCH");
   return result("recorded","MATCHING_METADATA_RECEIPT");
  }catch{return result("reconcile-required","OPERATION_OUTCOME_UNCONFIRMED");}
  finally{this.#active.delete(intent.requestId);}
 }
 async reconcile(raw:unknown):Promise<VideoImportResult>{
  let intent:VideoImportIntent;try{intent=freeze(intentSchema.parse(raw));}catch{return result("invalid-request","INVALID_CONFIRMED_INTENT");}
  if(this.#active.has(intent.requestId))return result("in-flight","REQUEST_IN_FLIGHT");
  try{const receipt=z.object({status:z.literal("committed"),artifact:artifactSchema}).strict().parse(await this.ports.reconcile(intent));
   if(!equal(receipt.artifact.stage.binding.intent,intent)||receipt.artifact.cleanup!=="complete"||!validStage(receipt.artifact.stage))return result("reconcile-required","RECONCILIATION_NOT_CONFIRMED");
   return result("recorded","MATCHING_READ_ONLY_RECEIPT");
  }catch{return result("reconcile-required","RECONCILIATION_NOT_CONFIRMED");}
 }
}
