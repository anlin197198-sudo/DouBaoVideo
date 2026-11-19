import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { preflightFilmVersion } from "../src/main/infrastructure/film-version-preflight";
function fixture(){const root=mkdtempSync(join(tmpdir(),"film-preflight-")),path=join(root,"workspace.sqlite"),db=new ApplicationDatabase(path);
 const tasks=db.transaction(()=>new WorkspaceRepository(db).createPlan({title:"合成任务",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks;
 const execution=randomUUID();db.connection.prepare("INSERT INTO executions(id,task_id,operation,status,input_json,created_at,updated_at) VALUES(?,?,'video','completed','{}','synthetic','synthetic')").run(execution,tasks[0]!.id);
 const task=tasks[0]!,input={taskId:task.id,expectedRevision:task.revision};
 const add=(version:number|string,taskId=task.id)=>db.connection.prepare("INSERT INTO films VALUES(?,?,?,'NOT_EXPOSED_PATH',?,'synthetic')").run(randomUUID(),execution,taskId,version);
 return {root,path,db,tasks,input,add,close(){db.close();rmSync(root,{recursive:true,force:true});}};}
test("V7 authoritative version observation uses a read-only connection without mutating any table",()=>{
 const f=fixture();try{assert.equal(f.db.version,7);assert.equal(preflightFilmVersion(f.db.connection,f.input).proposedVersion,1);f.add(1);f.add(4);assert.throws(()=>f.add(4),/UNIQUE/);
 const tables=f.db.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(r=>String(r.name));
 const dump=()=>JSON.stringify(tables.map(name=>[name,f.db.connection.prepare(`SELECT * FROM \"${name}\" ORDER BY rowid`).all()]));const before=dump();
 const readonly=new DatabaseSync(f.path,{readOnly:true});try{const result=preflightFilmVersion(readonly,f.input);assert.equal(result.proposedVersion,5);assert.equal(result.reserved,false);assert.equal(result.writeAuthorized,false);assert.equal(result.mediaVerified,false);assert.ok(Object.isFrozen(result));assert.doesNotMatch(JSON.stringify(result),/NOT_EXPOSED/);assert.deepEqual(preflightFilmVersion(readonly,f.input),result);}finally{readonly.close();}assert.equal(dump(),before);
 f.db.connection.prepare("UPDATE tasks SET revision=revision+1 WHERE id=?").run(f.input.taskId);assert.throws(()=>preflightFilmVersion(f.db.connection,f.input),/修订已变化/);
 }finally{f.close();}
});
test("missing/stale/invalid and anomalous version or ownership rows fail closed",()=>{
 for(const version of [0,-1,1.5,"invalid",Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1]){const f=fixture();try{f.add(version);assert.throws(()=>preflightFilmVersion(f.db.connection,f.input));}finally{f.close();}}
 const f=fixture();try{assert.throws(()=>preflightFilmVersion(f.db.connection,{get taskId(){throw Error("PRIVATE_GETTER_PAYLOAD");}}),error=>error instanceof Error && error.message==="成片版本预检查参数无效。");assert.throws(()=>preflightFilmVersion(f.db.connection,{...f.input,taskId:randomUUID()}),/不存在/);assert.throws(()=>preflightFilmVersion(f.db.connection,{...f.input,path:"unrequested"}),/参数/);
 f.add(1,f.tasks[1]!.id);assert.throws(()=>preflightFilmVersion(f.db.connection,{taskId:f.tasks[1]!.id,expectedRevision:f.tasks[1]!.revision}),/归属/);
 f.db.connection.prepare("INSERT INTO films VALUES(NULL,?,?,'synthetic',1,'synthetic')").run(f.db.connection.prepare("SELECT id FROM executions LIMIT 1").get()!.id!,f.input.taskId);assert.throws(()=>preflightFilmVersion(f.db.connection,f.input),/记录异常/);
 f.db.connection.prepare("UPDATE tasks SET revision=-1 WHERE id=?").run(f.input.taskId);assert.throws(()=>preflightFilmVersion(f.db.connection,{...f.input,expectedRevision:0}),/修订记录异常/);
 }finally{f.close();}
});
