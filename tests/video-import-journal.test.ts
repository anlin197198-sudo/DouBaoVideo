import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeImportJournal,VideoImportJournal,type ImportJournalRequest } from "../src/main/infrastructure/video-import-journal";
const request=():ImportJournalRequest=>({intent:{requestId:randomUUID(),taskId:randomUUID(),intentToken:randomUUID(),expectedFingerprint:{sha256:"a".repeat(64),bytes:100}},expectedTaskRevision:3,expectedVersion:1});
test("explicit standalone provisioning refuses existing databases and validates host revision/version before reserving",()=>{
 const db=new DatabaseSync(":memory:");try{assert.throws(()=>new VideoImportJournal(db));db.exec("CREATE TABLE existing(value TEXT)");assert.throws(()=>initializeImportJournal(db));assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(r=>r.name),["existing"]);}finally{db.close();}
 const fresh=new DatabaseSync(":memory:");try{initializeImportJournal(fresh);assert.throws(()=>initializeImportJournal(fresh));const journal=new VideoImportJournal(fresh),r=request();journal.provisionTask({taskId:r.intent.taskId,revision:3,nextVersion:1});
 for(const bad of [{...r,expectedTaskRevision:2},{...r,expectedVersion:2},{...r,path:"secret"}])assert.throws(()=>journal.reserve(bad));assert.equal(journal.read(r.intent.requestId),null);
 const reserved=journal.reserve(r);assert.equal(reserved.created,true);assert.ok(Object.isFrozen(reserved));assert.equal(journal.reserve({...r,intent:{...r.intent,requestId:r.intent.requestId.toUpperCase(),taskId:r.intent.taskId.toUpperCase(),intentToken:r.intent.intentToken.toUpperCase()}}).created,false);assert.ok(Object.isFrozen(reserved.record.request.intent));assert.throws(()=>journal.updateTask({taskId:r.intent.taskId,expectedRevision:3,expectedVersion:1,revision:4,nextVersion:1}));
 }finally{fresh.close();}
});
test("two connections dedupe same request, reject rebind and competing task reservation; possible publication survives reopen without replay",()=>{
 const dir=mkdtempSync(join(tmpdir(),"import-journal-")),path=join(dir,"journal.sqlite");let a=new DatabaseSync(path),b:DatabaseSync|null=null;
 try{initializeImportJournal(a);b=new DatabaseSync(path);const first=new VideoImportJournal(a),second=new VideoImportJournal(b),r=request();first.provisionTask({taskId:r.intent.taskId,revision:3,nextVersion:1});const reservation=first.reserve(r);assert.deepEqual(second.reserve(r),{created:false,record:reservation.record});
 assert.throws(()=>second.reserve({...r,intent:{...r.intent,intentToken:randomUUID()}}));assert.throws(()=>second.reserve({...r,intent:{...r.intent,requestId:randomUUID()}}));
 assert.throws(()=>second.markPublicationPossible({...reservation.record.key,fenceToken:randomUUID()}));assert.equal(first.markPublicationPossible(reservation.record.key).transitioned,true);assert.equal(second.markPublicationPossible(reservation.record.key).transitioned,false);a.close();a=new DatabaseSync(path);const reopened=new VideoImportJournal(a);const readonly=new DatabaseSync(path,{readOnly:true});try{const view=new VideoImportJournal(readonly);assert.equal(view.read(r.intent.requestId)!.state,"publication-possible");}finally{readonly.close();}const record=reopened.read(r.intent.requestId)!;assert.equal(record.state,"publication-possible");assert.equal(record.automaticRetry,false);assert.equal(reopened.reserve(r).created,false);assert.throws(()=>second.reserve({...r,intent:{...r.intent,requestId:randomUUID()}}));
 }finally{a.close();b?.close();rmSync(dir,{recursive:true,force:true});}
});
test("strict comparecommit preserves immutable receipt across lost response/reopen and advances only explicit host version",()=>{
 const dir=mkdtempSync(join(tmpdir(),"import-receipt-")),path=join(dir,"journal.sqlite");let db=new DatabaseSync(path);try{
 initializeImportJournal(db);let j=new VideoImportJournal(db);const r=request();j.provisionTask({taskId:r.intent.taskId,revision:3,nextVersion:1});const key=j.reserve(r).record.key,receipt={...key,artifactId:randomUUID(),version:1,fingerprint:r.intent.expectedFingerprint};
 assert.throws(()=>j.commit(receipt));j.markPublicationPossible(key);assert.throws(()=>j.commit({...receipt,fingerprint:{...receipt.fingerprint,bytes:99}}));assert.equal(j.read(key.requestId)!.state,"publication-possible");
 const committed=j.commit(receipt);db.close();db=new DatabaseSync(path);j=new VideoImportJournal(db);assert.deepEqual(j.read(key.requestId),committed);assert.deepEqual(j.commit(receipt),committed);assert.throws(()=>j.commit({...receipt,artifactId:randomUUID()}));assert.throws(()=>db.prepare("DELETE FROM import_journal WHERE request_id=?").run(key.requestId));
 assert.throws(()=>j.reserve({...r,intent:{...r.intent,requestId:randomUUID()}}));assert.equal(j.reserve({...r,intent:{...r.intent,requestId:randomUUID()},expectedVersion:2}).created,true);db.exec("CREATE TABLE unexpected(value TEXT)");assert.throws(()=>new VideoImportJournal(db));
 assert.doesNotMatch(JSON.stringify(committed),/file_path|executionId|remoteReference/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test("initialization rejects leftover SQLite metadata and marked empty databases without modifying them",()=>{
 for(const setup of ["PRAGMA user_version=7","PRAGMA application_id=123","CREATE TABLE old(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE old;"]){const db=new DatabaseSync(":memory:");try{db.exec(setup);const before=db.prepare("SELECT * FROM sqlite_schema").all();assert.throws(()=>initializeImportJournal(db));assert.deepEqual(db.prepare("SELECT * FROM sqlite_schema").all(),before);}finally{db.close();}}
});
