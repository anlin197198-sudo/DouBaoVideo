import { lstatSync,realpathSync } from "node:fs";
import { lstat,realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isAbsolute,parse,resolve } from "node:path";
import type { ApplicationDatabase } from "../infrastructure/database";
import { intakeMp4,type Mp4Selection } from "../infrastructure/mp4-intake";
import { preflightArchiveDirectory } from "../infrastructure/archive-directory-preflight";
import { preflightFilmVersion } from "../infrastructure/film-version-preflight";
import { createVerifiedLocalImport,type VerifiedLocalImportResult } from "./verified-local-import";
import type { createPrivateVideoFirstFrameHost } from "../electron/private-video-first-frame-host";
const uuid=z.string().uuid().regex(/^[0-9a-f-]+$/);
const requestSchema=z.object({taskId:uuid,revision:z.number().int().nonnegative().safe()}).strict();
export type LocalImportRequest=z.infer<typeof requestSchema>;
export type LocalImportOrigin=Readonly<{windowId:number;documentId:string;epoch:number}>;
export interface LocalImportCommandOptions {
 database:ApplicationDatabase;stagingParent:string;origin:LocalImportOrigin;
 isCurrent:(origin:LocalImportOrigin,request:Readonly<LocalImportRequest>)=>boolean;
 selectSource:()=>Promise<{path:string;selection:Mp4Selection}|null>;
 selectDestination:()=>Promise<string|null>;
 isAllowedDestination:(directory:string)=>boolean;
 confirm:(preview:Readonly<{taskTitle:string;version:number;bytes:number;sha256:string;directory:string}>)=>Promise<boolean>;
 archivePreflightIO?:Parameters<typeof preflightArchiveDirectory>[2];
 createProbeHost:()=>ReturnType<typeof createPrivateVideoFirstFrameHost>;
}
export interface LocalImportCommandResult {
 status:"invalid-request"|"busy"|"cancelled"|"stale"|"failed"|"destination-unsupported"|"settled"|"cleanup-unconfirmed";
 archiveStatus:"none"|"not-published"|"published"|"published-cleanup-failed"|"publication-uncertain";
 recordStatus:"none"|"recorded"|"prior-recorded"|"recording-unconfirmed";
 cleanupConfirmed:boolean;automaticRetry:false;mediaPlaybackAuthorized:false;
}
const syncTrue=(check:()=>unknown)=>{try{const answer=check();if(answer instanceof Promise)void answer.catch(()=>undefined);return answer===true;}catch{return false;}};
/** Dormant main-only command. Ports are trusted native host actions, never renderer callbacks.
 * Host owns the V7 connection, stage root and destination policy. Origin identifies the initiating
 * editor document, NOT the separate decoder window. close invalidates/aborts but does not race
 * in-flight publication; callers must await run to learn its redacted durable facts. */
export function createLocalImportCommand(options:LocalImportCommandOptions){
 const {database,stagingParent,isCurrent,selectSource,selectDestination,isAllowedDestination,confirm,createProbeHost}=options;
 const origin=z.object({windowId:z.number().int().nonnegative().safe(),documentId:uuid,epoch:z.number().int().nonnegative().safe()}).strict().parse(options.origin);
 Object.freeze(origin);let active=true,running=false,controller:AbortController|undefined;
 return Object.freeze({close(){active=false;controller?.abort();},async run(raw:unknown,outerSignal?:AbortSignal):Promise<Readonly<LocalImportCommandResult>>{
  const result:LocalImportCommandResult={status:"failed",archiveStatus:"none",recordStatus:"none",cleanupConfirmed:true,automaticRetry:false,mediaPlaybackAuthorized:false};
  if(running)return Object.freeze({...result,status:"busy"});
  running=true;let input:Awaited<ReturnType<typeof intakeMp4>>|undefined,host:ReturnType<typeof createPrivateVideoFirstFrameHost>|undefined;
  controller=new AbortController();const signal=controller.signal,cancel=()=>controller?.abort();
  outerSignal?.addEventListener("abort",cancel,{once:true});if(outerSignal?.aborted)cancel();
  const applyFacts=(value:Readonly<VerifiedLocalImportResult>)=>{
   if(value.archive?.receipt){result.archiveStatus=value.archive.receipt.status;if(value.archive.receipt.cleanup==="retained"||value.archive.receipt.cleanup==="unknown")result.cleanupConfirmed=false;}
   if(value.archive?.status==="receipt-unconfirmed"&&!value.archive.receipt)result.archiveStatus="publication-uncertain";
   if(value.record)result.recordStatus=value.record.status;
   if(value.status==="cleanup-unconfirmed"||value.preparation?.status==="cleanup-unconfirmed"||value.archive?.sourceCleanupConfirmed===false)result.cleanupConfirmed=false;
  };
  try{
   let request:LocalImportRequest;try{request=requestSchema.parse(raw);Object.freeze(request);}catch{result.status="invalid-request";return Object.freeze({...result});}
   let destinationBinding:{path:string;dev:number;ino:number}|undefined;
   const destinationCurrent=()=>{if(!destinationBinding)return true;try{const binding=destinationBinding;
    if(!syncTrue(()=>isAllowedDestination(binding.path)))return false;
    const stat=lstatSync(binding.path);return stat.isDirectory()&&!stat.isSymbolicLink()&&stat.dev===binding.dev&&stat.ino===binding.ino&&realpathSync(binding.path)===binding.path;
   }catch{return false;}};
   const current=()=>active&&!signal.aborted&&syncTrue(()=>isCurrent(origin,request))&&destinationCurrent()&&active&&!signal.aborted;
   const check=()=>{if(!current()||database.version!==7)throw Error();const row=database.connection.prepare("SELECT revision,title FROM tasks WHERE id=?").get(request.taskId);if(row?.revision!==request.revision||typeof row.title!=="string")throw Error();return row.title;};
   if(!current()){result.status="stale";return Object.freeze({...result});}
   const title=check(),version=preflightFilmVersion(database.connection,{taskId:request.taskId,expectedRevision:request.revision}).proposedVersion;
   const selected=await selectSource();if(!current()){result.status="stale";return Object.freeze({...result});}if(!selected){result.status="cancelled";return Object.freeze({...result});}
   input=await intakeMp4(selected.path,selected.selection,signal);check();
   const directory=await selectDestination();check();if(directory===null){result.status="cancelled";}
   else{
    if(typeof directory!=="string"||!isAbsolute(directory)||resolve(directory)!==directory||parse(directory).root===directory||!syncTrue(()=>isAllowedDestination(directory)))throw Error();
    const destinationStat=await lstat(directory);if(!destinationStat.isDirectory()||destinationStat.isSymbolicLink()||await realpath(directory)!==directory)throw Error();check();
    const accepted=await confirm(Object.freeze({taskTitle:title,version,bytes:input.evidence.bytes,sha256:input.evidence.sha256,directory}));
    check();if(accepted!==true)result.status="cancelled";
    else{
     if(check()!==title||preflightFilmVersion(database.connection,{taskId:request.taskId,expectedRevision:request.revision}).proposedVersion!==version)throw Error();
     if(!syncTrue(()=>isAllowedDestination(directory)))throw Error();
     const finalDestination=await lstat(directory);
     if(!finalDestination.isDirectory()||finalDestination.isSymbolicLink()||finalDestination.dev!==destinationStat.dev||finalDestination.ino!==destinationStat.ino||await realpath(directory)!==directory)throw Error();
     destinationBinding={path:directory,dev:destinationStat.dev,ino:destinationStat.ino};
     check();
     const preflight=await preflightArchiveDirectory(directory,()=>{try{check();return true;}catch{return false;}},options.archivePreflightIO);
     if(preflight==="cleanup-unconfirmed"){result.cleanupConfirmed=false;}
     else if(preflight!=="supported"){result.status=preflight==="unsupported"?"destination-unsupported":preflight;}
     else {
      check();host=createProbeHost();check();
      const intent=Object.freeze({requestId:randomUUID(),filmId:randomUUID(),taskId:request.taskId,executionId:randomUUID(),expectedRevision:request.revision,version,title,directory,owner:Object.freeze({...host.owner}),fingerprint:Object.freeze({bytes:input.evidence.bytes,sha256:input.evidence.sha256})});
      // Construct exact fingerprint schema, never forward intake flags/paths into persistence.
      const bound=intent;
      const run=await createVerifiedLocalImport({database,stagingParent,registry:host.registry,probe:host.probe,stopProbe:host.stop});
      const value=await run(input,host.owner,bound,current,signal);applyFacts(value);result.status=value.status==="not-started"?"stale":value.status==="unconfirmed"?"failed":"settled";
     }
    }
   }
  }catch{result.status=active&&!signal.aborted?"failed":"stale";}
  finally{
   controller.abort();
   if(host){let timer:ReturnType<typeof setTimeout>|undefined;
    try{const expires=performance.now()+1000;
     const stopped=await Promise.race([Promise.resolve().then(()=>host!.stop()).then(value=>value===true,()=>false),new Promise<boolean>(done=>{timer=setTimeout(()=>done(false),1000);})]);
     if(!stopped||performance.now()>=expires)result.cleanupConfirmed=false;
    }catch{result.cleanupConfirmed=false;}finally{if(timer!==undefined)clearTimeout(timer);}
   }
   try{await input?.close();}catch{result.cleanupConfirmed=false;}
   if(!result.cleanupConfirmed)result.status="cleanup-unconfirmed";
   outerSignal?.removeEventListener("abort",cancel);running=false;controller=undefined;
  }
  return Object.freeze({...result});
 }});
}
