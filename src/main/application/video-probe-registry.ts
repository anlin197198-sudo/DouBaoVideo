import { randomUUID } from "node:crypto";
import { z } from "zod";
import { registeredVideoResponse, type RegisteredVideoSource } from "./registered-video-response";
const ownerSchema=z.object({ownerId:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),documentId:z.string().uuid().regex(/^[0-9a-f-]+$/)}).strict();
const fingerprintSchema=z.object({sha256:z.string().regex(/^[0-9a-f]{64}$/),bytes:z.number().int().positive().max(8*1024**3)}).strict();
const issueSchema=ownerSchema.extend({fingerprint:fingerprintSchema}).strict();
export type VideoProbeOwner=z.infer<typeof ownerSchema>;
export type VideoProbeFingerprint=z.infer<typeof fingerprintSchema>;
export type VideoProbeAcquire=()=>Promise<{fingerprint:VideoProbeFingerprint;source:RegisteredVideoSource}>;
type Entry={owner:VideoProbeOwner;fingerprint:VideoProbeFingerprint;issuedAt:number;expiresAt:number;acquire:VideoProbeAcquire};
/** Ephemeral main-only tokens, no native scheme wiring. Host must derive requester window AND
 * unique never-reused current-document identity, never trust renderer-supplied identity. Host must
 * invalidate on navigation/reload/close. expiresAt is a process-local monotonic deadline, not a date.
 * acquire is a trusted staging accessor (no arbitrary renderer paths) that
 * independently verifies exact bytes/hash and returns an owned source, not a path.
 * Byte verification is NOT decoder verification or player readiness.
 * Revocation blocks new acquisitions; it does NOT terminate already transferred response streams. */
export class VideoProbeRegistry {
 #entries=new Map<string,Entry>(); #now:()=>number; #ttl:number;
 constructor(private readonly options:{isLive:(ownerId:number,documentId:string)=>boolean;now?:()=>number;ttlMs?:number}){
  this.#now=options.now??(()=>performance.now());this.#ttl=options.ttlMs??30000;
  if(!Number.isFinite(this.#ttl)||this.#ttl<=0||this.#ttl>120000)throw new Error("无效的临时预览配置。");
 }
 #time(){const value=this.#now();if(!Number.isFinite(value)||value<0)throw new Error("临时预览不可用。");return value;}
 #valid(id:string,entry:Entry,owner:VideoProbeOwner){const now=this.#time();if(now<entry.issuedAt||now>=entry.expiresAt){this.#entries.delete(id);return false;}return this.#entries.get(id)===entry&&entry.owner.ownerId===owner.ownerId&&entry.owner.documentId===owner.documentId&&this.options.isLive(owner.ownerId,owner.documentId)===true;}
 issue(raw:unknown,acquire:VideoProbeAcquire){try{
  const parsed=issueSchema.parse(raw),now=this.#time();
  for(const [id,entry] of this.#entries)if(now>=entry.expiresAt||now<entry.issuedAt)this.#entries.delete(id);
  if(this.#entries.size>=128||typeof acquire!=="function"||!this.options.isLive(parsed.ownerId,parsed.documentId)||!Number.isFinite(now+this.#ttl))throw Error();
  const id=randomUUID(),expiresAt=now+this.#ttl;
  this.#entries.set(id,{owner:Object.freeze({ownerId:parsed.ownerId,documentId:parsed.documentId}),fingerprint:Object.freeze({...parsed.fingerprint}),issuedAt:now,expiresAt,acquire});
  return Object.freeze({id,url:`app://video/${id}`,expiresAt});
 }catch{throw new Error("无法创建临时视频预览。");}}
 /** Main-only freshness query for accepting a native result, never extends a capability. */
 accepts(id:string,rawOwner:unknown):boolean{
  try{const owner=ownerSchema.parse(rawOwner),entry=this.#entries.get(id);return !!entry&&this.#valid(id,entry,owner);}
  catch{return false;}
 }
 revoke(id:string){this.#entries.delete(id);}
 invalidateOwner(ownerId:number){for(const [id,entry] of this.#entries)if(entry.owner.ownerId===ownerId)this.#entries.delete(id);}
 async response(request:Pick<Request,"url"|"method"|"headers">,rawOwner:unknown):Promise<Response>{
  let owner:VideoProbeOwner;try{owner=ownerSchema.parse(rawOwner);}catch{return new Response(null,{status:404,headers:{"Cache-Control":"no-store"}});}
  return registeredVideoResponse(request,async id=>{
   const entry=this.#entries.get(id);let source:RegisteredVideoSource|null=null;
   try{
    if(!entry||!this.#valid(id,entry,owner))return null;
    const acquired=await entry.acquire();source=acquired.source;
    const fp=fingerprintSchema.parse(acquired.fingerprint);
    if(!this.#valid(id,entry,owner)||fp.sha256!==entry.fingerprint.sha256||fp.bytes!==entry.fingerprint.bytes||source.byteLength!==fp.bytes)throw Error();
    const acquiredSource=source;
    // lookup resolution is not stream transfer: recheck after the outer await too.
    const guard=()=>{if(!this.#valid(id,entry,owner))throw new Error("临时预览不可用。");};
    const wrapped:RegisteredVideoSource={get byteLength(){guard();return acquiredSource.byteLength;},stream:(start,end)=>{guard();return acquiredSource.stream(start,end);},close:()=>acquiredSource.close()};
    source=null;return wrapped;
   }catch{return null;}finally{if(source)try{await source.close();}catch{/* Fixed unavailable response only. */}}
  });
 }
}
