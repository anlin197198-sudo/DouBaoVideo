import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, lstat, readFile, readdir, rm, link, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { createMp4Stage } from "../src/main/infrastructure/mp4-stage";
import { archiveStagedVideo } from "../src/main/application/archive-staged-video";
import { SYNTHETIC_MP4_BASE64 } from "./fixtures/f17-native-smoke-mp4";
async function fixture(t:{after:(f:()=>Promise<void>)=>unknown}) {
 const root=await mkdtemp(join(tmpdir(),"dv-staged-archive-"));
 const stage=join(root,"stage"),archive=join(root,"archive"),source=join(root,"source.mp4");await mkdir(stage);await mkdir(archive);
 const bytes=Buffer.from(SYNTHETIC_MP4_BASE64,"base64");await writeFile(source,bytes);
 const input=await intakeMp4(source,await lstat(source)),staged=await (await createMp4Stage(stage))(input);
 assert.equal(staged.status,"staged");if(staged.status!=="staged")throw Error();
 t.after(async()=>{await staged.discard();await input.close();await rm(root,{recursive:true,force:true});});
 let opens=0;
 const snapshot={fingerprint:staged.snapshot.fingerprint,open:async()=>{opens++;const acquired=await staged.snapshot.acquire();return acquired.source.stream(0,acquired.fingerprint.bytes-1);}};
 const identity={title:"Synthetic archive",taskId:randomUUID(),executionId:randomUUID(),version:1};
 return {root,stage,archive,source,bytes,staged,snapshot,identity,get opens(){return opens;}};
}
test("staged exact bytes archive exclusively; same destination never overwrites and source stays unchanged",async t=>{
 const f=await fixture(t),options={directory:f.archive,identity:f.identity,snapshot:f.snapshot,isCurrent:()=>true};
 const first=await archiveStagedVideo(options);assert.equal(first.receipt?.status,"published");assert.equal(first.sourceCleanupConfirmed,true);assert.deepEqual(await readFile(first.receipt!.target),f.bytes);
 const again=await archiveStagedVideo(options);assert.equal(again.receipt?.status,"not-published");assert.deepEqual(await readFile(first.receipt!.target),f.bytes);assert.deepEqual(await readFile(f.source),f.bytes);assert.equal((await readdir(f.archive)).length,1);
 const mismatched=await archiveStagedVideo({...options,identity:{...f.identity,version:2},snapshot:{...f.snapshot,fingerprint:{...f.snapshot.fingerprint,sha256:"0".repeat(64)}}});assert.equal(mismatched.receipt?.status,"not-published");assert.equal((await readdir(f.archive)).length,1);
 assert.equal(await f.staged.discard(),"removed");assert.deepEqual(await readFile(first.receipt!.target),f.bytes);
});
test("cancel before source acquisition or during open prevents publication and confirms owned reader cleanup",async t=>{
 const f=await fixture(t),controller=new AbortController();controller.abort();
 const before=await archiveStagedVideo({directory:f.archive,identity:f.identity,snapshot:f.snapshot,isCurrent:()=>true,signal:controller.signal});assert.equal(before.status,"not-started");assert.equal(f.opens,0);
 const asyncGuard=await archiveStagedVideo({directory:f.archive,identity:f.identity,snapshot:f.snapshot,isCurrent:(async()=>{throw Error();}) as unknown as ()=>boolean});assert.equal(asyncGuard.status,"not-started");assert.equal(f.opens,0);
 const late=new AbortController(),snapshot={...f.snapshot,open:async()=>{const stream=await f.snapshot.open();late.abort();return stream;}};
 const result=await archiveStagedVideo({directory:f.archive,identity:f.identity,snapshot,isCurrent:()=>true,signal:late.signal});assert.equal(result.status,"not-started");assert.equal(result.sourceCleanupConfirmed,true);assert.deepEqual(await readdir(f.archive),[]);
});
test("late loss after link preserves published receipt, or uncertainty when destination cannot be reconciled",async t=>{
 for(const displaced of [false,true]) {
  const f=await fixture(t),controller=new AbortController();
  const result=await archiveStagedVideo({directory:f.archive,identity:f.identity,snapshot:f.snapshot,isCurrent:()=>true,signal:controller.signal},{link:async(from,to)=>{await link(from,to);controller.abort();if(displaced)await rename(to,join(f.archive,"displaced.mp4"));throw Object.assign(Error(),{code:"EIO"});}});
  assert.equal(result.status,"settled");assert.equal(result.currentAtReturn,false);assert.equal(result.receipt?.status,displaced?"publication-uncertain":"published");assert.equal(result.automaticRetry,false);
  assert.deepEqual(await readFile(displaced?join(f.archive,"displaced.mp4"):result.receipt!.target),f.bytes);
 }
});
test("publication temporary cleanup failure remains visible without changing the published bytes",async t=>{
 const f=await fixture(t);const result=await archiveStagedVideo({directory:f.archive,identity:f.identity,snapshot:f.snapshot,isCurrent:()=>true},{unlink:async()=>{throw Object.assign(Error(),{code:"EACCES"});}});
 assert.equal(result.receipt?.status,"published-cleanup-failed");assert.equal(result.receipt?.cleanup,"retained");assert.ok(result.receipt?.temporary);assert.equal(result.databaseCompleted,false);assert.deepEqual(await readFile(result.receipt!.target),f.bytes);
});
