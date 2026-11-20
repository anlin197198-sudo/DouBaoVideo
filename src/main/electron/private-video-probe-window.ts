import { randomUUID } from "node:crypto";
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import type { VideoProbeOwner } from "../application/video-probe-registry";
type ProbeWindow=Pick<BrowserWindow,"webContents"|"loadURL"|"isDestroyed"|"destroy"|"on">;
export interface PrivateProbeWindowOptions {
 electron:{session:Pick<typeof import("electron").session,"fromPartition">;BrowserWindow:new(options:BrowserWindowConstructorOptions)=>ProbeWindow};
 probeId:string;signal?:AbortSignal;
 /** Trusted host installs ONE composed page/video handler before load. Must restrict resource
  * requests to this session/document, deny other routes/network and return owned cleanup.
  * No competing call to the video-only installer. No renderer-supplied callback. */
 installRoutes(context:{session:Session;owner:Readonly<VideoProbeOwner>;window:ProbeWindow;verifyBinding:()=>boolean;probeId:string}):{teardown:()=>{unhandled:boolean}};
}
const usedSessions=new WeakSet<object>();
/** Dormant callable factory; no index/global-scheme wiring. Injected Electron only, no runtime
 * electron import. Session exclusivity requires host not to reuse the returned session elsewhere.
 * Window closure is not proof of Chromium network/session quiescence or data deletion. */
export function reservePrivateVideoProbeWindow(options:Pick<PrivateProbeWindowOptions,"electron"|"signal">&{reservationMs?:number}){
 const signal=options.signal,reservationMs=options.reservationMs??15000;
 if(!Number.isSafeInteger(reservationMs)||reservationMs<1||reservationMs>15000||signal?.aborted)throw new Error("临时视频检查未启动。");
 let timer:ReturnType<typeof setTimeout>|undefined;
 let window:ProbeWindow|null=null,routes:{teardown:()=>{unhandled:boolean}}|null=null,active=true,cleaned=false,closing=false;
 let routeCleanup:"pending"|"completed"|"failed"="pending";
 const close=()=>{active=false;if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener("abort",abort);
  if(!cleaned&&routes){cleaned=true;try{routeCleanup=routes.teardown().unhandled===true?"completed":"failed";}catch{routeCleanup="failed";}}
  let closed=false;if(!closing){closing=true;try{if(window&&!window.isDestroyed())window.destroy();closed=!window||window.isDestroyed();}catch{closed=false;}finally{closing=false;}}else{try{closed=!window||window.isDestroyed();}catch{closed=false;}}
  return Object.freeze({active:false,windowClosed:closed,routeCleanup});
 };
 const abort=()=>{close();};
 try{
  const session=options.electron.session.fromPartition(`doubao-video-probe-${randomUUID()}`,{cache:false});
  if(session.isPersistent()||session.getStoragePath()!==null||usedSessions.has(session))throw Error();usedSessions.add(session);
  session.setPermissionCheckHandler(()=>false);session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  window=new options.electron.BrowserWindow({show:false,width:480,height:320,webPreferences:{session,sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:false}});
  const own=window,contents=own.webContents,owner=Object.freeze({ownerId:contents.id,documentId:randomUUID()});
  let loaded=false,page:string|null=null,claimed=false;
  const verifyBinding=()=>{try{return active&&!own.isDestroyed()&&!contents.isDestroyed()&&own.webContents===contents&&contents.session===session&&(!loaded||contents.getURL()===page);}catch{return false;}};
  if(!Number.isSafeInteger(owner.ownerId)||owner.ownerId<0||!verifyBinding())throw Error();
  contents.setWindowOpenHandler(()=>({action:"deny"}));
  const deny=(event:{preventDefault:()=>void})=>{event.preventDefault();close();};
  contents.on("will-navigate",deny);contents.on("will-frame-navigate",deny);contents.on("will-redirect",deny);
  contents.on("did-navigate",(_event,url)=>{if(url!==page)close();});
  contents.on("did-navigate-in-page",()=>close());
  contents.on("render-process-gone",()=>close());contents.on("destroyed",()=>close());own.on("closed",()=>close());
  let started=false;
  contents.on("did-start-navigation",(_event,url,_inPlace,isMainFrame)=>{if(!isMainFrame)return;if(started||url!==page){close();return;}started=true;});
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)throw Error();
  timer=setTimeout(()=>close(),reservationMs);timer.unref();
  return Object.freeze({owner,isLive:verifyBinding,close,
   async loadProbe(probeId:string,installRoutes:PrivateProbeWindowOptions["installRoutes"]):Promise<void>{
    if(claimed||!verifyBinding())throw new Error("临时视频检查不可重复启动。");claimed=true;
    try{
     if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(probeId))throw Error();
     page=`app://video-probe/f17-video-probe.html#${probeId}`;
     routeCleanup="failed";
     routes=installRoutes({session,owner,window:own,verifyBinding,probeId});
     if(!routes||typeof routes.teardown!=="function"||!verifyBinding())throw Error();
     routeCleanup="pending";
     await own.loadURL(page);loaded=true;
     if(!verifyBinding())throw Error();
    }catch{const result=close();throw new Error(result.windowClosed?(result.routeCleanup==="failed"?"临时视频检查失败，窗口已关闭，路由清理未确认。":"临时视频检查未能启动，专用窗口已关闭。"):"临时视频检查失败，专用窗口关闭未确认。");}
   }
  });
 }catch{const result=close();throw new Error(result.windowClosed?(result.routeCleanup==="failed"?"临时视频检查失败，窗口已关闭，路由清理未确认。":"临时视频检查未能启动，专用窗口已关闭。"):"临时视频检查失败，专用窗口关闭未确认。");}
}

/** Compatibility one-shot helper. New hosts reserve first, issue for that exact owner, then load. */
export async function createPrivateVideoProbeWindow(options:PrivateProbeWindowOptions){
 const probeId=options.probeId,installRoutes=options.installRoutes;
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(probeId))throw new Error("临时视频检查未启动。");
 const reservation=reservePrivateVideoProbeWindow(options);
 await reservation.loadProbe(probeId,installRoutes);
 return Object.freeze({owner:reservation.owner,url:`app://video-probe/f17-video-probe.html#${probeId}`,isLive:reservation.isLive,close:reservation.close});
}
