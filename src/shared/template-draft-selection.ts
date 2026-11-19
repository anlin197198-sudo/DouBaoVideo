import { z } from "zod";
import type { PromptKind, TaskWorkspace } from "./models";
import { findPrompt, type PlanStyleContext } from "./prompts";
import { formatPromptTemplate } from "./prompt-template";
import { getPreviewTemplateInputGaps, type PreviewGlobalFields } from "./template-preview-fields";
import { getSlotTemplateInputGaps, toPromptTemplateSlotFields, type TemplateSlotFields } from "./template-slot-fields";
import type { InspectionSaveState } from "./inspection-summary";
export interface TemplateDraftSelectionContext {
  taskId: string; revision: number; workspace: TaskWorkspace; plan: PlanStyleContext; kind: PromptKind; shotId: string | null;
  globalFields: PreviewGlobalFields; slotFields: TemplateSlotFields; saveState: InspectionSaveState;
}
export type TemplateSelectionReason = "INVALID_CONTEXT"|"UNSAVED"|"VIDEO_UNSUPPORTED"|"MANUAL_CONTENT"|"MISSING_FIELDS"|"TOO_LONG"|"STALE_CONTEXT"|"NOT_ACCEPTED"|"ALREADY_SELECTED"|"SELECTING";
const blocked=(reason:TemplateSelectionReason)=>Object.freeze({status:"blocked" as const,reason});
class Block extends Error {constructor(readonly reason:TemplateSelectionReason){super(reason);}}
function textFor(context:TemplateDraftSelectionContext):string {
  if(!z.string().uuid().safeParse(context.taskId).success||!Number.isSafeInteger(context.revision)||context.revision<0)throw new Block("INVALID_CONTEXT");
  if(context.kind==="video")throw new Block("VIDEO_UNSUPPORTED");
  if((context.kind==="firstFrame"||context.kind==="lastFrame")&&!context.workspace.shots.length)throw new Block("INVALID_CONTEXT");
  const state=context.saveState;
  if(!state||state.dirty||state.saving||state.conflict||state.error!==null)throw new Block("UNSAVED");
  const current=findPrompt(context.workspace,context.kind,context.shotId);
  if(current&&current.text!=="")throw new Block("MANUAL_CONTENT");
  const globalGaps=getPreviewTemplateInputGaps(context.workspace,context.kind,context.shotId,context.globalFields);
  const slotGaps=getSlotTemplateInputGaps(context.workspace,context.kind,context.shotId,context.slotFields);
  const key=(gap:{code:string;scope:string;shotId:string|null})=>JSON.stringify([gap.scope,gap.shotId,gap.code]);
  const remaining=new Set(slotGaps.gaps.map(key));
  if(globalGaps.gaps.some(gap=>gap.category==="field-unavailable"&&remaining.has(key(gap))))throw new Block("MISSING_FIELDS");
  const text=formatPromptTemplate(context.workspace,context.plan,context.kind,context.shotId,
    {...context.globalFields,...toPromptTemplateSlotFields(context.workspace,context.kind,context.shotId,context.slotFields)});
  if(text.length>100000)throw new Block("TOO_LONG");
  return text;
}
/** Structural text selection ONLY. No prompt update, workspace result, autosave or dispatch.
 * Accepted is internal explicit intent, not external authentication. Informational empty content
 * is not a universal requirement. This does NOT establish scene quality/provider readiness. */
export class TemplateDraftSelection {
  readonly preview: Readonly<{status:"structural-preview";text:string;notApplied:true}>|ReturnType<typeof blocked>;
  #fingerprint:string|null=null;
  #text:string|null=null;
  #selected=false;
  #selecting=false;
  constructor(context:TemplateDraftSelectionContext){
    try {const text=textFor(context);this.#fingerprint=JSON.stringify(context);this.#text=text;
      this.preview=Object.freeze({status:"structural-preview",text,notApplied:true});
    }catch(error){this.preview=blocked(error instanceof Block?error.reason:"INVALID_CONTEXT");}
    Object.defineProperty(this,"preview",{value:this.preview,writable:false,configurable:false,enumerable:true});
  }
  select(current:TemplateDraftSelectionContext,accepted:boolean){
    if(this.#selecting)return blocked("SELECTING");this.#selecting=true;
    try {
      if(this.#selected)return blocked("ALREADY_SELECTED");
      if(accepted!==true)return blocked("NOT_ACCEPTED");
      if(this.#fingerprint===null||this.#text===null)return blocked("INVALID_CONTEXT");
      const text=textFor(current);
      if(JSON.stringify(current)!==this.#fingerprint||text!==this.#text)return blocked("STALE_CONTEXT");
      this.#selected=true;return Object.freeze({status:"selected-text-only" as const,text,notApplied:true as const});
    }catch(error){return blocked(error instanceof Block?error.reason:"INVALID_CONTEXT");}
    finally{this.#selecting=false;}
  }
}
