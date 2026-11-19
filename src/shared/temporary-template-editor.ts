import { TemplateDraftSelection, type TemplateDraftSelectionContext } from "./template-draft-selection";
export interface TemporaryTemplateEditor { epoch:number; buffer:Readonly<{original:string;text:string;sourceFingerprint:string}>|null }
export const emptyTemporaryTemplateEditor=():TemporaryTemplateEditor=>({epoch:0,buffer:null});
export function prepareTemporaryTemplateEditor(state:TemporaryTemplateEditor,context:TemplateDraftSelectionContext):TemporaryTemplateEditor {
 if(state.buffer)throw new Error("请先关闭当前临时编辑区。");
 const result=new TemplateDraftSelection(context).select(context,true);
 if(result.status!=="selected-text-only")throw new Error("当前内容不满足临时准备条件，请先保存并补齐字段。");
 return {epoch:state.epoch+1,buffer:Object.freeze({original:result.text,text:result.text,sourceFingerprint:JSON.stringify(context)})};
}
export function editTemporaryTemplate(state:TemporaryTemplateEditor,text:string):TemporaryTemplateEditor {
 if(!state.buffer||typeof text!=="string"||text.length>100000)throw new Error("临时文本无效，最多 100000 个字符。");
 return {epoch:state.epoch+1,buffer:Object.freeze({...state.buffer,text})};
}
export const resetTemporaryTemplate=(state:TemporaryTemplateEditor)=>state.buffer?editTemporaryTemplate(state,state.buffer.original):state;
export const closeTemporaryTemplate=(state:TemporaryTemplateEditor):TemporaryTemplateEditor=>({epoch:state.epoch+1,buffer:null});
export const temporaryTemplateStale=(state:TemporaryTemplateEditor,context:TemplateDraftSelectionContext|null)=>!!state.buffer&&(!context||state.buffer.sourceFingerprint!==JSON.stringify(context));
export const captureTemporaryCopy=(state:TemporaryTemplateEditor)=>state.buffer?Object.freeze({epoch:state.epoch,text:state.buffer.text}):null;
export const isCurrentTemporaryCopy=(state:TemporaryTemplateEditor,token:{epoch:number;text:string})=>!!state.buffer&&state.epoch===token.epoch&&state.buffer.text===token.text;
