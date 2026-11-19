import { registeredVideoResponse } from "../src/main/application/registered-video-response";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, lstat, rm, link, symlink, unlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID,createHash } from "node:crypto";
import { createRegisteredVideoLookup, type RegisteredVideoEntry } from "../src/main/infrastructure/registered-video-source";
import { buildVideoBasename } from "../src/shared/video-basename";
async function fixture(){const root=await mkdtemp(join(tmpdir(),"registered-read-"));const identity={taskId:randomUUID(),executionId:randomUUID(),version:1,title:"synthetic"};const path=join(root,buildVideoBasename(identity)),bytes=Buffer.alloc(150000);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;await writeFile(path,bytes);const stat=await lstat(path);const entry:RegisteredVideoEntry={id:randomUUID(),identity,dev:stat.dev,ino:stat.ino,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};return {root,path,bytes,entry};}
test("immutable UUID allowlist exposes exact verified ranges only; source and stream own one close lifecycle",async()=>{
 const f=await fixture();try{const entries=[structuredClone(f.entry)],lookup=await createRegisteredVideoLookup(f.root,entries);entries[0]!.sha256="0".repeat(64);entries.length=0;
 for(const id of [f.path,"../private",f.entry.id.toUpperCase(),randomUUID()])assert.equal(await lookup(id),null);
 const source=(await lookup(f.entry.id))!;assert.ok(source);assert.equal(source.byteLength,f.bytes.length);assert.throws(()=>source.stream(-1,2));const body=source.stream(65000,140000);assert.throws(()=>source.stream(0,1));await source.close();
 const reader=body.getReader(),parts:Uint8Array[]=[];for(;;){const item=await reader.read();if(item.done)break;assert.ok(item.value.length<=65536);parts.push(item.value);}assert.deepEqual(Buffer.concat(parts),f.bytes.subarray(65000,140001));
 const closed=(await lookup(f.entry.id))!;await closed.close();await closed.close();assert.throws(()=>closed.stream(0,1));
 const cancelled=(await lookup(f.entry.id))!;const stream=cancelled.stream(0,f.bytes.length-1);await stream.cancel();assert.throws(()=>cancelled.stream(0,1));await cancelled.close();assert.deepEqual(await readFile(f.path),f.bytes);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("same-size tampering, identity/size mismatch and mutation after acquisition are rejected",async()=>{
 const f=await fixture();try{const lookup=await createRegisteredVideoLookup(f.root,[f.entry]);await writeFile(f.path,Buffer.alloc(f.bytes.length,99));assert.equal(await lookup(f.entry.id),null);await writeFile(f.path,f.bytes);
 for(const patch of [{bytes:f.bytes.length-1},{ino:f.entry.ino+1}]){const wrong=await createRegisteredVideoLookup(f.root,[{...f.entry,...patch}]);assert.equal(await wrong(f.entry.id),null);}
 const source=(await lookup(f.entry.id))!;assert.ok(source);await writeFile(f.path,Buffer.alloc(f.bytes.length,88));await assert.rejects(new Response(source.stream(0,10)).arrayBuffer(),/本地视频读取失败/);await source.close();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("symlink, hardlink and root aliases are refused without reading unrelated file bytes",async()=>{
 const f=await fixture();try{const lookup=await createRegisteredVideoLookup(f.root,[f.entry]);const alias=join(f.root,"other");await link(f.path,alias);assert.equal(await lookup(f.entry.id),null);await unlink(alias);
 await rename(f.path,alias);await symlink(alias,f.path);assert.equal(await lookup(f.entry.id),null);
 const rootAlias=f.root+"-alias";try{await symlink(f.root,rootAlias,"dir");await assert.rejects(createRegisteredVideoLookup(rootAlias,[f.entry]));}finally{await unlink(rootAlias).catch(()=>undefined);}
 await assert.rejects(createRegisteredVideoLookup(f.root,[f.entry,f.entry]));
 for(const root of ["", ".", f.root+"/../"])await assert.rejects(createRegisteredVideoLookup(root,[f.entry]));
 }finally{await rm(f.root,{recursive:true,force:true});}
});

test("real acquired source integrates HEAD and 416 close, GET range and pending-pull cancellation",async()=>{
 const f=await fixture();try{const lookup=await createRegisteredVideoLookup(f.root,[f.entry]);let closes=0;
 const observed=async(id:string)=>{const source=await lookup(id);return source?{byteLength:source.byteLength,stream:source.stream,close:async()=>{closes++;await source.close();}}:null;};
 const url=`app://video/${f.entry.id}`;
 const head=await registeredVideoResponse({url,method:"HEAD",headers:new Headers()},observed);assert.equal(head.status,200);assert.equal(await head.text(),"");assert.equal(closes,1);
 const bad=await registeredVideoResponse({url,method:"GET",headers:new Headers({range:"bytes=999999-"})},observed);assert.equal(bad.status,416);assert.equal(closes,2);
 const range=await registeredVideoResponse({url,method:"GET",headers:new Headers({range:"bytes=10-19"})},observed);assert.equal(range.status,206);assert.deepEqual(Buffer.from(await range.arrayBuffer()),f.bytes.subarray(10,20));assert.equal(closes,2);
 const source=(await lookup(f.entry.id))!,reader=source.stream(0,f.bytes.length-1).getReader();const pending=reader.read();await reader.cancel();await pending;assert.equal((await reader.read()).done,true);await source.close();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
