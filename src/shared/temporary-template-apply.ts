import { TemplateDraftSelection, type TemplateDraftSelectionContext } from "./template-draft-selection";
import type { TemporaryTemplateEditor } from "./temporary-template-editor";
import { editPrompt } from "./prompts";
import { invalidateChangedConfirmation } from "./frames";
export interface TemporaryTemplateApplyEnvelope { readonly epoch:number;readonly text:string;readonly sourceFingerprint:string }
export type TemporaryTemplateApply = (envelope:TemporaryTemplateApplyEnvelope,context:TemplateDraftSelectionContext,editor:TemporaryTemplateEditor)=>boolean;
export function captureTemporaryTemplateApply(editor:TemporaryTemplateEditor):TemporaryTemplateApplyEnvelope {
 if(!editor.buffer)throw new Error("临时编辑区已关闭。");
 return Object.freeze({epoch:editor.epoch,text:editor.buffer.text,sourceFingerprint:editor.buffer.sourceFingerprint});
}
/** Explicit second action only. Returns a draft for the normal autosave owner, never marks saved
 * or reviewed. Caller must supply live controller context, not a cached renderer workspace. */
export function applyTemporaryTemplate(envelope:TemporaryTemplateApplyEnvelope,context:TemplateDraftSelectionContext,editor:TemporaryTemplateEditor,accepted:boolean){
 try {
  if(accepted!==true)return {status:"blocked" as const,reason:"NOT_ACCEPTED"};
  if(!editor.buffer||editor.epoch!==envelope.epoch||editor.buffer.text!==envelope.text||editor.buffer.sourceFingerprint!==envelope.sourceFingerprint
   ||envelope.sourceFingerprint!==JSON.stringify(context))return {status:"blocked" as const,reason:"STALE_SOURCE"};
  if(typeof envelope.text!=="string"||!envelope.text.trim()||envelope.text.length>100000)return {status:"blocked" as const,reason:"INVALID_TEXT"};
  const selection=new TemplateDraftSelection(context).select(context,true);
  if(selection.status!=="selected-text-only")return {status:"blocked" as const,reason:"INELIGIBLE"};
  const workspace=editPrompt(context.workspace,context.plan,context.kind,context.shotId,envelope.text);
  return {status:"draft-applied" as const,workspace:invalidateChangedConfirmation(context.workspace,workspace,context.plan)};
 }catch{return {status:"blocked" as const,reason:"INVALID_INPUT"};}
}
