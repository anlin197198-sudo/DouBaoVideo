import {randomUUID} from "node:crypto";
import type {ApplicationDatabase} from "../infrastructure/database";
import {WorkspaceRepository} from "../infrastructure/workspace-repository";
import {ScriptReuseService} from "./script-reuse";
import {ApplicationError} from "../core/errors";
import type {ScriptReusePreview,ScriptReuseDraft} from "../../shared/script-reuse-draft";
/** Bounded main-memory tokens, not persisted receipts. Only trusted IPC may enter these methods.
 * A consumed response is still just a draft: renderer must check its live autosave context. */
export class ScriptReuseWorkflow {
 #service:ScriptReuseService;
 #tokens=new Map<string,{preview:Extract<ReturnType<ScriptReuseService["preview"]>,{status:"draft-preview"}>;expires:number}>();
 constructor(private readonly db:ApplicationDatabase,private readonly clock:()=>number=Date.now){this.#service=new ScriptReuseService(db);}
 private now(){const n=this.clock();if(!Number.isFinite(n))throw new ApplicationError("CONFLICT","预览已失效，请重新预览。");return n;}
 preview(input:{taskId:string;expectedRevision:number;version:number}):ScriptReusePreview {
  const now=this.now();for(const [key,value] of this.#tokens)if(value.expires<=now)this.#tokens.delete(key);
  if(this.#tokens.size>=32)throw new ApplicationError("CONFLICT","临时预览数量已满，请稍后重新预览。");
  const result=this.#service.preview({taskId:input.taskId,expectedRevision:input.expectedRevision,historyVersion:input.version});
  if(result.status!=="draft-preview")throw new ApplicationError("CONFLICT","剧本或版本已变化，请重新读取并预览。");
  const token=randomUUID();this.#tokens.set(token,{preview:result,expires:now+5*60*1000});
  return Object.freeze({token,taskId:result.taskId,revision:result.revision,currentText:result.currentText,history:Object.freeze({...result.history}),changed:result.changed});
 }
 apply(input:{taskId:string;expectedRevision:number;token:string}):ScriptReuseDraft {
  const entry=this.#tokens.get(input.token),now=this.now();
  if(!entry||entry.expires<=now||now<entry.expires-5*60*1000||entry.preview.taskId!==input.taskId||entry.preview.revision!==input.expectedRevision)throw new ApplicationError("CONFLICT","预览已失效或不属于当前任务，请重新预览。");
  // One attempt consumes the token even when the task changed; retries require a fresh preview.
  this.#tokens.delete(input.token);
  const task=new WorkspaceRepository(this.db).getTask(input.taskId);
  const row=this.db.connection.prepare("SELECT style,style_notes FROM plans WHERE id=?").get(task.planId);
  if(!row)throw new ApplicationError("CONFLICT","计划已变化，请重新预览。");
  const result=this.#service.apply(entry.preview,{taskId:task.id,revision:task.revision,workspace:task.workspace,planStyle:{style:row.style as "comic"|"realistic",styleNotes:String(row.style_notes??"")},saveState:{dirty:false,saving:false,error:null,conflict:false},accepted:true});
  if(result.status==="blocked")throw new ApplicationError("CONFLICT","已保存内容发生变化，未复用，请重新预览。");
  return {taskId:task.id,revision:entry.preview.revision,sourceFingerprint:entry.preview.sourceFingerprint,workspace:result.workspace,changed:result.status==="draft-applied"};
 }
}
