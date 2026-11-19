import type {TaskWorkspace,ScriptHistoryDetail} from "./models";
import {planStyleValue,type PlanStyleContext} from "./prompts";
import type {InspectionSaveState} from "./inspection-summary";
export interface ScriptReusePreview {token:string;taskId:string;revision:number;currentText:string;history:ScriptHistoryDetail;changed:boolean}
export interface ScriptReuseDraft {taskId:string;revision:number;sourceFingerprint:string;workspace:TaskWorkspace;changed:boolean}
export const scriptReuseFingerprint=(workspace:TaskWorkspace,plan:PlanStyleContext)=>JSON.stringify({workspace,plan:{style:planStyleValue(plan),styleNotes:typeof plan==="string"?"":plan.styleNotes??""}});
export function acceptScriptReuseDraft(result:ScriptReuseDraft,live:{taskId:string;revision:number;workspace:TaskWorkspace;plan:PlanStyleContext;state:InspectionSaveState}):TaskWorkspace|null {
 if(live.state.dirty||live.state.saving||live.state.conflict||live.state.error!==null||result.taskId!==live.taskId||result.revision!==live.revision||result.sourceFingerprint!==scriptReuseFingerprint(live.workspace,live.plan))return null;
 return result.workspace;
}
