import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID,createHash } from "node:crypto";
import { mkdtemp,writeFile,lstat,rm,mkdir,rename,symlink,truncate,readdir,readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { writeVerifiedVideoBytes } from "../src/main/infrastructure/video-byte-writer";
function box(type:string,payload:Buffer,large=false){const header=Buffer.alloc(large?16:8);header.writeUInt32BE(large?1:header.length+payload.length);header.write(type,4,"ascii");if(large)header.writeBigUInt64BE(BigInt(header.length+payload.length),8);return Buffer.concat([header,payload]);}
const ftyp=box("ftyp",Buffer.concat([Buffer.from("isom"),Buffer.alloc(4),Buffer.from("mp42")]));
const fixtureBytes=()=>Buffer.concat([ftyp,box("moov",Buffer.from("not decoded metadata"),true),box("mdat",Buffer.alloc(140000,37))]);
async function fixture(){const root=await mkdtemp(join(tmpdir(),"mp4-intake-")),path=join(root,"source.mp4"),bytes=fixtureBytes();await writeFile(path,bytes);return {root,path,bytes,stat:await lstat(path)};}
test("constructed boxes are structure-only, bounded one-shot stream feeds real exclusive writer",async()=>{
 const f=await fixture();try{const source=await intakeMp4(f.path,f.stat);assert.deepEqual(source.evidence,{sha256:createHash("sha256").update(f.bytes).digest("hex"),bytes:f.bytes.length,structureChecked:true,decoded:false});assert.ok(!JSON.stringify(source).includes(f.path));
 const out=join(f.root,"out");await mkdir(out);let chunks=0;const stream=source.stream();
 const result=await writeVerifiedVideoBytes({directory:out,identity:{taskId:randomUUID(),executionId:randomUUID(),version:1,title:"synthetic"},expectedBytes:source.evidence.bytes,expectedSha256:source.evidence.sha256,chunks:(async function*(){for await(const bytes of stream){chunks++;assert.ok(bytes.length<=65536);yield bytes;}})()});
 assert.equal(result.status,"published");assert.deepEqual(await readFile(result.target),f.bytes);assert.deepEqual(await readFile(f.path),f.bytes);assert.ok(chunks>=3);assert.equal(result.mediaValidated,false);assert.throws(()=>source.stream());await source.close();
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("malformed, unsupported, truncated, too many boxes and stale selected identity fail closed",async()=>{
 const f=await fixture();try{
 const highType=fixtureBytes();highType[ftyp.length+4]=0xed;
 const highBrand=Buffer.concat([box("ftyp",Buffer.concat([Buffer.from([0xe9,0x73,0x6f,0x6d]),Buffer.alloc(4)])),box("moov",Buffer.from("x")),box("mdat",Buffer.from("x"))]);
 const malformed=[highType,highBrand,Buffer.from("garbage"),Buffer.concat([ftyp,box("mdat",Buffer.from("x"))]),Buffer.concat([box("ftyp",Buffer.concat([Buffer.from("zzzz"),Buffer.alloc(4)])),box("moov",Buffer.from("x")),box("mdat",Buffer.from("x"))]),f.bytes.subarray(0,f.bytes.length-1),Buffer.concat([ftyp,box("moov",Buffer.alloc(0)),box("mdat",Buffer.from("x"))]),Buffer.concat([ftyp,...Array.from({length:10001},()=>box("free",Buffer.alloc(0)))]),Buffer.concat([ftyp,Buffer.from([0,0,0,1,109,100,97,116,255,255,255,255,255,255,255,255])])];
 for(const bytes of malformed){await writeFile(f.path,bytes);await assert.rejects(intakeMp4(f.path,await lstat(f.path)),error=>error instanceof Error&&!error.message.includes(f.path));}
 await writeFile(f.path,f.bytes);await assert.rejects(intakeMp4(f.path,{...f.stat,ino:f.stat.ino+1}));
 const old=join(f.root,"old");await rename(f.path,old);await writeFile(f.path,f.bytes);await assert.rejects(intakeMp4(f.path,f.stat));await rm(f.path);await symlink(old,f.path);await assert.rejects(intakeMp4(f.path,await lstat(old)));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("mutation/truncation during streaming prevents writer publication; cancel/idle abort and unused return close",async()=>{
 const f=await fixture();try{
 for(const mode of ["replace","truncate"]){await writeFile(f.path,f.bytes);const source=await intakeMp4(f.path,await lstat(f.path)),out=join(f.root,mode);await mkdir(out);
 const result=await writeVerifiedVideoBytes({directory:out,identity:{taskId:randomUUID(),executionId:randomUUID(),version:1,title:"synthetic"},expectedBytes:source.evidence.bytes,expectedSha256:source.evidence.sha256,chunks:(async function*(){let first=true;for await(const bytes of source.stream()){yield bytes;if(first){first=false;if(mode==="replace")await writeFile(f.path,Buffer.alloc(f.bytes.length,9));else await truncate(f.path,20);}}})()});
 assert.equal(result.status,"not-published");assert.deepEqual(await readdir(out),[]);await source.close();}
 await writeFile(f.path,f.bytes);const abort=new AbortController();const idle=await intakeMp4(f.path,await lstat(f.path),abort.signal);abort.abort();assert.throws(()=>idle.stream());await idle.close();
 const unused=await intakeMp4(f.path,await lstat(f.path));await unused.stream().return!();assert.throws(()=>unused.stream());await unused.close();
 const active=await intakeMp4(f.path,await lstat(f.path));const iterator=active.stream();await iterator.next();await iterator.return!();assert.equal((await iterator.next()).done,true);
 const during=new AbortController();const aborted=await intakeMp4(f.path,await lstat(f.path),during.signal);const pending=aborted.stream();await pending.next();during.abort();await assert.rejects(pending.next());await aborted.close();
 await assert.rejects(intakeMp4(f.path,{...await lstat(f.path),size:8*1024**3+1}));
 const pre=new AbortController();pre.abort();await assert.rejects(intakeMp4(f.path,await lstat(f.path),pre.signal));
 }finally{await rm(f.root,{recursive:true,force:true});}
});
