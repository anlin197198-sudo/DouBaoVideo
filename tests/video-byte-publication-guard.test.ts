import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID,createHash } from "node:crypto";
import { mkdtemp,readdir,rm,link,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeVerifiedVideoBytes,type VideoByteWriteInput } from "../src/main/infrastructure/video-byte-writer";
const bytes=Buffer.from("synthetic guarded bytes");
const input=(directory:string):VideoByteWriteInput=>({directory,identity:{taskId:randomUUID(),executionId:randomUUID(),version:1,title:"guard"},expectedBytes:bytes.length,expectedSha256:createHash("sha256").update(bytes).digest("hex"),chunks:(async function*(){yield bytes;})()});
test("guard rejects false, thrown errors and disguised Promise without creating/linking output",async()=>{
 const root=await mkdtemp(join(tmpdir(),"guard-"));try{
 for(const guard of [()=>false,()=>{throw Error("private");},(()=>Promise.resolve(true)) as unknown as ()=>boolean, (async()=>{throw Error("private");}) as unknown as ()=>boolean]){let calls=0;const result=await writeVerifiedVideoBytes({...input(root),beforePublish:guard},{link:async()=>{calls++;}});assert.equal(result.status,"not-published");assert.equal(result.reason,"PUBLICATION_GUARD_REJECTED");assert.equal(result.cleanup,"not-created");assert.equal(calls,0);assert.deepEqual(await readdir(root),[]);}
 }finally{await rm(root,{recursive:true,force:true});}
});
test("guard is captured before await and checked after streaming just before link; rejection cleans only temporary",async()=>{
 const root=await mkdtemp(join(tmpdir(),"guard-"));try{let current=true,checks=0,links=0;const request=input(root);request.beforePublish=()=>{checks++;return current;};request.chunks=(async function*(){yield bytes;current=false;request.beforePublish=()=>true;})();
 const result=await writeVerifiedVideoBytes(request,{link:async()=>{links++;}});assert.equal(checks,2);assert.equal(links,0);assert.equal(result.reason,"PUBLICATION_GUARD_REJECTED");assert.equal(result.cleanup,"removed");assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("guard becoming false after link starts does not misreport a published target as cancelled",async()=>{
 const root=await mkdtemp(join(tmpdir(),"guard-"));try{let current=true,checks=0;const result=await writeVerifiedVideoBytes({...input(root),beforePublish:()=>{checks++;return current;}},{link:async(source,destination)=>{current=false;await link(source,destination);}});
 assert.equal(checks,2);assert.equal(result.status,"published");assert.equal(result.reason,"VERIFIED_BYTES_PUBLISHED");assert.equal(result.automaticRetry,false);assert.deepEqual(await readFile(result.target),bytes);assert.equal((await readdir(root)).length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
