import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {ApplicationDatabase} from "../src/main/infrastructure/database";
import {createApplicationServices} from "../src/main/application/services";
import {SqliteAccountRemovalStore} from "../src/main/infrastructure/account-removal-store";
import {SqliteAccountSessionFence} from "../src/main/infrastructure/account-session-fence";
import {AccountSessionLifecycle,type SessionWindow} from "../src/main/application/account-session-lifecycle";
import {AccountRemovalWorkflow,type RemovalLease} from "../src/main/application/account-removal-workflow";
import {AccountRemovalCleanupCoordinator,type VerifiedSessionCleanupPort} from "../src/main/application/account-removal-cleanup";
class Window implements SessionWindow {
 destroyed=false;refuse=false;closed=()=>{};
 isDestroyed(){return this.destroyed;}destroy(){if(!this.refuse){this.destroyed=true;this.closed();}}show(){}focus(){}onClosed(callback:()=>void){this.closed=callback;}async load(){}
}
async function fixture(){
 const database=new ApplicationDatabase(":memory:"),app=createApplicationServices({database,logger:{command(){}},sessions:{async open(){}},version:"synthetic",dataDirectory:"synthetic"});
 const account=app.repository.createAccount("合成账号"),other=app.repository.createAccount("其他账号"),store=new SqliteAccountRemovalStore(database),fence=new SqliteAccountSessionFence(()=>database);
 const windows:Window[]=[];const lifecycle=new AccountSessionLifecycle(fence,()=>{const w=new Window();windows.push(w);return w;});await lifecycle.open(account);await lifecycle.open(other);
 return{database,app,account,other,store,fence,lifecycle,windows,async begin(){const result=await store.begin(account.id,(await store.read(account.id)).revision);assert.equal(result.status,"started");if(result.status!=="started")throw Error("missing");return result.lease;}};
}
test("workflow composes verified owned close and explicitly scoped synthetic cleanup before marking removed",async()=>{
 const f=await fixture();try{let calls=0;const before=await f.store.read(f.other.id);
 const coordinator=new AccountRemovalCleanupCoordinator(f.fence,f.lifecycle,{async cleanupUnderLease(lease){calls++;assert.ok(Object.isFrozen(lease));assert.equal(f.windows[0]!.destroyed,true);assert.equal(f.windows[1]!.destroyed,false);assert.equal((await f.store.read(lease.accountId)).state,"pending");return{...lease,sessionCleared:true,verified:true};}});
 const workflow=new AccountRemovalWorkflow({store:f.store,confirm:async()=>true,cleanup:lease=>coordinator.run(lease)});
 assert.deepEqual(await workflow.run(f.account.id),{status:"removed"});assert.equal(calls,1);assert.equal((await f.store.read(f.account.id)).enabled,false);assert.deepEqual(await f.store.read(f.other.id),before);
 assert.deepEqual(await workflow.run(f.account.id),{status:"removed"});assert.equal(calls,1);assert.ok(f.app.repository.getAccount(f.account.id));
 }finally{f.lifecycle.closeAll();f.database.close();}
});
test("unverified close or cleanup failures preserve disabled pending state and do not falsely complete",async()=>{
 for(const mode of ["close","throw","wrong-token","not-cleared"]){const f=await fixture();try{let calls=0;f.windows[0]!.refuse=mode==="close";
 const port:VerifiedSessionCleanupPort={async cleanupUnderLease(lease){calls++;if(mode==="throw")throw Error("private path");return {...lease,leaseToken:mode==="wrong-token"?randomUUID():lease.leaseToken,sessionCleared:mode!=="not-cleared",verified:true} as never;}};
 const coordinator=new AccountRemovalCleanupCoordinator(f.fence,f.lifecycle,port),workflow=new AccountRemovalWorkflow({store:f.store,confirm:async()=>true,cleanup:lease=>coordinator.run(lease)});
 const result=await workflow.run(f.account.id);assert.equal(result.status,"pending");assert.doesNotMatch(JSON.stringify(result),/private path/);assert.equal(calls,mode==="close"?0:1);assert.equal((await f.store.read(f.account.id)).state,"pending");assert.equal((await f.store.read(f.account.id)).enabled,false);
 f.windows[0]!.refuse=false;
 const retry=new AccountRemovalWorkflow({store:f.store,confirm:async()=>true,cleanup:lease=>new AccountRemovalCleanupCoordinator(f.fence,f.lifecycle,{async cleanupUnderLease(l){return{...l,sessionCleared:true,verified:true};}}).run(lease)});
 assert.equal((await retry.run(f.account.id)).status,"removed");
 }finally{f.windows[0]!.refuse=false;f.lifecycle.closeAll();f.database.close();}}
});
test("stale leases never invoke cleanup and async lease replacement rejects old result without touching new lease",async()=>{
 const f=await fixture();try{let calls=0,resolve!:(value:RemovalLease&{sessionCleared:true;verified:true})=>void;
 const coordinator=new AccountRemovalCleanupCoordinator(f.fence,f.lifecycle,{cleanupUnderLease(){calls++;return new Promise(r=>{resolve=r;});}});
 const lease=await f.begin();await assert.rejects(coordinator.run({...lease,leaseToken:randomUUID()}));assert.equal(calls,0);
 const pending=coordinator.run(lease);await assert.rejects(coordinator.run(lease),/正在进行/);assert.equal(calls,1);
 await f.store.fail(lease);const replacement=await f.begin();assert.notEqual(replacement.leaseToken,lease.leaseToken);
 resolve({...lease,sessionCleared:true,verified:true});await assert.rejects(pending,/未能验证/);
 const row=f.database.connection.prepare("SELECT lease_token FROM account_removal WHERE account_id=?").get(f.account.id)!;assert.equal(row.lease_token,replacement.leaseToken);assert.equal((await f.store.read(f.account.id)).state,"pending");
 }finally{f.lifecycle.closeAll();f.database.close();}
});
test("unsettled cleanup keeps workflow lease exclusive; rejection releases only after port reports work stopped",async()=>{
 const f=await fixture();try{
 let started!:()=>void,reject!:(error:Error)=>void;const entered=new Promise<void>(r=>{started=r;});let stopped=false;
 const coordinator=new AccountRemovalCleanupCoordinator(f.fence,f.lifecycle,{cleanupUnderLease(){started();return new Promise((_,r)=>{reject=r;});}});
 const workflow=new AccountRemovalWorkflow({store:f.store,confirm:async()=>true,cleanup:lease=>coordinator.run(lease)});
 const pending=workflow.run(f.account.id);await entered;
 await assert.rejects(workflow.run(f.account.id),/正在进行/);
 assert.equal((await f.store.begin(f.account.id,(await f.store.read(f.account.id)).revision)).status,"conflict");
 const row=f.database.connection.prepare("SELECT lease_token FROM account_removal WHERE account_id=?").get(f.account.id)!;assert.ok(row.lease_token);
 stopped=true;reject(Error("synthetic stopped worker"));assert.equal((await pending).status,"pending");assert.equal(stopped,true);
 assert.equal(f.database.connection.prepare("SELECT lease_token FROM account_removal WHERE account_id=?").get(f.account.id)!.lease_token,null);
 assert.equal((await f.store.read(f.account.id)).enabled,false);
 }finally{f.lifecycle.closeAll();f.database.close();}
});
