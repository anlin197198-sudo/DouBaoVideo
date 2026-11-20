import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID,createHash } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { buildVideoBasename } from "../src/shared/video-basename";
import { commitLocalFilmRecord,readLocalFilmRecord,type LocalFilmBinding } from "../src/main/infrastructure/local-film-record";
test("internal SQL transaction rolls back final guard and reopens exact immutable metadata without task changes",()=>{
 const root=mkdtempSync(join(tmpdir(),"film-sql-")),path=join(root,"workspace.sqlite");let db=new ApplicationDatabase(path);
 try{const repo=new WorkspaceRepository(db),task=db.transaction(()=>repo.createPlan({title:"synthetic",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 const before=db.connection.prepare("SELECT * FROM tasks ORDER BY id").all();
 const b:LocalFilmBinding={requestId:randomUUID(),filmId:randomUUID(),taskId:task.id,executionId:randomUUID(),expectedRevision:task.revision,version:1,title:"synthetic",directory:root,owner:{ownerId:1,documentId:randomUUID()},fingerprint:{bytes:8,sha256:"a".repeat(64)}};
 const authority={target:join(root,buildVideoBasename({taskId:b.taskId,executionId:b.executionId,version:b.version,title:b.title})),requestHash:createHash("sha256").update(JSON.stringify(b)).digest("hex")};
 let calls=0;assert.throws(()=>commitLocalFilmRecord(db,b,authority,()=>++calls<2));for(const table of ["films","executions","command_receipts"])assert.equal(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,0);
 const recorded=commitLocalFilmRecord(db,b,authority,()=>true);assert.equal(recorded.status,"recorded");assert.ok(Object.isFrozen(recorded.fingerprint));assert.deepEqual(db.connection.prepare("SELECT * FROM tasks ORDER BY id").all(),before);
 const receipt=db.connection.prepare("SELECT result_json FROM command_receipts").get()!.result_json as string;assert.ok(!receipt.includes(root));assert.equal(JSON.parse(receipt).expectedRevision,b.expectedRevision);
 db.close();db=new ApplicationDatabase(path);assert.equal(readLocalFilmRecord(db,b,authority)!.status,"prior-recorded");assert.equal(commitLocalFilmRecord(db,b,authority,()=>true).status,"prior-recorded");assert.equal(db.connection.prepare("SELECT count(*) AS n FROM executions").get()!.n,1);
 db.connection.prepare("UPDATE executions SET remote_reference='unexpected' WHERE id=?").run(b.executionId);assert.throws(()=>readLocalFilmRecord(db,b,authority));
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
