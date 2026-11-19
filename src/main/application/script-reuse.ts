import { z } from "zod";
import type { TaskWorkspace } from "../../shared/models";
import type { InspectionSaveState } from "../../shared/inspection-summary";
import { planStyleValue, type PlanStyleContext } from "../../shared/prompts";
import { editScript } from "../../shared/storyboard";
import { invalidateChangedConfirmation } from "../../shared/frames";
import type { ApplicationDatabase } from "../infrastructure/database";
import { WorkspaceRepository } from "../infrastructure/workspace-repository";
const requestSchema = z.object({ taskId:z.string().uuid(),expectedRevision:z.number().int().nonnegative(),historyVersion:z.number().int().positive() }).strict();
export type ScriptReuseRequest = z.infer<typeof requestSchema>;
export interface ScriptReuseInput { taskId:string;revision:number;workspace:TaskWorkspace;planStyle:PlanStyleContext;saveState:InspectionSaveState;accepted:boolean }
export type ScriptReuseReason = "INVALID_INPUT"|"STALE_PREVIEW"|"INVALID_PREVIEW"|"NOT_ACCEPTED"|"UNSAVED"|"APPLYING"|"ALREADY_APPLIED"|"READ_FAILED";
const blocked=(reason:ScriptReuseReason)=>Object.freeze({status:"blocked" as const,reason});
const normalizedPlan=(plan:PlanStyleContext)=>({style:planStyleValue(plan),styleNotes:typeof plan==="string"?"":plan.styleNotes??""});
/** Internal draft-only boundary. No UI, IPC, save or independently authenticated user intent.
 * Historical provenance is read from the task-scoped repository, never accepted from a caller. */
export class ScriptReuseService {
 #previews=new WeakMap<object,{request:ScriptReuseRequest;fingerprint:string;consumed:boolean}>();
 #applying=false;
 constructor(private readonly database:ApplicationDatabase){}
 private read(request:ScriptReuseRequest){
  const repository=new WorkspaceRepository(this.database),task=repository.getTask(request.taskId);
  const row=this.database.connection.prepare("SELECT style,style_notes FROM plans WHERE id=?").get(task.planId);
  if(!row||!["comic","realistic"].includes(String(row.style)))throw Error("Invalid plan");
  const plan={style:row.style as "comic"|"realistic",styleNotes:String(row.style_notes??"")};
  const history=repository.getScriptHistory({taskId:task.id,version:request.historyVersion});
  return {task,plan,history,fingerprint:JSON.stringify({task,plan,history})};
 }
 preview(raw:ScriptReuseRequest){
  let request:ScriptReuseRequest;
  try{const parsed=requestSchema.safeParse(raw);if(!parsed.success)return blocked("INVALID_INPUT");request=parsed.data;}catch{return blocked("INVALID_INPUT");}
  try{return this.database.transaction(()=>{
   const saved=this.read(request);if(saved.task.revision!==request.expectedRevision)return blocked("STALE_PREVIEW");
   const preview=Object.freeze({status:"draft-preview" as const,taskId:request.taskId,revision:request.expectedRevision,
    sourceFingerprint:JSON.stringify({workspace:saved.task.workspace,plan:saved.plan}),currentText:saved.task.workspace.script,history:Object.freeze({...saved.history}),changed:saved.task.workspace.script!==saved.history.text});
   this.#previews.set(preview,{request,fingerprint:saved.fingerprint,consumed:false});return preview;
  });}catch{return blocked("READ_FAILED");}
 }
 apply(preview:object,input:ScriptReuseInput){
  if(this.#applying)return blocked("APPLYING");this.#applying=true;
  try{
   const stored=this.#previews.get(preview);if(!stored)return blocked("INVALID_PREVIEW");if(stored.consumed)return blocked("ALREADY_APPLIED");
   if(input.accepted!==true)return blocked("NOT_ACCEPTED");
   if(!input.saveState||input.saveState.dirty||input.saveState.saving||input.saveState.conflict||input.saveState.error!==null)return blocked("UNSAVED");
   return this.database.transaction(()=>{
    const saved=this.read(stored.request);
    if(saved.fingerprint!==stored.fingerprint||input.taskId!==saved.task.id||input.revision!==saved.task.revision
     ||JSON.stringify(input.workspace)!==JSON.stringify(saved.task.workspace)||JSON.stringify(normalizedPlan(input.planStyle))!==JSON.stringify(saved.plan))return blocked("STALE_PREVIEW");
    // Work only on a private copy, leaving both caller draft and durable current/history untouched.
    const previous=structuredClone(saved.task.workspace),edited=editScript(previous,saved.history.text);
    const workspace=invalidateChangedConfirmation(previous,edited,saved.plan);stored.consumed=true;
    return {status:edited===previous?"no-change" as const:"draft-applied" as const,workspace};
   });
  }catch{return blocked("READ_FAILED");}finally{this.#applying=false;}
 }
}
