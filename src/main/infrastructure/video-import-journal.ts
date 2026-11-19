import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
const positive=z.number().int().positive().max(Number.MAX_SAFE_INTEGER-1),revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fingerprint=z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/),bytes:z.number().int().positive().max(8*1024**3)}).strict();
const intent=z.object({requestId:uuid,taskId:uuid,intentToken:uuid,expectedFingerprint:fingerprint}).strict();
const requestSchema=z.object({intent,expectedTaskRevision:revision,expectedVersion:positive}).strict();
export type ImportJournalRequest=z.infer<typeof requestSchema>;
const keySchema=z.object({requestId:uuid,reservationId:uuid,fenceToken:uuid}).strict();
export type ImportJournalKey=z.infer<typeof keySchema>;
const receiptSchema=keySchema.extend({artifactId:uuid,version:positive,fingerprint}).strict();
export type ImportJournalReceipt=z.infer<typeof receiptSchema>;
const DDL=`CREATE TABLE journal_identity (id INTEGER PRIMARY KEY CHECK(id=1), format TEXT NOT NULL CHECK(format='DouBaoVideo-offline-import-journal-v1'));
INSERT INTO journal_identity VALUES(1,'DouBaoVideo-offline-import-journal-v1');
CREATE TABLE journal_tasks(task_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>=0), next_version INTEGER NOT NULL CHECK(next_version>0));
CREATE TABLE import_journal(request_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES journal_tasks(task_id), request_json TEXT NOT NULL,
 reservation_id TEXT NOT NULL UNIQUE, fence_token TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK(state IN ('reserved','publication-possible','confirmed')),receipt_json TEXT);
CREATE UNIQUE INDEX one_outstanding_import ON import_journal(task_id) WHERE state!='confirmed';
CREATE TRIGGER confirmed_no_update BEFORE UPDATE ON import_journal WHEN OLD.state='confirmed' BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
CREATE TRIGGER journal_no_delete BEFORE DELETE ON import_journal BEGIN SELECT RAISE(ABORT,'retained import journal'); END;`;
function schemaSignature(db:DatabaseSync){return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all());}
function trustedSignature(){const reference=new DatabaseSync(":memory:");try{reference.exec(DDL);return schemaSignature(reference);}finally{reference.close();}}
const fail=()=>new Error("导入日志条件不匹配，需人工核对。");
function parsed<T>(schema:z.ZodType<T>,raw:unknown):T{try{return schema.parse(raw);}catch{throw fail();}}
function freeze<T>(v:T):T{if(v&&typeof v==="object"){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
/** EXPLICIT host provisioning of a NEW standalone empty database only. Never a workspace migration. */
export function initializeImportJournal(db:DatabaseSync):void {
 db.exec("BEGIN IMMEDIATE");try{if(db.prepare("SELECT name FROM sqlite_schema").all().length||db.prepare("PRAGMA user_version").get()?.user_version!==0||db.prepare("PRAGMA application_id").get()?.application_id!==0)throw fail();db.exec(DDL);db.exec("COMMIT");}catch{db.exec("ROLLBACK");throw fail();}
}
/** Prototype local journal only. Host task revision/version is explicit supplied state, NOT an
 * observation of the production workspace. It fences cooperating journal writers, not filesystem
 * side effects. A committed publication-possible row must precede any publish attempt. No retry,
 * cancellation, lease stealing, cleanup, execution borrowing or task-completion operations exist. */
export class VideoImportJournal {
 constructor(private readonly db:DatabaseSync){try{if(schemaSignature(db)!==trustedSignature())throw fail();if(db.prepare("SELECT format FROM journal_identity WHERE id=1").get()?.format!=="DouBaoVideo-offline-import-journal-v1")throw fail();}catch{throw fail();}}
 private transaction<T>(fn:()=>T):T{this.db.exec("BEGIN IMMEDIATE");try{const value=fn();this.db.exec("COMMIT");return value;}catch{this.db.exec("ROLLBACK");throw fail();}}
 provisionTask(raw:unknown):void {const input=parsed(z.object({taskId:uuid,revision,nextVersion:positive}).strict(),raw);this.transaction(()=>{this.db.prepare("INSERT INTO journal_tasks VALUES(?,?,?)").run(input.taskId,input.revision,input.nextVersion);});}
 /** Host-only compare update, and only while no uncertain/reserved publication is outstanding. */
 updateTask(raw:unknown):void{const x=parsed(z.object({taskId:uuid,expectedRevision:revision,expectedVersion:positive,revision,nextVersion:positive}).strict(),raw);this.transaction(()=>{
 if(this.db.prepare("SELECT 1 FROM import_journal WHERE task_id=? AND state!='confirmed'").get(x.taskId))throw fail();
 if(x.revision<x.expectedRevision||x.nextVersion<x.expectedVersion)throw fail();
 if(this.db.prepare("UPDATE journal_tasks SET revision=?,next_version=? WHERE task_id=? AND revision=? AND next_version=?").run(x.revision,x.nextVersion,x.taskId,x.expectedRevision,x.expectedVersion).changes!==1)throw fail();});}
 reserve(raw:unknown){const input=parsed(requestSchema,raw),canonical=JSON.stringify(input);return this.transaction(()=>{
 const existing=this.db.prepare("SELECT request_json FROM import_journal WHERE request_id=?").get(input.intent.requestId);
 if(existing){if(existing.request_json!==canonical)throw fail();return freeze({created:false,record:this.read(input.intent.requestId)!});}
 const task=this.db.prepare("SELECT revision,next_version FROM journal_tasks WHERE task_id=?").get(input.intent.taskId);
 if(!task||task.revision!==input.expectedTaskRevision||task.next_version!==input.expectedVersion)throw fail();
 this.db.prepare("INSERT INTO import_journal VALUES(?,?,?,?,?,'reserved',NULL)").run(input.intent.requestId,input.intent.taskId,canonical,randomUUID(),randomUUID());
 return freeze({created:true,record:this.read(input.intent.requestId)!});});}
 /** transitioned:false is inspection/reconcile only, NEVER permission to publish again. */
 markPublicationPossible(raw:unknown){const key=parsed(keySchema,raw);return this.transaction(()=>{const row=this.match(key);if(row.state!=="reserved"&&row.state!=="publication-possible")throw fail();
 if(row.state==="reserved")this.db.prepare("UPDATE import_journal SET state='publication-possible' WHERE request_id=?").run(key.requestId);return freeze({transitioned:row.state==="reserved",record:this.read(key.requestId)!});});}
 commit(raw:unknown){const receipt=parsed(receiptSchema,raw);return this.transaction(()=>{
 const row=this.match(receipt),request=parsed(requestSchema,JSON.parse(String(row.request_json))),canonical=JSON.stringify(receipt);
 if(row.state==="confirmed"){if(row.receipt_json!==canonical)throw fail();return this.read(receipt.requestId)!;}
 if(row.state!=="publication-possible"||receipt.version!==request.expectedVersion||JSON.stringify(receipt.fingerprint)!==JSON.stringify(request.intent.expectedFingerprint))throw fail();
 if(this.db.prepare("UPDATE journal_tasks SET next_version=next_version+1 WHERE task_id=? AND revision=? AND next_version=?").run(request.intent.taskId,request.expectedTaskRevision,request.expectedVersion).changes!==1)throw fail();
 this.db.prepare("UPDATE import_journal SET state='confirmed',receipt_json=? WHERE request_id=?").run(canonical,receipt.requestId);return this.read(receipt.requestId)!;});}
 private match(key:ImportJournalKey){const row=this.db.prepare("SELECT * FROM import_journal WHERE request_id=? AND reservation_id=? AND fence_token=?").get(key.requestId,key.reservationId,key.fenceToken);if(!row)throw fail();return row;}
 read(raw:unknown){const id=parsed(uuid,raw),row=this.db.prepare("SELECT * FROM import_journal WHERE request_id=?").get(id);if(!row)return null;
 return freeze({request:parsed(requestSchema,JSON.parse(String(row.request_json))),key:{requestId:id,reservationId:String(row.reservation_id),fenceToken:String(row.fence_token)},state:row.state as "reserved"|"publication-possible"|"confirmed",receipt:row.receipt_json?parsed(receiptSchema,JSON.parse(String(row.receipt_json))):null,automaticRetry:false as const});}
}
