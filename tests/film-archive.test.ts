import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement,type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createApplicationServices } from "../src/main/application/services";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { filmArchiveGroups } from "../src/shared/film-archive";
import type { WorkspaceSnapshot,Film } from "../src/shared/models";
async function page(){const path="../src/renderer/src/pages/FilmsPage.tsx";return (await import(path)).FilmsPage as ComponentType<{snapshot:Pick<WorkspaceSnapshot,"films"|"tasks">}>;}
test("real film metadata survives close/reopen without projecting stored paths; SSR defaults latest with collapsed history",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"film-list-")),path=join(dir,"workspace.sqlite");let db=new ApplicationDatabase(path);
 try{let repo=new WorkspaceRepository(db);const task=db.transaction(()=>repo.createPlan({title:"合成影片任务",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
 const execution=randomUUID();db.connection.prepare("INSERT INTO executions(id,task_id,operation,status,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)").run(execution,task.id,"video","completed","{}","2026-11-19T00:00:00Z","2026-11-19T00:00:00Z");
 for(const [version,at] of [[1,"2026-11-19T01:00:00.000Z"],[3,"2026-11-19T02:00:00.000Z"],[0,"SECRET_BAD_TIME"]] as const)db.connection.prepare("INSERT INTO films(id,execution_id,task_id,file_path,version,created_at) VALUES(?,?,?,?,?,?)").run(randomUUID(),execution,task.id,"/PRIVATE_DO_NOT_PROJECT/video.mp4",version,at);
 const before=db.connection.prepare("SELECT * FROM films ORDER BY id").all();db.close();db=new ApplicationDatabase(path);repo=new WorkspaceRepository(db);let sessionCalls=0;
 const {router}=createApplicationServices({database:db,logger:{command(){}},version:"test",dataDirectory:dir,sessions:{async open(){sessionCalls++;}}});
 const result=await router.dispatch({command:"workspace.read",input:{},requestId:randomUUID()},{trusted:true});assert.ok(result.ok);const snapshot=result.data as WorkspaceSnapshot;
 assert.equal(sessionCalls,0);assert.equal(db.connection.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n,0);assert.equal(snapshot.films.length,3);assert.doesNotMatch(JSON.stringify(snapshot.films),/PRIVATE_DO_NOT_PROJECT|filePath|SECRET_BAD_TIME/);
 assert.deepEqual(db.connection.prepare("SELECT * FROM films ORDER BY id").all(),before);const group=filmArchiveGroups(snapshot.films,snapshot.tasks)[0]!;assert.equal(group.latest?.version,3);assert.equal(group.latest?.createdAt,"2026-11-19T02:00:00.000Z");assert.deepEqual(group.otherVersions.map(f=>f.version),[1,null]);
 const html=renderToStaticMarkup(createElement(await page(),{snapshot}));assert.match(html,/合成影片任务/);assert.match(html,/版本 3/);assert.match(html,/<details><summary>查看其他版本及异常记录（2）/);assert.doesNotMatch(html,/<details open|<button|<video|<a\s|PRIVATE_DO_NOT_PROJECT/);assert.match(html,/未验证/);
 }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test("deterministic duplicate ties, missing tasks, invalid-only groups and empty SSR never hide records or claim playable media",async()=>{
 const films:Film[]=[{id:"b",taskId:"missing",version:2,createdAt:"2026-11-19T00:00:00Z"},{id:"a",taskId:"missing",version:2,createdAt:"2026-11-19T00:00:00Z"},{id:"bad",taskId:"invalid",version:null,createdAt:null}],before=structuredClone(films);
 const groups=filmArchiveGroups(films,[]);assert.deepEqual(groups,filmArchiveGroups([...films].reverse(),[]));assert.equal(groups[1]!.latest?.id,"a");assert.equal(groups[1]!.duplicateLatest,true);assert.equal(groups[0]!.latest,null);assert.equal(groups[0]!.otherVersions.length,1);assert.deepEqual(films,before);
 const dated=filmArchiveGroups([{...films[0]!,id:"missing-time",createdAt:null},{...films[0]!,id:"valid-old-time",createdAt:"1960-01-01T00:00:00.000Z"},{...films[0]!,id:"valid-new-time",createdAt:"2026-01-01T00:00:00.000Z"}],[])[0]!;assert.equal(dated.latest?.id,"valid-new-time");assert.deepEqual(dated.otherVersions.map(f=>f.id),["valid-old-time","missing-time"]);
 const Page=await page();const html=renderToStaticMarkup(createElement(Page,{snapshot:{films,tasks:[]}}));assert.match(html,/原任务不可用/);assert.match(html,/最高版本存在重复/);assert.match(html,/没有有效版本号/);assert.doesNotMatch(html,/<button|<video|<a\s/);
 assert.match(renderToStaticMarkup(createElement(Page,{snapshot:{films:[],tasks:[]}})),/暂无本地成片记录/);
});
