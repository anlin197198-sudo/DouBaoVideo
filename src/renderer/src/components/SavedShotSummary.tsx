import { prepareSavedShotVideoDraft, VIDEO_PROMPT_MAX, type ApplySavedShotVideoDraft, type SavedShotVideoDraft } from "../../../shared/saved-shot-video-draft";
import {useEffect,useRef,useState} from "react";
import type {TaskWorkspace} from "../../../shared/models";
import type {PlanStyleContext} from "../../../shared/prompts";
import type {InspectionSaveState} from "../../../shared/inspection-summary";
import {getSavedShotSummary} from "../../../shared/saved-shot-summary";
export function SavedShotSummary({taskId,workspace,planStyle,savedRevision,saveState,disabled,onApplyVideoDraft}:{taskId:string;workspace:TaskWorkspace;planStyle:PlanStyleContext;savedRevision:number;saveState:InspectionSaveState;disabled:boolean;onApplyVideoDraft:ApplySavedShotVideoDraft}){
 const summary=getSavedShotSummary(workspace,planStyle,savedRevision,saveState);
 const composition=prepareSavedShotVideoDraft({taskId, workspace, plan:planStyle, revision:savedRevision, saveState});
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
 <p className="helper">按叙事顺序列出当前有效的已保存镜头原文与版本；缺失或输入过期项仅标记，不纳入旧文字。不会自动核对，不代表已生成整条视频提示词，复制汇总不会填入正式编辑区。</p>
 {summary.status==="hidden-unsaved"?<p role="status">{summary.text}</p>:<><button type="button" className="text-button" disabled={disabled||busy} onClick={()=>{void copy();}}>{busy?"正在复制…":"复制已保存镜头汇总"}</button><label>镜头原文汇总<textarea readOnly rows={12} value={summary.text}/></label></>}
 {feedback?.key===key&&<p role="status">{feedback.message}</p>}
 {composition.status==="ready" && !disabled
  ? <ComposeVideoDraft key={composition.draft.source} draft={composition.draft} onApply={onApplyVideoDraft}/>
  : summary.status==="saved-local-only" && composition.status==="blocked" && <p className="helper">{compositionReasons[composition.reason]}</p>}
 </section>;
}


const compositionReasons = {
  unsaved: "请先完成保存。",
  incomplete: "请先补齐并核对全部镜头提示词，再生成本地预览。",
  occupied: "已有整条视频提示词（包括手填空格），不会覆盖。",
  "target-stale": "整条视频提示词的旧输入需要先核对，不能用旧输入填入草稿。",
  "too-long": "镜头全文合计超过十万字符，不能自动截断。",
};

function ComposeVideoDraft({draft,onApply}:{draft:SavedShotVideoDraft;onApply:ApplySavedShotVideoDraft}) {
  const [text,setText]=useState<string|null>(null);
  const [blocked,setBlocked]=useState(false);
  const locked=useRef(false);
  if(text===null)return <button type="button" className="text-button" onClick={()=>{setBlocked(false);setText(draft.text);}}>预览整条视频提示词草稿</button>;
  return <div>
    <p className="helper">本地预览只按顺序拼接已保存的镜头原文，不补写转场或动作。可先编辑，确认填入后由现有自动保存处理。</p>
    <label>待填入的整条视频提示词<textarea rows={9} maxLength={VIDEO_PROMPT_MAX} value={text} onChange={event=>{setText(event.target.value);setBlocked(false);}}/></label>
    <button type="button" className="text-button" disabled={!text.trim()} onClick={()=>{
      if(locked.current)return;
      locked.current=true;
      if(!onApply(draft,text)){locked.current=false;setBlocked(true);}
    }}>仅填入空白视频提示词</button>
    <button type="button" className="text-button" onClick={()=>setText(null)}>取消</button>
    {blocked&&<p role="status">内容或保存状态已变化，未写入。请重新预览。</p>}
  </div>;
}
