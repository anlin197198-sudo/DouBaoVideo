import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createLocalImportRoute} from '../src/main/electron/local-import-route';
const request={taskId:randomUUID(),revision:0};
const recorded={status:'settled',archiveStatus:'published',recordStatus:'recorded',cleanupConfirmed:true,automaticRetry:false,mediaPlaybackAuthorized:false} as const;
function setup(enabled?:boolean){
 const frame={url:'app://workspace/index.html'};const contents=Object.assign(new EventEmitter(),{id:2,mainFrame:frame,getURL:()=>frame.url,isDestroyed:()=>false});const window=Object.assign(new EventEmitter(),{id:1,webContents:contents,isDestroyed:()=>false});let epoch=1,calls=0,closed=0;
 let resolve!:(value:unknown)=>void,seen:AbortSignal|undefined;let pending=false;
 const gate=new Promise<unknown>(r=>resolve=r);
 const options={window,mainFrame:frame,epoch:1,getEpoch:()=>epoch,rendererURL:frame.url,enabled,command:{async run(_raw:unknown,signal?:AbortSignal){calls++;seen=signal;return pending?await gate:recorded;},close(){closed++;}}};
 const route=createLocalImportRoute(options as unknown as Parameters<typeof createLocalImportRoute>[0]);
 const event={sender:contents,senderFrame:frame} as Parameters<typeof route.readiness>[0];
 return {route,event,frame,contents,window,resolve,hold:()=>{pending=true;},bump:()=>{epoch++;},get calls(){return calls;},get closed(){return closed;},get signal(){return seen;}};
}
test('route is OFF without explicit injected enablement; foreign sender/frame/url never reaches command',async()=>{
 const off=setup();assert.equal(off.route.readiness(off.event).available,false);await off.route.run(off.event,request);assert.equal(off.calls,0);off.route.close();
 const f=setup(true);assert.equal(f.route.readiness(f.event).available,true);
 const foreign=[{...f.event,sender:{}},{...f.event,senderFrame:{...f.frame}}];
 for(const event of foreign){assert.equal(f.route.readiness(event as typeof f.event).available,false);await f.route.run(event as typeof f.event,request);}
 f.frame.url+='?changed';assert.equal(f.route.readiness(f.event).available,false);await f.route.run(f.event,request);assert.equal(f.calls,0);f.route.close();
});
test('strict request and document epoch guards reject extra renderer paths or stale main document',async()=>{
 const f=setup(true);await f.route.run(f.event,{...request,path:'/private/source.mp4'});assert.equal(f.calls,0);f.bump();assert.equal(f.route.readiness(f.event).available,false);await f.route.run(f.event,request);assert.equal(f.calls,0);f.route.close();
});
test('late navigation aborts but awaits actual settlement and preserves redacted durable facts',async()=>{
 const f=setup(true);f.hold();let returned=false;const pending=f.route.run(f.event,request).then(r=>{returned=true;return r;});await new Promise(r=>setImmediate(r));
 assert.equal(f.calls,1);f.contents.emit('did-start-navigation');assert.equal(f.signal?.aborted,true);await new Promise(r=>setImmediate(r));assert.equal(returned,false);
 f.resolve(recorded);const result=await pending;assert.equal(result.archiveStatus,'published');assert.equal(result.recordStatus,'recorded');assert.equal(result.contextCurrent,false);assert.equal(f.route.readiness(f.event).available,false);
});
test('malformed side-effect result cannot leak paths or claim no publication',async()=>{
 const f=setup(true);f.hold();const pending=f.route.run(f.event,request);await new Promise(r=>setImmediate(r));f.resolve({status:'mystery',secret:'/private',archiveStatus:'none'});const result=await pending;
 assert.equal(result.archiveStatus,'publication-uncertain');assert.equal(result.recordStatus,'recording-unconfirmed');assert.ok(!JSON.stringify(result).includes('/private'));f.route.close();
});
test('valid durable result strips unknown fields and route busy cannot start a second command',async()=>{
 const f=setup(true);f.hold();const pending=f.route.run(f.event,request);await new Promise(r=>setImmediate(r));const busy=await f.route.run(f.event,request);assert.equal(busy.status,'busy');assert.equal(f.calls,1);
 f.resolve({...recorded,path:'/private',token:'secret'});const result=await pending;assert.equal(result.recordStatus,'recorded');assert.equal(result.contextCurrent,true);assert.ok(!JSON.stringify(result).includes('/private'));assert.ok(!JSON.stringify(result).includes('secret'));f.route.close();
});
