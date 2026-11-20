import type { ApplicationDatabase } from "../infrastructure/database";
import type { intakeMp4 } from "../infrastructure/mp4-intake";
import { parseLocalFilmBinding } from "../infrastructure/local-film-record";
import { preflightFilmVersion } from "../infrastructure/film-version-preflight";
import { createVideoDecodePreparation } from "./prepare-video-decode";
import { createBoundArchiveRecorder } from "./bound-archive-evidence";
import type { StagedVideoArchiveResult } from "./archive-staged-video";
import type { VideoProbeOwner } from "./video-probe-registry";
type Recorder=ReturnType<typeof createBoundArchiveRecorder>;
type RecordResult=Awaited<ReturnType<Recorder["commitToWorkspace"]>>|ReturnType<Recorder["readRecordedMetadata"]>;
type Preparation=Awaited<ReturnType<Awaited<ReturnType<typeof createVideoDecodePreparation>>>>;
export interface VerifiedLocalImportResult {
 status:"not-started"|"prior-recorded"|"settled"|"unconfirmed"|"cleanup-unconfirmed";
 preparation:Preparation|null;archive:StagedVideoArchiveResult|null;record:RecordResult;
 automaticRetry:false;mediaPlaybackAuthorized:false;
}

/** Main-only explicit import composition, not an IPC route. The caller must provide the live,
 * app-owned V7 connection, trusted archive/stage roots and its actual private decoder owner.
 * A positive first frame is not whole-video decode or playback registration. */
export async function createVerifiedLocalImport(options: Parameters<typeof createVideoDecodePreparation>[0]&{database:ApplicationDatabase}){
 if(typeof options.stopProbe!=="function")throw new Error("本地导入必须确认专属探测停止。");
 const prepare=await createVideoDecodePreparation(options),database=options.database;
 let running=false,activeInput:Awaited<ReturnType<typeof intakeMp4>>|undefined;
 return async(input:Awaited<ReturnType<typeof intakeMp4>>,probeOwner:VideoProbeOwner,rawIntent:unknown,
  isCurrent:()=>boolean,signal?:AbortSignal):Promise<Readonly<VerifiedLocalImportResult>>=>{
  const recorder=createBoundArchiveRecorder();let delegated=false;
  let archive:StagedVideoArchiveResult|null=null,record:RecordResult=null;
  const flags={automaticRetry:false as const,mediaPlaybackAuthorized:false as const};
  if(running){
   if(input!==activeInput)try{await input.close();}catch{return Object.freeze({status:"cleanup-unconfirmed",preparation:null,archive,record,...flags});}
   return Object.freeze({status:"not-started",preparation:null,archive,record,...flags});
  }
  running=true;activeInput=input;
  try{
   const intent=parseLocalFilmBinding(rawIntent);
   // Intent records the actual private decoder document; initiating task liveness is a separate lease.
   const owner=Object.freeze({ownerId:probeOwner.ownerId,documentId:probeOwner.documentId});
   if(owner.ownerId!==intent.owner.ownerId||owner.documentId!==intent.owner.documentId)
    return Object.freeze({status:"not-started" as const,preparation:null,archive,record,...flags});
   const current=()=>{try{
    if(signal?.aborted)return false;
    const answer:unknown=isCurrent();if(answer instanceof Promise)void answer.catch(()=>undefined);
    if(answer!==true||signal?.aborted)return false;
    const task=database.connection.prepare("SELECT revision FROM tasks WHERE id=?").get(intent.taskId);
    return task?.revision===intent.expectedRevision;
   }catch{return false;}};
   if(database.version!==7||!current()||input.evidence.bytes!==intent.fingerprint.bytes||input.evidence.sha256!==intent.fingerprint.sha256)
    return Object.freeze({status:"not-started" as const,preparation:null,archive,record,...flags});
   if(database.connection.prepare("SELECT 1 FROM command_receipts WHERE request_id=?").get(intent.requestId)){
    record=recorder.readRecordedMetadata(database,intent);
    return Object.freeze({status:record?"prior-recorded" as const:"not-started" as const,preparation:null,archive,record,...flags});
   }
   const version=preflightFilmVersion(database.connection,{taskId:intent.taskId,expectedRevision:intent.expectedRevision});
   if(version.proposedVersion!==intent.version||database.connection.prepare("SELECT 1 FROM executions WHERE id=?").get(intent.executionId)
    ||database.connection.prepare("SELECT 1 FROM films WHERE id=?").get(intent.filmId))
    return Object.freeze({status:"not-started" as const,preparation:null,archive,record,...flags});
   delegated=true;
   const preparation=await prepare(input,owner,signal,undefined,{
    mode:"await-settlement",isCurrent:current,
    async settle(snapshot,effectSignal){
     // Recheck known version drift before publishing; SQL checks again after publication.
     if(!current()||preflightFilmVersion(database.connection,{taskId:intent.taskId,expectedRevision:intent.expectedRevision}).proposedVersion!==intent.version)
      return Object.freeze({archive,record});
     const written=await recorder.write(intent,snapshot,current,effectSignal);archive=written.archive;
     if(written.capability&&current()&&!effectSignal.aborted)
      record=await recorder.commitToWorkspace(database,written.capability,intent);
     return Object.freeze({archive,record});
    },
   });
   // Keep receipt/DB facts even when preparation reports late cancellation or cleanup failure.
   return Object.freeze({status:"settled" as const,preparation,archive,record,...flags});
  }catch{return Object.freeze({status:"unconfirmed" as const,preparation:null,archive,record,...flags});}
  finally{
   recorder.close();
   try{if(!delegated)await input.close();}
   catch{return Object.freeze({status:"cleanup-unconfirmed" as const,preparation:null,archive,record,...flags});}
   finally{running=false;activeInput=undefined;}
  }
 };
}
