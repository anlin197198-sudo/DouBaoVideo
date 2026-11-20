import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, readdir, link, unlink, lstat, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildVideoBasename } from "../src/shared/video-basename";
import { writeVerifiedVideoBytes, MAX_VIDEO_WRITE_BYTES, type VideoByteWriteInput } from "../src/main/infrastructure/video-byte-writer";
const bytes=Buffer.alloc(180000,42); // Arbitrary synthetic bytes, deliberately not called valid video.
const digest=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
function input(directory:string):VideoByteWriteInput{return {directory,identity:{taskId:randomUUID(),executionId:randomUUID(),version:1,title:"synthetic"},expectedBytes:bytes.length,expectedSha256:digest(bytes),chunks:(async function*(){yield bytes.subarray(0,90000);yield bytes.subarray(90000);})()};}
const rerun=(a:VideoByteWriteInput)=>({...a,chunks:(async function*(){yield bytes;})()});
test("verified chunked bytes publish exclusively; existing target and concurrent same destination never overwrite",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"byte-writer-"));try{
 const a=input(dir),results=await Promise.all([writeVerifiedVideoBytes(a),writeVerifiedVideoBytes(rerun(a))]);
 assert.deepEqual(results.map(r=>r.status).sort(),["not-published","published"]);assert.deepEqual(await readFile(results[0]!.target),bytes);assert.equal((await readdir(dir)).length,1);
 const old=Buffer.from("existing file");await writeFile(results[0]!.target,old);const rejected=await writeVerifiedVideoBytes(rerun(a));assert.equal(rejected.status,"not-published");assert.deepEqual(await readFile(rejected.target),old);
 for(const r of results){assert.equal(r.automaticRetry,false);assert.equal(r.mediaValidated,false);assert.equal(r.databaseCompleted,false);assert.ok(Object.isFrozen(r));}
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("digest, length, stream failure and unsupported hardlinks remove only temporary outputs",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"byte-writer-"));try{await writeFile(join(dir,"keep"),"unrelated");
 for(const patch of [{expectedSha256:"0".repeat(64)},{expectedBytes:bytes.length-1},{expectedBytes:bytes.length+1},{chunks:(async function*(){yield bytes.subarray(0,10);throw Error("private failure");})()}]){
 const result=await writeVerifiedVideoBytes({...input(dir),...patch});assert.equal(result.status,"not-published");assert.equal(result.cleanup,"removed");assert.doesNotMatch(JSON.stringify(result),/private failure/);assert.deepEqual(await readdir(dir),["keep"]);}
 const unsupported=await writeVerifiedVideoBytes(input(dir),{link:async()=>{throw Object.assign(Error("unsupported"),{code:"ENOTSUP"})}});assert.equal(unsupported.status,"not-published");assert.deepEqual(await readdir(dir),["keep"]);
 await assert.rejects(writeVerifiedVideoBytes({...input(dir),expectedBytes:MAX_VIDEO_WRITE_BYTES+1}));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("postpublication cleanup failure and lost link response retain published target and prohibit blind retry",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"byte-writer-"));try{
 const a=input(dir),failed=await writeVerifiedVideoBytes(a,{unlink:async()=>{throw Error("synthetic cleanup refusal")}});
 assert.equal(failed.status,"published-cleanup-failed");assert.equal(failed.cleanup,"retained");assert.ok(failed.temporary);assert.deepEqual(await readFile(failed.target),bytes);assert.equal((await lstat(failed.target)).ino,(await lstat(failed.temporary)).ino);
 const retry=await writeVerifiedVideoBytes(rerun(a));assert.equal(retry.status,"not-published");assert.deepEqual(await readFile(failed.target),bytes);await unlink(failed.temporary);
 const lost=await writeVerifiedVideoBytes(input(dir),{link:async(from,to)=>{await link(from,to);throw Error("lost response")}});assert.equal(lost.status,"published");assert.equal(lost.automaticRetry,false);assert.deepEqual(await readFile(lost.target),bytes);
 const cleanupLost=await writeVerifiedVideoBytes(input(dir),{unlink:async path=>{await unlink(path);throw Error("cleanup acknowledgement lost")}});assert.equal(cleanupLost.status,"published");assert.equal(cleanupLost.cleanup,"removed");assert.equal(cleanupLost.temporary,null);
 const unknown=await writeVerifiedVideoBytes(input(dir),{link:async()=>{throw Object.assign(Error("ambiguous"),{code:"EIO"})}});assert.equal(unknown.status,"publication-uncertain");assert.equal(unknown.automaticRetry,false);
 const replaced=await writeVerifiedVideoBytes(input(dir),{link:async(from,to)=>{await link(from,to);await rename(to,to+".moved");await writeFile(to,"unrelated replacement");throw Object.assign(Error("lost response"),{code:"EIO"})}});
 assert.equal(replaced.status,"publication-uncertain");assert.equal(await readFile(replaced.target,"utf8"),"unrelated replacement");assert.deepEqual(await readFile(replaced.target+".moved"),bytes);
 const long=input(dir);long.identity.title="汉".repeat(2000);if(Buffer.byteLength(buildVideoBasename(long.identity))>255){const r=await writeVerifiedVideoBytes(long,{link:async()=>{throw Object.assign(Error("synthetic name limit"),{code:"ENAMETOOLONG"})}});assert.equal(r.status,"publication-uncertain");assert.equal(r.cleanup,"removed");}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("clean publication returns frozen original file and parent identities only; ambiguous outcomes omit proof",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"byte-proof-"));try{
 const result=await writeVerifiedVideoBytes(input(dir)),file=await lstat(result.target),parent=await lstat(dir);
 assert.equal(result.status,"published");assert.deepEqual(result.publishedIdentity,{dev:file.dev,ino:file.ino,parentDev:parent.dev,parentIno:parent.ino,size:file.size,mtimeMs:file.mtimeMs,ctimeMs:file.ctimeMs});assert.ok(Object.isFrozen(result.publishedIdentity));
 const rejected=await writeVerifiedVideoBytes({...input(dir),expectedSha256:"0".repeat(64)});assert.equal(Object.hasOwn(rejected,"publishedIdentity"),false);
 const uncertain=await writeVerifiedVideoBytes(input(dir),{link:async()=>{throw Object.assign(Error(),{code:"EIO"});}});assert.equal(uncertain.status,"publication-uncertain");assert.equal(Object.hasOwn(uncertain,"publishedIdentity"),false);
 const retained=await writeVerifiedVideoBytes(input(dir),{unlink:async()=>{throw Error();}});assert.equal(retained.status,"published-cleanup-failed");assert.equal(Object.hasOwn(retained,"publishedIdentity"),false);
 let observedTarget="";
 const changedAfterCleanup=await writeVerifiedVideoBytes(input(dir),{link:async(source,target)=>{observedTarget=String(target);await link(source,target);},unlink:async(path)=>{await unlink(path);await writeFile(observedTarget,"different size");}});
 assert.equal(changedAfterCleanup.status,"published");assert.equal(changedAfterCleanup.cleanup,"removed");assert.equal(Object.hasOwn(changedAfterCleanup,"publishedIdentity"),false);

 }finally{await rm(dir,{recursive:true,force:true});}
});
