import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
const owner=()=>({ownerId:7,documentId:randomUUID()});
const fingerprint={sha256:"a".repeat(64),bytes:6};
const request=(url:string,method="GET",range?:string)=>({url,method,headers:new Headers(range?{range}:{})});
function source(){let closes=0;return {get closes(){return closes;},value:{byteLength:6,close:async()=>{closes++;},stream:(start:number,end:number)=>new ReadableStream<Uint8Array<ArrayBuffer>>({start(c){c.enqueue(new Uint8Array([1,2,3,4,5,6]).slice(start,end+1));c.close();closes++;}})}};}
test("probe is canonical, owner/document-bound, exact fingerprint, range-capable and never exposes paths",async()=>{
 const who=owner();let calls=0;const registry=new VideoProbeRegistry({isLive:(id,doc)=>id===who.ownerId&&doc===who.documentId,now:()=>100});
 const input={...who,fingerprint:{...fingerprint}};const token=registry.issue(input,async()=>{calls++;return {fingerprint,source:source().value};});input.fingerprint.sha256="b".repeat(64);
 assert.ok(Object.isFrozen(token));assert.match(token.url,/^app:\/\/video\/[0-9a-f-]{36}$/);
 for(const url of [token.url+"?x",token.url+"/",token.url.toUpperCase(),"file:///private.mp4"])assert.equal((await registry.response(request(url),who)).status,404);
 for(const person of [{...who,ownerId:8},{...who,documentId:randomUUID()}])assert.equal((await registry.response(request(token.url),person)).status,404);
 assert.equal(calls,0);const response=await registry.response(request(token.url,"GET","bytes=2-4"),who);assert.equal(response.status,206);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[3,4,5]);assert.equal(response.headers.get("Cache-Control"),"no-store");assert.equal(calls,1);
 const head=source();const t=registry.issue({...who,fingerprint},async()=>({fingerprint,source:head.value}));assert.equal((await registry.response(request(t.url,"HEAD"),who)).status,200);assert.equal(head.closes,1);
 registry.invalidateOwner(who.ownerId);assert.equal((await registry.response(request(token.url),who)).status,404);
});
test("deferred acquisition closes on revocation, expiry, navigation or mismatched bytes; no stale serve",async()=>{
 for(const mode of ["revoke","expire","navigate","hash","size","clock"]){let now=100,live=true;const who=owner(),file=source();let release!:()=>void;const gate=new Promise<void>(done=>release=done);
 const registry=new VideoProbeRegistry({isLive:()=>live,now:()=>now,ttlMs:10});const token=registry.issue({...who,fingerprint},async()=>{await gate;return {fingerprint:mode==="hash"?{...fingerprint,sha256:"b".repeat(64)}:mode==="size"?{...fingerprint,bytes:5}:fingerprint,source:file.value};});
 const pending=registry.response(request(token.url),who);
 if(mode==="revoke")registry.revoke(token.id);if(mode==="expire")now=110;if(mode==="navigate")live=false;if(mode==="clock")now=NaN;
 release();assert.equal((await pending).status,404);assert.equal(file.closes,1);
 }
});
test("bounded registry rejects bad inputs, dead owners and TTL; prunes expiry without granting replay",async()=>{
 const who=owner();let now=0;const registry=new VideoProbeRegistry({isLive:()=>true,now:()=>now,ttlMs:10}),acquire=async()=>({fingerprint,source:source().value});
 for(const ttlMs of [0,-1,120001,NaN,Infinity])assert.throws(()=>new VideoProbeRegistry({isLive:()=>true,ttlMs}));
 assert.throws(()=>registry.issue({...who,fingerprint,path:"private"},acquire));assert.throws(()=>new VideoProbeRegistry({isLive:()=>false}).issue({...who,fingerprint},acquire));
 const tokens=Array.from({length:128},()=>registry.issue({...who,fingerprint},acquire));assert.throws(()=>registry.issue({...who,fingerprint},acquire));now=10;
 const next=registry.issue({...who,fingerprint},acquire);assert.equal((await registry.response(request(tokens[0]!.url),who)).status,404);assert.equal((await registry.response(request(next.url),who)).status,200);
 now=20;assert.equal((await registry.response(request(next.url),who)).status,404);now=15;assert.equal((await registry.response(request(next.url),who)).status,404);
 now=-1;assert.equal((await registry.response(request(next.url),who)).status,404);
});

test("revocation in the lookup continuation gap blocks GET and HEAD before stream transfer",async()=>{
 for(const method of ["GET","HEAD"]){const who=owner(),file=source();let checks=0,id="";
 const registry=new VideoProbeRegistry({isLive:()=>{if(++checks===3)queueMicrotask(()=>registry.revoke(id));return true;},now:()=>100});
 const token=registry.issue({...who,fingerprint},async()=>({fingerprint,source:file.value}));id=token.id;
 const response=await registry.response(request(token.url,method),who);
 assert.equal(response.status,404);assert.equal(file.closes,1);
 }
});
