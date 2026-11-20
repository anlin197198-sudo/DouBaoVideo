import type { BrowserWindow,IpcMainInvokeEvent,WebFrameMain } from "electron";
import { z } from "zod";
import type { LocalImportCommandResult } from "../application/local-import-command";
const requestSchema=z.object({taskId:z.string().uuid().regex(/^[0-9a-f-]+$/),revision:z.number().int().nonnegative().safe()}).strict();
const resultSchema=z.object({status:z.enum(["invalid-request","busy","cancelled","stale","failed","destination-unsupported","settled","cleanup-unconfirmed"]),
 archiveStatus:z.enum(["none","not-published","published","published-cleanup-failed","publication-uncertain"]),
 recordStatus:z.enum(["none","recorded","prior-recorded","recording-unconfirmed"]),cleanupConfirmed:z.boolean(),automaticRetry:z.literal(false),mediaPlaybackAuthorized:z.literal(false)});
export interface LocalImportRouteOptions {
 window:BrowserWindow;mainFrame:WebFrameMain;epoch:number;getEpoch:()=>number;rendererURL:string;enabled?:boolean;
 command?:{run(raw:unknown,signal?:AbortSignal):Promise<Readonly<LocalImportCommandResult>>;close():void};
}
type Event=Pick<IpcMainInvokeEvent,"sender"|"senderFrame">;
const blocked=(status:"stale"|"invalid-request"|"busy")=>({status,archiveStatus:"none" as const,recordStatus:"none" as const,cleanupConfirmed:true,automaticRetry:false as const,mediaPlaybackAuthorized:false as const});
const uncertain=()=>({status:"cleanup-unconfirmed" as const,archiveStatus:"publication-uncertain" as const,recordStatus:"recording-unconfirmed" as const,cleanupConfirmed:false,automaticRetry:false as const,mediaPlaybackAuthorized:false as const});
/** Dormant main-only bridge. No IPC registration, preload exposure, configuration discovery or
 * startup activation. Only a trusted host may enable and supply a bound command. Default OFF.
 * Await the command after abort: publication may already have happened and cannot be retracted. */
export function createLocalImportRoute(options:LocalImportRouteOptions){
 const {window,mainFrame,epoch,getEpoch,rendererURL,command}=options;
 const contents=window.webContents,enabled=options.enabled===true;let active=true,busy=false;
 const controllers=new Set<AbortController>();
 const subscriptions:Array<{remove:()=>void}>=[];
 const origin=()=>{try{return active&&!window.isDestroyed()&&!contents.isDestroyed()&&window.webContents===contents&&contents.mainFrame===mainFrame&&mainFrame.url===rendererURL&&getEpoch()===epoch&&active;}catch{return false;}};
 const authorized=(event:Event)=>{try{return enabled&&!!command&&origin()&&event.sender===contents&&event.senderFrame===mainFrame&&origin();}catch{return false;}};
 const close=()=>{if(!active)return;active=false;for(const controller of controllers)controller.abort();try{command?.close();}catch{/* Outcome must be obtained by awaiting any in-flight run. */}for(const subscription of subscriptions)try{subscription.remove();}catch{}};
 if(!Number.isSafeInteger(epoch)||epoch<0||typeof rendererURL!=="string"||!rendererURL||!origin())active=false;
 if(enabled&&command&&active){
  const bind=(emitter:{on:(name:string,listener:()=>void)=>unknown;removeListener:(name:string,listener:()=>void)=>unknown},name:string)=>{emitter.on(name,close);subscriptions.push({remove:()=>{emitter.removeListener(name,close);}});};
  try{bind(window as unknown as Parameters<typeof bind>[0],"closed");for(const name of ["did-start-navigation","did-navigate-in-page","render-process-gone","destroyed"])bind(contents as unknown as Parameters<typeof bind>[0],name);}catch{close();}
 }
 return Object.freeze({readiness(event:Event){return Object.freeze({available:authorized(event)});},close,
  async run(event:Event,raw:unknown){
   if(!authorized(event))return Object.freeze({...blocked("stale"),contextCurrent:false});
   if(busy)return Object.freeze({...blocked("busy"),contextCurrent:origin()});
   busy=true;
   let request:z.infer<typeof requestSchema>;try{request=requestSchema.parse(raw);Object.freeze(request);}catch{busy=false;return Object.freeze({...blocked("invalid-request"),contextCurrent:origin()});}
   if(!authorized(event)){busy=false;return Object.freeze({...blocked("stale"),contextCurrent:false});}
   const controller=new AbortController();controllers.add(controller);busy=true;
   let result:LocalImportCommandResult;
   try{const rawResult=await command!.run(request,controller.signal);result=resultSchema.parse(rawResult);}
   catch{result=uncertain();}
   finally{controllers.delete(controller);busy=false;}
   return Object.freeze({...result,contextCurrent:authorized(event)});
  }
 });
}
