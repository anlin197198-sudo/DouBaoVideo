import type { Session } from "electron";
import type { VideoProbeOwner, VideoProbeRegistry } from "../application/video-probe-registry";
type PrivateSession=Pick<Session,"isPersistent"|"getStoragePath">&{protocol:Pick<Session["protocol"],"isProtocolHandled"|"handle"|"unhandle">};
const usedSessions=new WeakSet<object>(),usedProtocols=new WeakSet<object>();
const canonical=/^app:\/\/video\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type ProbeBuiltAssetLoader=(request:Readonly<Pick<Request,"url"|"method">>)=>Response|null|Promise<Response|null>;
const builtAsset=/^app:\/\/video-probe(\/f17-video-probe\.html|\/assets\/[A-Za-z0-9_-]+\.js)$/;
const denied=()=>new Response(null,{status:404,headers:{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
/** Host MUST create one fresh private in-memory session exclusively for one window/document,
 * never defaultSession and never shared by other windows. Only host can prove exclusivity;
 * request URLs do not authenticate a requester. Document IDs must never be reused. No session,
 * window, global scheme privileges or default protocol is created/changed by this adapter.
 * Optional loader is a trusted verified build-asset reader, never a network/path passthrough.
 * It owns safe MIME/CSP/no-store headers and bodyless HEAD. One app handler dispatches page,
 * allowlisted JavaScript and token video; absent loader retains video-only behavior.
 * Teardown blocks pending/new reads but cannot retract streams already returned to Chromium. */
export function installPrivateVideoProbeProtocol(options:{session:PrivateSession;owner:VideoProbeOwner;registry:VideoProbeRegistry;verifyExclusiveBinding:(session:PrivateSession,owner:Readonly<VideoProbeOwner>)=>boolean;loadBuiltAsset?:ProbeBuiltAssetLoader}){
 const {session,registry,loadBuiltAsset}=options;let protocol:PrivateSession["protocol"],owner:Readonly<VideoProbeOwner>;
 try{
  owner=Object.freeze({ownerId:options.owner.ownerId,documentId:options.owner.documentId});protocol=session.protocol;
  if(!Number.isSafeInteger(owner.ownerId)||owner.ownerId<0||typeof owner.documentId!=="string"||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(owner.documentId)||session.isPersistent()!==false||session.getStoragePath()!==null||usedSessions.has(session)||usedProtocols.has(protocol)||protocol.isProtocolHandled("app")!==false||options.verifyExclusiveBinding(session,owner)!==true)throw Error();
 }catch{throw new Error("无法建立独占临时视频协议。");}
 // Burn identities even if handle throws: uncertain native installation must never be rebound.
 usedSessions.add(session);usedProtocols.add(protocol);
 let active=true;
 const valid=()=>{try{return active&&session.protocol===protocol&&session.isPersistent()===false&&session.getStoragePath()===null&&options.verifyExclusiveBinding(session,owner)===true;}catch{return false;}};
 try{protocol.handle("app",async request=>{
  if(!valid()||(request.method!=="GET"&&request.method!=="HEAD"))return denied();
  const video=canonical.test(request.url),asset=builtAsset.exec(request.url)?.[1];
  if(!video&&(!asset||!loadBuiltAsset))return denied();
  let response:Response|null=null;
  try{response=video?await registry.response(request,owner):await loadBuiltAsset!(Object.freeze({url:request.url,method:request.method}));if(!response)return denied();if(!valid()){await response.body?.cancel().catch(()=>undefined);return denied();}return response;}
  catch{await response?.body?.cancel().catch(()=>undefined);return denied();}
 });}catch{active=false;registry.invalidateOwner(owner.ownerId);throw new Error("临时视频协议安装结果未确认。");}
 let outcome:Readonly<{active:false;unhandled:boolean;reason:"UNHANDLED"|"UNHANDLE_FAILED"}>|null=null;
 return Object.freeze({teardown(){if(outcome)return outcome;active=false;registry.invalidateOwner(owner.ownerId);
  try{protocol.unhandle("app");outcome=Object.freeze({active:false,unhandled:true,reason:"UNHANDLED"});}
  catch{outcome=Object.freeze({active:false,unhandled:false,reason:"UNHANDLE_FAILED"});}
  return outcome;
 }});
}
