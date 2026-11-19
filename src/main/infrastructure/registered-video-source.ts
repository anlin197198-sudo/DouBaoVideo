import { constants, type Stats } from "node:fs";
import { lstat, realpath, open, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, join, isAbsolute } from "node:path";
import { z } from "zod";
import { buildVideoBasename } from "../../shared/video-basename";
import { MAX_VIDEO_WRITE_BYTES } from "./video-byte-writer";
import type { RegisteredVideoSource } from "../application/registered-video-response";
const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
const registrationSchema = z.object({ id: uuid,
  identity: z.object({taskId:uuid,executionId:uuid,version:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),title:z.string().max(2000)}).strict(),
  dev:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),ino:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bytes:z.number().int().positive().max(MAX_VIDEO_WRITE_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type RegisteredVideoEntry = z.infer<typeof registrationSchema>;
const same=(a:Stats,b:{dev:number;ino:number})=>a.dev===b.dev&&a.ino===b.ino;
const unchanged=(a:Stats,b:Stats)=>same(a,b)&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&a.nlink===1;
/** Main-only immutable explicit registration. Never reads films.file_path or accepts renderer paths.
 * Byte/identity integrity is NOT media validation. Future registration must separately verify media.
 * Trusted canonical local parent, not a hostile same-user filesystem sandbox. Node cannot universally
 * identify all Windows reparse points; real Windows filesystem qualification is still required.
 * Every acquisition hashes the entire pinned handle in 64 KiB reads before range streaming. */
export async function createRegisteredVideoLookup(root:string, rawEntries:readonly RegisteredVideoEntry[]) {
  let entries:RegisteredVideoEntry[];
  try { entries=z.array(registrationSchema).max(10000).parse(rawEntries); } catch { throw new Error("无效的本地视频登记。"); }
  if(new Set(entries.map(e=>e.id)).size!==entries.length)throw new Error("无效的本地视频登记。");
  if(typeof root!=="string"||!isAbsolute(root)||resolve(root)!==root)throw new Error("无效的视频登记根目录。");
  const directory=root,parent=await lstat(directory);
  if(!parent.isDirectory()||parent.isSymbolicLink()||await realpath(directory)!==directory)throw new Error("无效的视频登记根目录。");
  const registry=new Map(entries.map(e=>[e.id,Object.freeze({...e,identity:Object.freeze({...e.identity}),basename:buildVideoBasename(e.identity)})]));
  async function validParent(){const now=await lstat(directory);if(!now.isDirectory()||now.isSymbolicLink()||!same(now,parent)||await realpath(directory)!==directory)throw new Error("UNAVAILABLE");}
  return async (id:string):Promise<RegisteredVideoSource|null>=>{
    if(!uuid.safeParse(id).success)return null;
    const entry=registry.get(id);if(!entry)return null;
    let handle:FileHandle|null=null;
    try {
      await validParent();const path=join(directory,entry.basename),pathStat=await lstat(path);
      if(!pathStat.isFile()||pathStat.isSymbolicLink()||pathStat.nlink!==1||!same(pathStat,entry)||await realpath(path)!==path)throw Error("UNAVAILABLE");
      handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0)|(constants.O_NONBLOCK??0));
      const initial=await handle.stat();
      if(!initial.isFile()||initial.nlink!==1||!same(initial,entry)||initial.size!==entry.bytes)throw Error("UNAVAILABLE");
      const hash=createHash("sha256"),buffer=Buffer.alloc(65536);let offset=0;
      while(offset<entry.bytes){const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,entry.bytes-offset),offset);if(!bytesRead)throw Error("UNAVAILABLE");hash.update(buffer.subarray(0,bytesRead));offset+=bytesRead;}
      if(!unchanged(await handle.stat(),initial)||hash.digest("hex")!==entry.sha256)throw Error("UNAVAILABLE");
      await validParent();const finalPath=await lstat(path);if(!finalPath.isFile()||finalPath.isSymbolicLink()||!same(finalPath,initial)||finalPath.nlink!==1||await realpath(path)!==path)throw Error("UNAVAILABLE");
      const file=handle;handle=null;let owner:"source"|"stream"|"closed"="source",closing:Promise<void>|null=null;
      const close=()=>{owner="closed";return closing??=file.close();};
      return Object.freeze({byteLength:entry.bytes,
        close:()=>owner==="stream"?Promise.resolve():close(),
        stream(start:number,end:number):ReadableStream<Uint8Array<ArrayBuffer>>{
          if(owner!=="source"||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>=entry.bytes)throw Error("视频读取范围不可用。");
          owner="stream";let position=start,cancelled=false;
          return new ReadableStream<Uint8Array<ArrayBuffer>>({
            async pull(controller){
              try{
                if(cancelled)return;
                if(!unchanged(await file.stat(),initial))throw Error("CHANGED");
                const chunk=new Uint8Array(Math.min(65536,end-position+1));
                const {bytesRead}=await file.read(chunk,0,chunk.length,position);
                if(cancelled)return;
                if(!bytesRead||!unchanged(await file.stat(),initial))throw Error("CHANGED");
                position+=bytesRead;controller.enqueue(chunk.subarray(0,bytesRead));
                if(position>end){await close();if(!cancelled)controller.close();}
              }catch{await close().catch(()=>undefined);if(!cancelled)controller.error(new Error("本地视频读取失败。"));}
            },
            async cancel(){cancelled=true;await close();},
          },{highWaterMark:0});
        }});
    }catch{if(handle)await handle.close().catch(()=>undefined);return null;}
  };
}
