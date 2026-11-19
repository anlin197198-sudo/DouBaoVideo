import type { TaskWorkspace } from "./models";
import { findPrompt, promptInput, type PlanStyleContext } from "./prompts";
import type { InspectionSaveState } from "./inspection-summary";
export interface SavedShotSection { readonly shotId:string;readonly order:number;readonly title:string;readonly status:"current"|"missing"|"stale";readonly version:number|null;readonly text:string|null }
/** Read-only composition of already-saved shot texts, not generated video instructions.
 * The autosave owner supplies save state. No implicit review, persistence or new asset content. */
export function getSavedShotSummary(workspace:TaskWorkspace,plan:PlanStyleContext,savedRevision:number,saveState:InspectionSaveState){
 const hidden=saveState.dirty||saveState.saving||saveState.conflict||saveState.error!==null||!Number.isSafeInteger(savedRevision)||savedRevision<0;
 if(hidden)return Object.freeze({status:"hidden-unsaved" as const,revision:null,sections:Object.freeze([] as SavedShotSection[]),text:"当前有未保存、保存中、失败或冲突的编辑。请先处理保存状态；暂不展示已保存镜头提示词汇总。"});
 const sections=workspace.shots.map((shot,index):Readonly<SavedShotSection>=>{
  const prompt=findPrompt(workspace,"shot",shot.id);
  const status=!prompt?.text.trim()?"missing":prompt.inputSnapshot!==promptInput(workspace,plan,"shot",shot.id)?"stale":"current";
  return Object.freeze({shotId:shot.id,order:index+1,title:shot.title,status,version:status==="current"?prompt!.version:null,text:status==="current"?prompt!.text:null});
 });
 const text=[`已保存镜头提示词汇总｜任务修订 ${savedRevision}（只读，不生成或写入视频提示词）`,...sections.map(section=>
  `Shot ${String(section.order).padStart(2,"0")}｜${section.title}\n${section.status==="current"?`已保存 v${section.version}\n${section.text}`:section.status==="stale"?"输入已变化，旧提示词不纳入汇总；请在镜头提示词处核对。":"尚无非空镜头提示词。"}`),...(sections.length?[]:["尚无镜头。"])] .join("\n\n");
 return Object.freeze({status:"saved-local-only" as const,revision:savedRevision,sections:Object.freeze(sections),text});
}
