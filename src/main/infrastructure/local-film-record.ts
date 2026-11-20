import { createHash } from "node:crypto";
import { isAbsolute,join,parse,resolve } from "node:path";
import { z } from "zod";
import type { ApplicationDatabase } from "./database";
import { preflightFilmVersion } from "./film-version-preflight";
import { buildVideoBasename,MAX_VIDEO_TITLE_UNITS } from "../../shared/video-basename";
import { localExecutionTimestamp } from "../../shared/execution-recovery";
import { MAX_VIDEO_WRITE_BYTES } from "./video-byte-writer";
const uuid=z.string().uuid().regex(/^[0-9a-f-]+$/);
const schema=z.object({requestId:uuid,filmId:uuid,taskId:uuid,executionId:uuid,
 expectedRevision:z.number().int().nonnegative().safe(),version:z.number().int().positive().safe(),title:z.string().max(MAX_VIDEO_TITLE_UNITS),
 directory:z.string().refine(v=>isAbsolute(v)&&resolve(v)===v&&parse(v).root!==v),
 owner:z.object({ownerId:z.number().int().nonnegative().safe(),documentId:uuid}).strict(),
 fingerprint:z.object({bytes:z.number().int().positive().max(MAX_VIDEO_WRITE_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),}).strict();
export type LocalFilmBinding=z.infer<typeof schema>;
/** Canonical data only, never authorization. */
export function parseLocalFilmBinding(raw:unknown):Readonly<LocalFilmBinding>{const value=schema.parse(raw);Object.freeze(value.owner);Object.freeze(value.fingerprint);return Object.freeze(value); }
export type LocalFilmAuthority=Readonly<{target:string;requestHash:string}>;
const command="f17.local-import.record",failure=()=>new Error("本地成片记录条件不匹配，需核对。");
function validated(raw:LocalFilmBinding,authority:LocalFilmAuthority){
 const binding=schema.parse(raw);
 const expected=join(binding.directory,buildVideoBasename({taskId:binding.taskId,executionId:binding.executionId,version:binding.version,title:binding.title}));
 const requestHash=createHash("sha256").update(JSON.stringify(binding)).digest("hex");
 if(authority.target!==expected||authority.requestHash!==requestHash)throw failure();
 return {binding,target:expected,requestHash};
}
function metadata(b:LocalFilmBinding){return {requestId:b.requestId,filmId:b.filmId,taskId:b.taskId,executionId:b.executionId,version:b.version,expectedRevision:b.expectedRevision,fingerprint:Object.freeze({...b.fingerprint}),metadataOnly:true as const};}
function inputJson(b:LocalFilmBinding){return JSON.stringify({origin:"local-import",requestId:b.requestId,expectedRevision:b.expectedRevision,fingerprint:b.fingerprint});}
function prior(database:ApplicationDatabase,b:LocalFilmBinding,target:string,hash:string){
 const db=database.connection,row=db.prepare("SELECT * FROM command_receipts WHERE request_id=?").get(b.requestId);if(!row)return null;
 const sealed=JSON.stringify(metadata(b));
 if(row.command!==command||row.input_hash!==hash||row.result_json!==sealed||localExecutionTimestamp(row.created_at)===null)throw failure();
 if(!db.prepare("SELECT 1 FROM tasks WHERE id=?").get(b.taskId))throw failure();
 const film=db.prepare("SELECT * FROM films WHERE id=?").get(b.filmId),execution=db.prepare("SELECT * FROM executions WHERE id=?").get(b.executionId);
 if(!film||!execution||film.execution_id!==b.executionId||film.task_id!==b.taskId||film.file_path!==target||film.version!==b.version
  ||execution.task_id!==b.taskId||execution.operation!=="local-import"||execution.status!=="recorded"||execution.account_id!==null||execution.remote_reference!==null
  ||execution.input_json!==inputJson(b)||film.created_at!==row.created_at||execution.created_at!==row.created_at||execution.updated_at!==row.created_at)throw failure();
 return Object.freeze({status:"prior-recorded" as const,...metadata(b)});
}
/** Internal recorder-only SQL step, NEVER an IPC route or proof-shaped authorization API.
 * Caller must already verify its closed-over physical capability. finalGuard is synchronous
 * trusted live/physical identity checking, not renderer input. No filesystem verification here. */
export function commitLocalFilmRecord(database:ApplicationDatabase,raw:LocalFilmBinding,authority:LocalFilmAuthority,finalGuard:()=>boolean){
 try{const {binding:b,target,requestHash}=validated(raw,authority);
 const guard=()=>{const answer:unknown=finalGuard();if(answer instanceof Promise)void answer.catch(()=>undefined);if(answer!==true)throw failure();};
 return database.transaction(()=>{
  guard();if(database.version!==7)throw failure();
  const replay=prior(database,b,target,requestHash);if(replay){guard();return replay;}
  const version=preflightFilmVersion(database.connection,{taskId:b.taskId,expectedRevision:b.expectedRevision});if(version.proposedVersion!==b.version)throw failure();
  const db=database.connection;
  if(db.prepare("SELECT 1 FROM films WHERE id=?").get(b.filmId)||db.prepare("SELECT 1 FROM executions WHERE id=?").get(b.executionId))throw failure();
  const now=new Date().toISOString();
  db.prepare("INSERT INTO executions(id,task_id,account_id,operation,status,input_json,remote_reference,created_at,updated_at) VALUES(?,?,NULL,'local-import','recorded',?,NULL,?,?)").run(b.executionId,b.taskId,inputJson(b),now,now);
  db.prepare("INSERT INTO films(id,execution_id,task_id,file_path,version,created_at) VALUES(?,?,?,?,?,?)").run(b.filmId,b.executionId,b.taskId,target,b.version,now);
  db.prepare("INSERT INTO command_receipts(request_id,command,input_hash,result_json,created_at) VALUES(?,?,?,?,?)").run(b.requestId,command,requestHash,JSON.stringify(metadata(b)),now);
  guard();return Object.freeze({status:"recorded" as const,...metadata(b)});
 });}catch{throw failure();}
}
/** Read-only durable metadata inspection. Does not prove file availability, decode or fresh authority. */
export function readLocalFilmRecord(database:ApplicationDatabase,raw:LocalFilmBinding,authority:LocalFilmAuthority){
 try{const {binding,target,requestHash}=validated(raw,authority);if(database.version!==7)throw failure();return prior(database,binding,target,requestHash);}catch{throw failure();}
}
