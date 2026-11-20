import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { createPrivateVideoProbeWindow,reservePrivateVideoProbeWindow,type PrivateProbeWindowOptions } from "../src/main/electron/private-video-probe-window";
function fixture(){let configured:unknown,partition="",installed=false,teardowns=0,failDestroy=false,hold:Promise<void>|null=null;
 let permissionCheck:()=>boolean=()=>true,permissionRequest:(_c:unknown,_p:unknown,cb:(v:boolean)=>void)=>void=()=>{};
 const session={isPersistent:()=>false,getStoragePath:()=>null,setPermissionCheckHandler:(cb:()=>boolean)=>permissionCheck=cb,setPermissionRequestHandler:(cb:typeof permissionRequest)=>permissionRequest=cb};
 class Window extends EventEmitter {dead=false;contentsDead=false;url="";popup:()=>unknown=()=>null;webContents=Object.assign(new EventEmitter(),{id:43,session,getURL:()=>this.url,isDestroyed:()=>this.contentsDead,setWindowOpenHandler:(h:()=>unknown)=>this.popup=h});
 constructor(options:unknown){super();configured=options;current=this;}
 async loadURL(url:string){assert.equal(installed,true);this.url=url;this.webContents.emit("did-start-navigation",{},url,false,true);if(hold)await hold;}
 isDestroyed(){return this.dead;}destroy(){if(failDestroy)throw Error();this.dead=true;this.emit("closed");}
 }
 let current:Window;
 const options={probeId:randomUUID(),electron:{session:{fromPartition:(name:string)=>{partition=name;return session;}},BrowserWindow:Window},installRoutes:(context:{probeId:string;verifyBinding:()=>boolean})=>{assert.ok(context.verifyBinding());assert.equal(context.probeId,options.probeId);installed=true;return {teardown:()=>{teardowns++;return {unhandled:true};}};}} as unknown as PrivateProbeWindowOptions;
 return {options,session,get window(){return current!;},get configured(){return configured as {show:boolean;webPreferences:Record<string,unknown>};},get partition(){return partition;},get teardowns(){return teardowns;},set hold(v:Promise<void>){hold=v;},set failDestroy(v:boolean){failDestroy=v;},permissionCheck:()=>permissionCheck(),permissionRequest:()=>{let granted=true;permissionRequest(null,null,v=>granted=v);return granted;}};
}
test("factory creates private isolated hidden window, installs routes before fixed load and closes only its own window",async()=>{
 const f=fixture(),probe=await createPrivateVideoProbeWindow(f.options);assert.match(f.partition,/^doubao-video-probe-/);assert.ok(!f.partition.startsWith("persist:"));assert.equal(f.configured.show,false);
 assert.deepEqual({...f.configured.webPreferences,session:undefined},{session:undefined,sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,devTools:false});
 assert.equal(f.permissionCheck(),false);assert.equal(f.permissionRequest(),false);assert.deepEqual(f.window.popup(),{action:"deny"});assert.equal(probe.owner.ownerId,43);assert.equal(probe.isLive(),true);
 assert.equal(probe.close().windowClosed,true);assert.equal(probe.isLive(),false);probe.close();assert.equal(f.teardowns,1);
 await assert.rejects(createPrivateVideoProbeWindow(f.options));
});
test("reload, foreign navigation, in-page navigation and crash invalidate and destroy dedicated window",async()=>{
 for(const event of ["did-start-navigation","will-navigate","will-frame-navigate","will-redirect","did-navigate-in-page","render-process-gone"]){const f=fixture(),probe=await createPrivateVideoProbeWindow(f.options);let prevented=false;
 f.window.webContents.emit(event,{preventDefault(){prevented=true;}},probe.url,false,true);
 assert.equal(probe.isLive(),false);assert.equal(f.window.dead,true);assert.equal(f.teardowns,1);if(event.startsWith("will-"))assert.equal(prevented,true);
 }
});
test("abort during load cleans up, initial abort does not create, failures never claim closed",async()=>{
 const f=fixture(),controller=new AbortController();let release!:()=>void;f.hold=new Promise<void>(done=>release=done);
 const pending=createPrivateVideoProbeWindow({...f.options,signal:controller.signal});controller.abort();release();await assert.rejects(pending);assert.equal(f.window.dead,true);assert.equal(f.teardowns,1);
 const no=fixture();await assert.rejects(createPrivateVideoProbeWindow({...no.options,signal:controller.signal}));assert.equal(no.partition,"");
 const bad=fixture(),probe=await createPrivateVideoProbeWindow(bad.options);bad.failDestroy=true;assert.equal(probe.close().windowClosed,false);assert.equal(probe.isLive(),false);
 const persistent=fixture();persistent.session.isPersistent=()=>true;await assert.rejects(createPrivateVideoProbeWindow(persistent.options));
 const broken=fixture();await assert.rejects(createPrivateVideoProbeWindow({...broken.options,installRoutes:()=>{throw Error("private details");}}),/窗口已关闭，路由清理未确认/);assert.equal(broken.window.dead,true);
});

test("installer lifecycle interruption still tears down late returned routes exactly once",async()=>{
 const f=fixture();let cleaned=0;
 await assert.rejects(createPrivateVideoProbeWindow({...f.options,installRoutes:({window})=>{window.destroy();return {teardown:()=>{cleaned++;return {unhandled:true};}};}}));
 assert.equal(cleaned,1);assert.equal(f.window.dead,true);
 const g=fixture();const probe=await createPrivateVideoProbeWindow({...g.options,installRoutes:(context)=>{g.options.installRoutes(context);return {teardown:()=>({unhandled:false})};}});assert.equal(probe.close().routeCleanup,"failed");
});

test("two-phase reservation exposes original owner before any load and permits one token load only",async()=>{
 const f=fixture(),reserved=reservePrivateVideoProbeWindow(f.options);assert.equal(f.window.url,"");assert.equal(reserved.isLive(),true);const owner=reserved.owner;
 await reserved.loadProbe(f.options.probeId,context=>{assert.equal(context.owner,owner);return f.options.installRoutes(context);});
 assert.equal(reserved.owner,owner);assert.equal(f.window.url,`app://video-probe/f17-video-probe.html#${f.options.probeId}`);
 await assert.rejects(reserved.loadProbe(randomUUID(),f.options.installRoutes));assert.equal(f.window.url,`app://video-probe/f17-video-probe.html#${f.options.probeId}`);reserved.close();
});
test("unused reservation expiry and abort close the dedicated window and prohibit later load",async()=>{
 const f=fixture(),expired=reservePrivateVideoProbeWindow({...f.options,reservationMs:5});await new Promise(done=>setTimeout(done,20));assert.equal(expired.isLive(),false);assert.equal(f.window.dead,true);await assert.rejects(expired.loadProbe(f.options.probeId,f.options.installRoutes));assert.equal(f.teardowns,0);
 const g=fixture(),controller=new AbortController(),aborted=reservePrivateVideoProbeWindow({...g.options,signal:controller.signal});controller.abort();assert.equal(g.window.dead,true);await assert.rejects(aborted.loadProbe(g.options.probeId,g.options.installRoutes));
 const h=fixture(),premature=reservePrivateVideoProbeWindow(h.options);h.window.webContents.emit("did-start-navigation",{},"app://foreign/page",false,true);assert.equal(premature.isLive(),false);assert.equal(h.window.dead,true);
 for(const reservationMs of [0,15001,NaN])assert.throws(()=>reservePrivateVideoProbeWindow({...fixture().options,reservationMs}));
});
