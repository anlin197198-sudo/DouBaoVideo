import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { installPrivateVideoProbeProtocol } from "../src/main/electron/private-video-probe-protocol";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
function fixture(){let handler:((r:Request)=>Response|Promise<Response>)|null=null,unhandles=0,fail=false,live=true;
 const owner={ownerId:12,documentId:randomUUID()},registry=new VideoProbeRegistry({isLive:()=>live});
 const protocol={isProtocolHandled:()=>false,handle:(_scheme:string,h:(r:Request)=>Response|Promise<Response>)=>{handler=h;},unhandle:()=>{unhandles++;if(fail)throw Error("private path");}};
 const session={protocol,isPersistent:()=>false,getStoragePath:()=>null};
 return {owner,registry,session,options:{owner,registry,session,verifyExclusiveBinding:()=>live},get handler(){return handler!;},get unhandles(){return unhandles;},set fail(v:boolean){fail=v;},set live(v:boolean){live=v;}};
}
const fp={sha256:"a".repeat(64),bytes:3};
function source(){let closed=0,cancelled=0;return {get closed(){return closed;},get cancelled(){return cancelled;},value:{byteLength:3,close:()=>{closed++;},stream:()=>new ReadableStream<Uint8Array<ArrayBuffer>>({pull(c){c.enqueue(new Uint8Array([1,2,3]));c.close();closed++;},cancel(){cancelled++;closed++;}},{highWaterMark:0})}};}
test("private fixed owner protocol rejects foreign URLs/documents and burns session/protocol after teardown",async()=>{
 const f=fixture(),s=source();const token=f.registry.issue({...f.owner,fingerprint:fp},async()=>({fingerprint:fp,source:s.value}));const fixedOwner={...f.owner};const adapter=installPrivateVideoProbeProtocol({...f.options,verifyExclusiveBinding:(candidate,owner)=>{assert.equal(candidate,f.session);assert.deepEqual(owner,fixedOwner);assert.ok(Object.isFrozen(owner));return true;}});f.owner.ownerId=71;f.owner.documentId=randomUUID();
 for(const url of ["file:///private",token.url+"?x",token.url.toUpperCase(),"app://other/"+token.id])assert.equal((await f.handler(new Request(url))).status,404);
 assert.equal((await f.handler(new Request(token.url,{method:"POST"}))).status,404);
 const other=f.registry.issue({ownerId:99,documentId:randomUUID(),fingerprint:fp},async()=>({fingerprint:fp,source:source().value}));assert.equal((await f.handler(new Request(other.url))).status,404);
 const foreignDocument=f.registry.issue({...fixedOwner,documentId:randomUUID(),fingerprint:fp},async()=>({fingerprint:fp,source:source().value}));assert.equal((await f.handler(new Request(foreignDocument.url))).status,404);
 const response=await f.handler(new Request(token.url));assert.equal(response.status,200);assert.deepEqual([...new Uint8Array(await response.arrayBuffer())],[1,2,3]);
 assert.equal(adapter.teardown().unhandled,true);assert.deepEqual(adapter.teardown(),{active:false,unhandled:true,reason:"UNHANDLED"});assert.equal(f.unhandles,1);
 assert.equal((await f.handler(new Request(token.url))).status,404);assert.throws(()=>installPrivateVideoProbeProtocol(f.options));
 assert.throws(()=>installPrivateVideoProbeProtocol({...f.options,session:{...f.session}}));
});
test("persistent, storage-backed, prehandled or host-unbound sessions are refused; native unhandle failure is truthful",()=>{
 for(const patch of [{isPersistent:()=>true},{getStoragePath:()=>"/private"},{protocol:{...fixture().session.protocol,isProtocolHandled:()=>true}}]){const f=fixture();assert.throws(()=>installPrivateVideoProbeProtocol({...f.options,session:{...f.session,...patch}}));assert.equal(f.unhandles,0);}
 const unbound=fixture();unbound.live=false;assert.throws(()=>installPrivateVideoProbeProtocol(unbound.options));
 const f=fixture(),adapter=installPrivateVideoProbeProtocol(f.options);f.fail=true;assert.deepEqual(adapter.teardown(),{active:false,unhandled:false,reason:"UNHANDLE_FAILED"});assert.equal(adapter.teardown().unhandled,false);assert.equal(f.unhandles,1);
});
test("teardown during acquire closes source; loss of exclusive binding before return cancels unreturned body",async()=>{
 const f=fixture(),file=source();let release!:()=>void;const gate=new Promise<void>(done=>release=done);
 const token=f.registry.issue({...f.owner,fingerprint:fp},async()=>{await gate;return {fingerprint:fp,source:file.value};});const adapter=installPrivateVideoProbeProtocol(f.options);
 const pending=f.handler(new Request(token.url));adapter.teardown();release();assert.equal((await pending).status,404);assert.equal(file.closed,1);
 const second=fixture(),body=source();const t=second.registry.issue({...second.owner,fingerprint:fp},async()=>({fingerprint:fp,source:body.value}));let checks=0;
 installPrivateVideoProbeProtocol({...second.options,verifyExclusiveBinding:()=>++checks<3});
 assert.equal((await second.handler(new Request(t.url))).status,404);assert.equal(body.cancelled,1);
});

test("uncertain native installation invalidates owner and burns the private session without claiming unregistration",async()=>{
 const f=fixture(),file=source(),token=f.registry.issue({...f.owner,fingerprint:fp},async()=>({fingerprint:fp,source:file.value}));
 const handle=f.session.protocol.handle;f.session.protocol.handle=(scheme,callback)=>{handle(scheme,callback);throw Error("private installation failure");};
 assert.throws(()=>installPrivateVideoProbeProtocol(f.options),/安装结果未确认/);
 assert.equal((await f.handler(new Request(token.url))).status,404);assert.equal((await f.registry.response(new Request(token.url),f.owner)).status,404);
 assert.equal(f.unhandles,0);assert.throws(()=>installPrivateVideoProbeProtocol(f.options));
});
