import { createHash } from "node:crypto";
import { isAbsolute, join, parse, resolve } from "node:path";
import { z } from "zod";
import { lstat, realpath } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import type { ApplicationDatabase } from "../infrastructure/database";
import { commitLocalFilmRecord, readLocalFilmRecord } from "../infrastructure/local-film-record";
import { createRegisteredVideoLookup } from "../infrastructure/registered-video-source";
import type { RegisteredVideoSource } from "./registered-video-response";
import { buildVideoBasename, MAX_VIDEO_TITLE_UNITS } from "../../shared/video-basename";
import { MAX_VIDEO_WRITE_BYTES } from "../infrastructure/video-byte-writer";
import { archiveStagedVideo, type StagedVideoArchiveResult } from "./archive-staged-video";

const uuid=z.string().uuid().regex(/^[0-9a-f-]+$/);
const schema=z.object({requestId:uuid,filmId:uuid,taskId:uuid,executionId:uuid,
 expectedRevision:z.number().int().nonnegative().safe(),version:z.number().int().positive().safe(),title:z.string().max(MAX_VIDEO_TITLE_UNITS),
 directory:z.string().refine(value=>isAbsolute(value)&&resolve(value)===value&&parse(value).root!==value),
 owner:z.object({ownerId:z.number().int().nonnegative().safe(),documentId:uuid}).strict(),
 fingerprint:z.object({bytes:z.number().int().positive().max(MAX_VIDEO_WRITE_BYTES),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),
}).strict();
type Binding=z.infer<typeof schema>;
type Snapshot=Parameters<typeof archiveStagedVideo>[0]["snapshot"];
type Capability=Readonly<{kind:"bound-local-archive-evidence"}>;
type Proof={binding:Readonly<Binding>;hash:string;archive:StagedVideoArchiveResult;current:()=>boolean};
const hash=(binding:Binding)=>createHash("sha256").update(JSON.stringify(binding)).digest("hex");
const current=(check:()=>boolean,signal?:AbortSignal)=>{try{
 if(signal?.aborted)return false;const answer:unknown=check();
 if(answer instanceof Promise)void answer.catch(()=>undefined);
 return answer===true&&!signal?.aborted;
}catch{return false;}};

/** One main-only write attempt per recorder. Capabilities are process-local object identities, not
 * serializable receipts, schema migrations or SQL authorization. Never install this in renderer IPC.
 * A later persistence port MUST independently recheck the physical file and authoritative DB rows. */
export function createBoundArchiveRecorder(){
 const proofs=new WeakMap<object,Proof>();let active=true,claimed=false;
 let boundDatabase:ApplicationDatabase|undefined;
 const resolveProof=(capability:unknown,expected:unknown):Proof|null=>{
   if(!active||typeof capability!=="object"||capability===null)return null;
   const proof=proofs.get(capability);if(!proof)return null;
   if(!proof.current()){proofs.delete(capability);return null;}
   try{if(hash(schema.parse(expected))!==proof.hash)return null;}catch{return null;}
   if(!active||proofs.get(capability)!==proof)return null;
   if(!proof.current()){proofs.delete(capability);return null;}
   return active&&proofs.get(capability)===proof?proof:null;
 };
 const verifyPhysical=async(capability:unknown,expected:unknown)=>{
   const unavailable=()=>Object.freeze({status:"unavailable" as const,writeAuthorized:false as const,databaseCompleted:false as const,mediaPlaybackAuthorized:false as const});
   const proof=resolveProof(capability,expected);if(!proof)return unavailable();
   const identity=proof.archive.receipt?.publishedIdentity;if(!identity)return unavailable();
   const binding=proof.binding;
   const checkParent=async()=>{const stat=await lstat(binding.directory);return stat.isDirectory()&&!stat.isSymbolicLink()
    &&stat.dev===identity.parentDev&&stat.ino===identity.parentIno&&await realpath(binding.directory)===binding.directory;};
   const checkFile=async()=>{const stat=await lstat(proof.archive.receipt!.target);return stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1
    &&stat.dev===identity.dev&&stat.ino===identity.ino&&stat.size===identity.size
    &&stat.mtimeMs===identity.mtimeMs&&stat.ctimeMs===identity.ctimeMs;};
   let source:RegisteredVideoSource|null=null;
   try{
    if(!await checkParent()||!await checkFile()||resolveProof(capability,expected)!==proof)return unavailable();
    const lookup=await createRegisteredVideoLookup(binding.directory,[{id:binding.filmId,
     identity:{taskId:binding.taskId,executionId:binding.executionId,version:binding.version,title:binding.title},
     dev:identity.dev,ino:identity.ino,bytes:binding.fingerprint.bytes,sha256:binding.fingerprint.sha256}]);
    source=await lookup(binding.filmId);
    if(!source)return unavailable();
    await source.close();source=null;
    if(!await checkParent()||!await checkFile()||resolveProof(capability,expected)!==proof)return unavailable();
    return Object.freeze({status:"verified" as const,binding:proof.binding,requestHash:proof.hash,
     publicationIdentity:identity,physicalFileRechecked:true as const,writeAuthorized:false as const,
     databaseCompleted:false as const,mediaPlaybackAuthorized:false as const});
   }catch{return unavailable();}
   finally{if(source)try{await source.close();}catch{/* Verification never succeeds on a failed close. */}}
  };
 return Object.freeze({
  async write(raw:unknown,snapshot:Snapshot,isCurrent:()=>boolean,signal?:AbortSignal):Promise<Readonly<{
   status:"refused"|"archive-settled";archive:StagedVideoArchiveResult|null;capability:Capability|null;
  }>>{
   const refuse=()=>Object.freeze({status:"refused" as const,archive:null,capability:null});
   if(!active||claimed)return refuse();claimed=true;
   let binding:Binding;
   try{binding=schema.parse(raw);if(snapshot.fingerprint.bytes!==binding.fingerprint.bytes||snapshot.fingerprint.sha256!==binding.fingerprint.sha256)throw Error();}
   catch{return refuse();}
   Object.freeze(binding.owner);Object.freeze(binding.fingerprint);Object.freeze(binding);
   const requestHash=hash(binding),open=snapshot.open;
   const live=()=>{if(!active)return false;const verdict=current(isCurrent,signal);return active&&verdict;};
   if(!live())return refuse();
   let archive:StagedVideoArchiveResult;
   // No injected writer: evidence can only originate around this actual exclusive-write path.
   archive=await archiveStagedVideo({directory:binding.directory,identity:{taskId:binding.taskId,executionId:binding.executionId,version:binding.version,title:binding.title},
    snapshot:{fingerprint:binding.fingerprint,open:()=>open.call(snapshot)},isCurrent:live,signal});
   const receipt=archive.receipt;
   let capability:Capability|null=null;
   if(archive.status==="settled"&&archive.currentAtReturn&&archive.sourceCleanupConfirmed&&live()
    &&receipt?.status==="published"&&receipt.reason==="VERIFIED_BYTES_PUBLISHED"&&receipt.cleanup==="removed"&&receipt.temporary===null
    &&receipt.target===join(binding.directory,buildVideoBasename({taskId:binding.taskId,executionId:binding.executionId,version:binding.version,title:binding.title}))){
    capability=Object.freeze({kind:"bound-local-archive-evidence" as const});
    proofs.set(capability,{binding,hash:requestHash,archive,current:live});
   }
   return Object.freeze({status:"archive-settled",archive,capability});
  },
  inspect(capability:unknown,expected:unknown){
   const proof=resolveProof(capability,expected);if(!proof)return null;
   return Object.freeze({binding:proof.binding,requestHash:proof.hash,target:proof.archive.receipt!.target,
    publicationObserved:true as const,physicalFileRechecked:false as const,writeAuthorized:false as const,
    databaseCompleted:false as const,mediaPlaybackAuthorized:false as const});
  },
  verifyPhysical,
  /** Trusted app-owned V7 DB only when a future host explicitly wires it. Hash outside SQL,
   * then a short synchronous identity/lease guard inside SQL. No filesystem rollback/retry. */
  async commitToWorkspace(database:ApplicationDatabase,capability:unknown,expected:unknown){
   const refused=()=>Object.freeze({status:"recording-unconfirmed" as const,automaticRetry:false as const,mediaPlaybackAuthorized:false as const});
   const proof=resolveProof(capability,expected);if(!proof)return refused();
   // First trusted host-selected connection fixes this epoch; never carry a live capability to another DB object.
   if(boundDatabase&&boundDatabase!==database)return refused();
   boundDatabase=database;
   const verified=await verifyPhysical(capability,expected);
   if(verified.status!=="verified"||resolveProof(capability,expected)!==proof)return refused();
   const identity=proof.archive.receipt!.publishedIdentity!,target=proof.archive.receipt!.target;
   const finalGuard=()=>{try{
    if(resolveProof(capability,expected)!==proof)return false;
    const parent=lstatSync(proof.binding.directory),file=lstatSync(target);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.dev!==identity.parentDev||parent.ino!==identity.parentIno
     ||realpathSync(proof.binding.directory)!==proof.binding.directory||!file.isFile()||file.isSymbolicLink()||file.nlink!==1
     ||file.dev!==identity.dev||file.ino!==identity.ino||file.size!==identity.size||file.mtimeMs!==identity.mtimeMs||file.ctimeMs!==identity.ctimeMs
     ||realpathSync(target)!==target)return false;
    // No caller getter/lease callback after the final synchronous filesystem observation.
    return active&&proofs.get(capability as object)===proof;
   }catch{return false;}};
   try{return Object.freeze({...commitLocalFilmRecord(database,proof.binding,{target,requestHash:proof.hash},finalGuard),automaticRetry:false as const,mediaPlaybackAuthorized:false as const});}
   catch{return refused();}
  },
  /** Read prior metadata only; restored receipts never recreate the private capability or a write. */
  readRecordedMetadata(database:ApplicationDatabase,expected:unknown){
   try{const binding=schema.parse(expected);return readLocalFilmRecord(database,binding,{requestHash:hash(binding),target:join(binding.directory,buildVideoBasename({taskId:binding.taskId,executionId:binding.executionId,version:binding.version,title:binding.title}))});}
   catch{return null;}
  },
  revoke(capability:object){proofs.delete(capability);},
  close(){active=false;},
 });
}
