import { constants, type Stats } from "node:fs";
import { lstat, realpath, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createHash } from "node:crypto";
import { MAX_VIDEO_WRITE_BYTES } from "./video-byte-writer";
export type Mp4Selection = Readonly<Pick<Stats,"dev"|"ino"|"size"|"mtimeMs"|"ctimeMs">>;
const failure=()=>new Error("所选 MP4 文件不可用、结构不支持或已变化。");
const same=(a:Mp4Selection,b:Mp4Selection)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
const brands=new Set(["isom","iso2","mp41","mp42","avc1"]);
/** Main-only caller-confirmed selection. Trusted local filesystem, not a hostile same-user sandbox.
 * Top-level MP4 structure sanity only, NOT decoding/media suitability. No Windows reparse guarantee.
 * No path is exposed in evidence. No source writes; returned stream must be consumed or closed. */
export async function intakeMp4(path:string, selection:Mp4Selection, signal?:AbortSignal){
 let handle:FileHandle|null=null;
 try{
  const expected={dev:selection.dev,ino:selection.ino,size:selection.size,mtimeMs:selection.mtimeMs,ctimeMs:selection.ctimeMs};
  if(typeof path!=="string"||!isAbsolute(path)||resolve(path)!==path||!Object.values(expected).every(Number.isFinite)||!Number.isSafeInteger(expected.size)||expected.size<=0||expected.size>MAX_VIDEO_WRITE_BYTES)throw failure();
  const checkAbort=()=>{if(signal?.aborted)throw failure();};checkAbort();
  const before=await lstat(path);
  if(!before.isFile()||before.isSymbolicLink()||!same(before,expected)||await realpath(path)!==path)throw failure();
  handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
  const file=handle;
  const check=async()=>{checkAbort();const stat=await file.stat();if(!stat.isFile()||!same(stat,expected))throw failure();};
  const checkPath=async()=>{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||!same(stat,expected)||await realpath(path)!==path)throw failure();};
  await check();
  const read=async(position:number,length:number)=>{checkAbort();const buffer=Buffer.alloc(length);let cursor=0;while(cursor<length){const {bytesRead}=await file.read(buffer,cursor,length-cursor,position+cursor);if(!bytesRead)throw failure();cursor+=bytesRead;checkAbort();}return buffer;};
  let offset=0,count=0,ftyp=false,moov=false,mdat=false;
  while(offset<expected.size){
   if(++count>10000||expected.size-offset<8)throw failure();
   const header=await read(offset,8),type=header.toString("latin1",4,8);let size=header.readUInt32BE(0),headerSize=8;
   if(size===1){if(expected.size-offset<16)throw failure();const large=(await read(offset+8,8)).readBigUInt64BE();if(large>BigInt(Number.MAX_SAFE_INTEGER))throw failure();size=Number(large);headerSize=16;}
   else if(size===0)size=expected.size-offset;
   if(size<headerSize||size>expected.size-offset)throw failure();
   const payload=size-headerSize;
   if(type==="ftyp"){
    if(ftyp||payload<8||payload>4096||(payload-8)%4!==0)throw failure();
    const data=await read(offset+headerSize,payload);
    let supported=brands.has(data.toString("latin1",0,4));
    for(let i=8;i<data.length;i+=4)supported ||= brands.has(data.toString("latin1",i,i+4));
    if(!supported)throw failure();ftyp=true;
   }
   if(type==="moov"){if(!payload)throw failure();moov=true;}
   if(type==="mdat"){if(!payload)throw failure();mdat=true;}
   offset+=size;
  }
  if(!ftyp||!moov||!mdat)throw failure();
  const hash=createHash("sha256");for(let position=0;position<expected.size;position+=65536)hash.update(await read(position,Math.min(65536,expected.size-position)));
  await check();await checkPath();const digest=hash.digest("hex");
  let closed=false,claimed=false,closing:Promise<void>|null=null;
  const close=()=>{closed=true;signal?.removeEventListener("abort",onAbort);return closing??=file.close().catch(()=>{throw failure();});};
  const onAbort=()=>{void close().catch(()=>undefined);};
  signal?.addEventListener("abort",onAbort,{once:true});
  if(signal?.aborted){await close();throw failure();}
  handle=null;
  return Object.freeze({evidence:Object.freeze({sha256:digest,bytes:expected.size,structureChecked:true as const,decoded:false as const}),close,
   stream():AsyncIterableIterator<Uint8Array>{
    if(claimed||closed)throw failure();claimed=true;
    const generator=(async function*(){try{
     const streamed=createHash("sha256");let total=0;
     while(total<expected.size){if(closed)throw failure();await check();const bytes=await read(total,Math.min(65536,expected.size-total));await check();streamed.update(bytes);total+=bytes.length;yield bytes;}
     await check();await checkPath();if(total!==expected.size||streamed.digest("hex")!==digest)throw failure();
    }catch{throw failure();}finally{await close();}})();
    // Async generator return before first next does not execute finally; explicitly close here.
    return {next:()=>generator.next(),return:async()=>{await close();return generator.return(undefined);},throw:async()=>{await close();throw failure();},[Symbol.asyncIterator](){return this;}};
   }});
 }catch{if(handle)await handle.close().catch(()=>undefined);throw failure();}
}
