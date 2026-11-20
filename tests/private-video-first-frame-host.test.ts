import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateVideoFirstFrameHost, createPrivateVideoDecodeInspector } from "../src/main/electron/private-video-first-frame-host";
import type { PrivateProbeWindowOptions } from "../src/main/electron/private-video-probe-window";
import type { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
const evidence={durationSeconds:1,videoWidth:16,videoHeight:16,width:16,height:16,mediaTime:0,presentedFrames:1};
function fixture(t:{after:(fn:()=>void)=>unknown}) {
 const root=mkdtempSync(join(tmpdir(),"dv-host-")),renderer=join(root,"renderer"),stage=join(root,"stage");
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(renderer);mkdirSync(stage);mkdirSync(join(renderer,"assets"));
 const files=[{file:"f17-video-probe.html",text:'<!doctype html><script type="module" src="./assets/f17-video-probe-ABCD1234.js"></script>'},{file:"assets/f17-video-probe-ABCD1234.js",text:"void 0;"}];
 for(const f of files)writeFileSync(join(renderer,f.file),f.text);
 writeFileSync(join(renderer,"f17-video-probe-assets.json"),JSON.stringify({version:1,entry:files[1]!.file,resources:files.map(f=>({file:f.file,size:Buffer.byteLength(f.text),sha256:createHash("sha256").update(f.text).digest("hex")}))}));
 let handler:(request:Request)=>Promise<Response>,installed=0,closed=0,created=0,failDestroy=false,hang=false;
 const session={isPersistent:()=>false,getStoragePath:()=>null,setPermissionCheckHandler:()=>{},setPermissionRequestHandler:()=>{},protocol:{isProtocolHandled:()=>false,handle:(_name:string,fn:typeof handler)=>{installed++;handler=fn;},unhandle:()=>{closed++;}}};
 let current:Window;
 class Window extends EventEmitter {
  dead=false;url="";
  webContents=Object.assign(new EventEmitter(),{id:91,session,isDestroyed:()=>this.dead,getURL:()=>this.url,setWindowOpenHandler:()=>{},executeJavaScript:async(code:string,userGesture:boolean)=>{assert.equal(code,"globalThis.__doubaoF17ProbeResult ?? null");assert.equal(userGesture,false);if(hang)return new Promise(()=>{});return {status:"first-presented-frame",evidence};}});
  constructor(){super();current=this;created++;}
  async loadURL(url:string){this.url=url;this.webContents.emit("did-start-navigation",{},url,false,true);assert.equal((await handler(new Request(url.split("#")[0]!))).status,200);const video=await handler(new Request(`app://video/${url.split("#")[1]}`));assert.equal(video.status,200);assert.deepEqual(Buffer.from(await video.arrayBuffer()),Buffer.from("synthetic bytes"));}
  isDestroyed(){return this.dead;}destroy(){if(failDestroy)throw Error();this.dead=true;this.emit("closed");}
 }
 const electron={session:{fromPartition:()=>session},BrowserWindow:Window} as unknown as PrivateProbeWindowOptions["electron"];
 const bytes=Buffer.from("synthetic bytes");let inputClosed=0;
 const input={evidence:{sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length,structureChecked:true,decoded:false},stream:async function*(){yield bytes;},close:async()=>{inputClosed++;}} as Awaited<ReturnType<typeof intakeMp4>>;
 return {electron,rendererDirectory:renderer,stagingParent:stage,input,bytes,get created(){return created;},get installed(){return installed;},get closed(){return closed;},get dead(){return current!.dead;},get inputClosed(){return inputClosed;},set failDestroy(v:boolean){failDestroy=v;},set hang(v:boolean){hang=v;}};
}
test("real composition reserves actual owner before token, serves pinned page/media and cleans before success",async t=>{
 const f=fixture(t),inspect=createPrivateVideoDecodeInspector(f);const result=await inspect(f.input);
 assert.equal(result.status,"first-frame-observed");assert.equal(f.created,1);assert.equal(f.installed,1);assert.equal(f.closed,1);assert.equal(f.dead,true);assert.equal(f.inputClosed,1);assert.deepEqual(readdirSync(f.stagingParent),[]);
});
test("host refuses foreign owner/URL and cancellation settles a hanging fixed result pull",async t=>{
 const f=fixture(t),host=createPrivateVideoFirstFrameHost(f),controller=new AbortController();
 assert.equal(await host.probe("https://example.invalid",host.owner,controller.signal),null);
 assert.equal(await host.probe(`app://video/${randomUUID()}`,{...host.owner,documentId:randomUUID()},controller.signal),null);assert.equal(f.installed,0);
 const fp={sha256:f.input.evidence.sha256,bytes:f.input.evidence.bytes};const token=host.registry.issue({...host.owner,fingerprint:fp},async()=>({fingerprint:fp,source:{byteLength:f.bytes.length,close:()=>{},stream:()=>new ReadableStream({start(c){c.enqueue(f.bytes);c.close();}})}}));
 f.hang=true;const pending=host.probe(token.url,host.owner,controller.signal);await new Promise(resolve=>setTimeout(resolve,10));controller.abort();assert.equal(await pending,null);assert.equal(await host.stop(),true);assert.equal(f.dead,true);
});
test("uncertain native destruction preserves stage and cannot report successful observation",async t=>{
 const f=fixture(t);f.failDestroy=true;const result=await createPrivateVideoDecodeInspector(f)(f.input);
 assert.equal(result.status,"cleanup-unconfirmed");assert.equal(f.inputClosed,1);assert.equal(readdirSync(f.stagingParent).length,1);
});
