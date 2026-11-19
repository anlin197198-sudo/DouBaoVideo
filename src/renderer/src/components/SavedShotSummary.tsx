import {useEffect,useRef,useState} from "react";
import type {TaskWorkspace} from "../../../shared/models";
import type {PlanStyleContext} from "../../../shared/prompts";
import type {InspectionSaveState} from "../../../shared/inspection-summary";
import {getSavedShotSummary} from "../../../shared/saved-shot-summary";
export function SavedShotSummary({taskId,workspace,planStyle,savedRevision,saveState,disabled}:{taskId:string;workspace:TaskWorkspace;planStyle:PlanStyleContext;savedRevision:number;saveState:InspectionSaveState;disabled:boolean}){
 const summary=getSavedShotSummary(workspace,planStyle,savedRevision,saveState);
 const key=JSON.stringify([taskId,summary.status,summary.revision,summary.text]);
 const latest=useRef(key);latest.current=key;
 const alive=useRef(true),lock=useRef(false),operation=useRef(0);
 const [busy,setBusy]=useState(false),[feedback,setFeedback]=useState<{key:string;message:string}|null>(null);
 useEffect(()=>{operation.current++;lock.current=false;setBusy(false);setFeedback(null);},[key]);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current++;};},[]);
 async function copy(){
  if(disabled||lock.current||summary.status!=="saved-local-only")return;
  const captured=key,id=++operation.current;lock.current=true;setBusy(true);setFeedback(null);
  try{await navigator.clipboard.writeText(summary.text);if(alive.current&&id===operation.current&&latest.current===captured)setFeedback({key:captured,message:"已复制当前已保存镜头汇总；视频提示词未改动。"});}
  catch{if(alive.current&&id===operation.current&&latest.current===captured)setFeedback({key:captured,message:"复制失败，请手动选择下方文本复制。"});}
  finally{if(alive.current&&id===operation.current){lock.current=false;setBusy(false);}}
 }
 return <section aria-label="已保存镜头提示词汇总"><h4>已保存镜头提示词汇总（只读）</h4>
 <p className="helper">按叙事顺序列出当前有效的已保存镜头原文与版本；缺失或输入过期项仅标记，不纳入旧文字。不会自动核对，不代表已生成整条视频提示词，也不会填入正式编辑区。</p>
 {summary.status==="hidden-unsaved"?<p role="status">{summary.text}</p>:<><button type="button" className="text-button" disabled={disabled||busy} onClick={()=>{void copy();}}>{busy?"正在复制…":"复制已保存镜头汇总"}</button><label>镜头原文汇总<textarea readOnly rows={12} value={summary.text}/></label></>}
 {feedback?.key===key&&<p role="status">{feedback.message}</p>}
 </section>;
}
