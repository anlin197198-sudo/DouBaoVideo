import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { installPrivateVideoProbeProtocol,type ProbeBuiltAssetLoader } from "../src/main/electron/private-video-probe-protocol";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
function fixture(loader?:ProbeBuiltAssetLoader){let handler!:(r:Request)=>Response|Promise<Response>,handles=0,live=true;
 const owner={ownerId:3,documentId:randomUUID()},registry=new VideoProbeRegistry({isLive:()=>live});
 const session={isPersistent:()=>false,getStoragePath:()=>null,protocol:{isProtocolHandled:()=>false,handle:(_s:string,h:typeof handler)=>{handles++;handler=h;},unhandle:()=>{}}};
 const control=installPrivateVideoProbeProtocol({session,owner,registry,verifyExclusiveBinding:()=>live,loadBuiltAsset:loader});
 return {owner,registry,control,request:(url:string,method="GET")=>handler({url,method,headers:new Headers()} as Request),get handles(){return handles;},set live(value:boolean){live=value;}};
}
test("single handler dispatches exact built page/JS and registered video while rejecting unrelated URLs",async()=>{
 const calls:string[]=[];const f=fixture(async(request)=>{assert.ok(Object.isFrozen(request));const {url,method}=request;calls.push(`${method} ${url}`);return new Response(method==="HEAD"?null:"synthetic built asset",{headers:{"Cache-Control":"no-store"}});});
 for(const path of ["/f17-video-probe.html","/assets/f17-video-probe-a_12.js"]){assert.equal((await f.request(`app://video-probe${path}`)).status,200);assert.equal(await (await f.request(`app://video-probe${path}`,"HEAD")).text(),"");}
 assert.equal(f.handles,1);const before=calls.length;
 for(const url of ["app://video-probe/","app://video-probe/f17-video-probe.html?x","app://video-probe/f17-video-probe.html#x","app://video-probe/assets/a.js?x","app://video-probe/assets/a.css","app://video-probe/assets/../a.js","app://video-probe/assets/%61.js","app://video-probe/assets/sub/a.js","app://video-probe:42/assets/a.js","https://video-probe/assets/a.js","app://VIDEO-PROBE/assets/a.js"]){assert.equal((await f.request(url)).status,404);}
 assert.equal((await f.request("app://video-probe/assets/a.js","POST")).status,404);assert.equal(calls.length,before);
 const fp={sha256:"a".repeat(64),bytes:1};let closed=0;
 const token=f.registry.issue({...f.owner,fingerprint:fp},async()=>({fingerprint:fp,source:{byteLength:1,close:()=>{closed++;},stream:()=>new ReadableStream<Uint8Array<ArrayBuffer>>({start(c){c.enqueue(new Uint8Array([7]));c.close();}})}}));
 assert.equal((await f.request(token.url,"HEAD")).status,200);assert.equal(closed,1);assert.equal(calls.length,before);
 f.control.teardown();assert.equal((await f.request("app://video-probe/assets/a.js")).status,404);
});
test("loader is optional and failures never leak internal errors",async()=>{
 assert.equal((await fixture().request("app://video-probe/f17-video-probe.html")).status,404);
 for(const loader of [async()=>null,async()=>{throw Error("/private/build.js");}]){const response=await fixture(loader).request("app://video-probe/assets/a.js");assert.equal(response.status,404);assert.ok(!(await response.text()).includes("private"));}
});
test("deferred asset response is cancelled on teardown or lost exclusive binding before return",async()=>{
 for(const teardown of [true,false]){let release!:(r:Response)=>void,cancelled=0;const pendingAsset=new Promise<Response>(done=>release=done);const f=fixture(async()=>pendingAsset);
 const pending=f.request("app://video-probe/f17-video-probe.html");if(teardown)f.control.teardown();else f.live=false;
 release(new Response(new ReadableStream({cancel(){cancelled++;}},{highWaterMark:0})));
 assert.equal((await pending).status,404);assert.equal(cancelled,1);
 }
});
