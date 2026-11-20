import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createApplicationServices } from "../src/main/application/services";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { createPlanPreview, PlanCreateReview } from "../src/shared/plan-create-preview";
import type { CommandOutputs } from "../src/shared/bridge";

const input = { title: "合成周计划", style: "comic" as const, startDate: "2026-12-29", dailyCount: 100, executionTime: "23:40", styleNotes: "合成说明" };
const phase = (review: PlanCreateReview) => review.phase;

test("local week preview uses shared validation, exact cross-year dates and 700-task limit", () => {
 const preview = createPlanPreview(input);
 assert.deepEqual(preview.dates, ["2026-12-29","2026-12-30","2026-12-31","2027-01-01","2027-01-02","2027-01-03","2027-01-04"]);
 assert.equal(preview.total,700);
 assert.deepEqual(preview.input,input);
 assert.ok(Object.isFrozen(preview)&&Object.isFrozen(preview.input)&&Object.isFrozen(preview.dates));
 assert.throws(()=>createPlanPreview({...input,dailyCount:101}));
 assert.throws(()=>createPlanPreview({...input,startDate:"9999-12-30"}));
});

test("confirm only; lost acknowledgement reuses exact transactional request and refresh never creates", async () => {
 const database = new ApplicationDatabase(":memory:");
 try {
  const {router,repository}=createApplicationServices({database,logger:{command(){}},sessions:{async open(){assert.fail("offline only");}},version:"test",dataDirectory:"synthetic"});
  let ids=0, refreshes=0;
  const requests:string[]=[];
  let saved:CommandOutputs["plans.create"]|undefined;
  const review=new PlanCreateReview(()=>{ids++;return randomUUID();},()=>{});
  const write: Parameters<PlanCreateReview["confirm"]>[2]=async (value,id)=>{
   requests.push(id);
   const reply=await router.dispatch({command:"plans.create",input:value,requestId:id},{trusted:true});
   assert.ok(reply.ok);
   saved=reply.data as CommandOutputs["plans.create"];
   if(requests.length===1)throw Error("lost acknowledgement");
   return {planId:saved.plan.id};
  };
  const refresh=async (id:string|null)=>{assert.equal(id,saved?.plan.id);if(++refreshes===1)throw Error("refresh failure");};
  review.inspect(input);const first=review.preview!;
  review.discardPreview();
  await review.confirm(first,input,write,refresh);
  review.inspect(input);
  await review.confirm(review.preview!,{...input,title:"changed"},write,refresh);
  assert.equal(ids,0);assert.equal(requests.length,0);assert.equal(repository.snapshot().plans.length,0);
  review.inspect(input);const preview=review.preview!;
  const pending=review.confirm(preview,input,write,refresh);
  assert.equal(review.canClose,false);
  await review.confirm(preview,input,write,refresh);
  await pending;
  assert.equal(phase(review),"uncertain");assert.equal(review.canClose,false);
  await review.retry(write,refresh);
  assert.equal(phase(review),"saved");
  await review.retry(write,refresh);
  await review.refresh(refresh);
  assert.equal(phase(review),"complete");
  assert.equal(ids,1);assert.equal(requests.length,2);assert.equal(requests[0],requests[1]);
  assert.equal(repository.snapshot().plans.length,1);assert.equal(repository.snapshot().executions.length,0);
  assert.equal(saved?.tasks.length,700);
  assert.deepEqual([...new Set(saved?.tasks.map(task=>task.businessDate))],preview.dates);
  assert.ok(saved?.tasks.every(task=>task.executionTime===input.executionTime&&!task.workspace.script));
  assert.equal(database.connection.prepare("SELECT count(*) AS n FROM command_receipts").get()?.n,1);
 } finally { database.close(); }
});

test("second unknown reply cannot retry or close without a successful read-only refresh",async()=>{
 let writes=0;
 const review=new PlanCreateReview(randomUUID,()=>{});
 const write=async()=>{writes++;throw Error("missing acknowledgement");};
 const refresh=async()=>{};
 review.inspect(input);
 await review.confirm(review.preview!,input,write,refresh);
 await review.retry(write,refresh);await review.retry(write,refresh);
 review.discardPreview();review.inspect(input);
 assert.equal(writes,2);assert.equal(review.canClose,false);assert.equal(phase(review),"check-only");
 await review.refresh(async()=>{throw Error("refresh failure");});
 assert.equal(review.canClose,false);
 await review.refresh(refresh);
 assert.equal(phase(review),"checked");assert.equal(review.canClose,true);
});
