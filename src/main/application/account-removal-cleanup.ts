import {z} from "zod";
import type {RemovalLease} from "./account-removal-workflow";
import type {SessionFence,AccountSessionLifecycle} from "./account-session-lifecycle";
const leaseSchema=z.object({accountId:z.string().uuid(),operationId:z.string().uuid(),leaseToken:z.string().uuid()}).strict();
const resultSchema=leaseSchema.extend({sessionCleared:z.literal(true),verified:z.literal(true)}).strict();
/** REQUIRED future adapter contract, not implemented here. Must itself hold exclusive authority
 * for this exact account/operation/lease throughout every destructive step and verify all relevant
 * session handles/network/workers are quiescent, scoped local data absent, and retries idempotent.
 * Its promise MUST NOT settle (even reject) until ALL cleanup work/continuations have stopped.
 * AccountRemovalWorkflow may release the lease after rejection; background work after settlement
 * would violate this port and could race a retry. No fire-and-forget work or timeout-only rejection.
 * Coordinator's before/after DB checks do NOT fence an asynchronous destructive implementation.
 * No filesystem/partition path may be supplied through this port. */
export interface VerifiedSessionCleanupPort {
 cleanupUnderLease(lease:Readonly<RemovalLease>):Promise<RemovalLease & {sessionCleared:true;verified:true}>;
}
/** Missing composition link only, deliberately NOT wired to production removal or Electron.
 * Closing an owned window alone never counts as clearing a session. Store complete/fail and
 * user confirmation remain the responsibility of AccountRemovalWorkflow. */
export class AccountRemovalCleanupCoordinator {
 #running=new Set<string>();
 constructor(private readonly fence:SessionFence,
  private readonly windows:Pick<AccountSessionLifecycle,"closeForRemoval">,
  private readonly cleanup:VerifiedSessionCleanupPort){}
 async run(raw:RemovalLease):Promise<{accountId:string;operationId:string;verified:true}> {
  let lease:Readonly<RemovalLease>;
  try{lease=Object.freeze(leaseSchema.parse(raw));}catch{throw new Error("会话清理租约无效。");}
  if(this.#running.has(lease.accountId))throw new Error("此账号会话清理正在进行。");
  this.#running.add(lease.accountId);
  try{
   this.fence.removal(lease,()=>undefined);
   const closed=this.windows.closeForRemoval(lease);
   if(closed.accountId!==lease.accountId||closed.operationId!==lease.operationId||closed.ownedWindowClosed!==true||closed.sessionCleared!==false)throw new Error("未验证窗口关闭。");
   this.fence.removal(lease,()=>undefined);
   const result=resultSchema.safeParse(await this.cleanup.cleanupUnderLease(lease));
   if(!result.success||result.data.accountId!==lease.accountId||result.data.operationId!==lease.operationId||result.data.leaseToken!==lease.leaseToken)throw new Error("会话清理结果未验证。");
   this.fence.removal(lease,()=>undefined);
   return Object.freeze({accountId:lease.accountId,operationId:lease.operationId,verified:true});
  }catch{throw new Error("未能验证此账号会话清理完成，必须保持停用并核实。");}
  finally{this.#running.delete(lease.accountId);}
 }
}
