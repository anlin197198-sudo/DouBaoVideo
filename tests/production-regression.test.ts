import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ApplicationDatabase} from "../src/main/infrastructure/database";
import {createApplicationServices} from "../src/main/application/services";
import {DeepSeekPlanner} from "../src/main/providers/deepseek-planner";
import type {CommandInputs,CommandOutputs,CommandResult} from "../src/shared/bridge";
import {appendStoryboardDraft} from "../src/shared/storyboard-draft";
import {addAsset} from "../src/shared/assets";
import {setAssetLink} from "../src/shared/asset-links";
import {editPrompt} from "../src/shared/prompts";
import {formatPromptTemplate} from "../src/shared/prompt-template";
import {emptyTemplateSlotFields,updateTemplateSlotField} from "../src/shared/template-slot-fields";
import {emptyTemporaryTemplateEditor,prepareTemporaryTemplateEditor,editTemporaryTemplate} from "../src/shared/temporary-template-editor";
import {captureTemporaryTemplateApply,applyTemporaryTemplate} from "../src/shared/temporary-template-apply";
import type {TemplateDraftSelectionContext} from "../src/shared/template-draft-selection";
import {WorkspaceAutosave} from "../src/shared/workspace-autosave";
import {getSavedShotSummary} from "../src/shared/saved-shot-summary";
import type {TaskWorkspace} from "../src/shared/models";

test("synthetic saved-script planning, empty adoption, manual links and explicit template writes persist as exact ordered summary",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"production-regression-")),path=join(dir,"workspace.sqlite"),database=new ApplicationDatabase(path);
 let calls=0,consents=0;const captured:Array<Record<string,unknown>>=[];
 const script="合成：蓝方块先移动，再停在圆环旁。";
 const payload=JSON.stringify({formatVersion:1,shots:[{order:1,title:"方块移动",visual:"合成蓝方块",action:"移动",framing:"中景",motion:"固定",dialogue:""},{order:2,title:"方块停止",visual:"合成圆环",action:"停止",framing:"近景",motion:"固定",dialogue:""}]});
 const planner=new DeepSeekPlanner({enabled:true,apiKey:"synthetic-placeholder",fetchImpl:async(url,init)=>{
  calls++;assert.equal(String(url),"https://api.deepseek.com/chat/completions");assert.equal(init?.redirect,"error");assert.equal(init?.credentials,"omit");
  const body=JSON.parse(String(init?.body));captured.push(body);
  assert.deepEqual(body.messages.map((m:{role:string})=>m.role),["system","user"]);assert.equal(body.messages[1].content,script);assert.match(body.messages[0].content,/JSON/);
  assert.doesNotMatch(JSON.stringify(body),/DO_NOT_SEND|private-path|sourceFingerprint|referenceImageId/);
  return Response.json({choices:[{finish_reason:"stop",message:{role:"assistant",content:payload}}]});
 }});
 const services=createApplicationServices({database,logger:{command(){}},sessions:{async open(){throw Error("must not open session");}},version:"synthetic",dataDirectory:dir,storyboardPlanner:planner,
  confirmStoryboard:async()=>{consents++;return true;}});
 const send=<C extends keyof CommandInputs>(command:C,input:CommandInputs[C])=>services.router.dispatch({requestId:randomUUID(),command,input},{trusted:true}) as Promise<CommandResult<CommandOutputs[C]>>;
 try{
  assert.equal((await send("plans.create",{title:"DO_NOT_SEND_PLAN",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).ok,true);
  let task=services.repository.snapshot().tasks[0]!;const taskId=task.id;
  const person=randomUUID(),prop=randomUUID();let workspace=addAsset(addAsset({...task.workspace,script},person,"person"),prop,"prop");
  workspace={...workspace,assets:workspace.assets.map((asset,i)=>({...asset,name:i?"合成圆环":"合成方块",description:"DO_NOT_SEND_ASSET /private-path/fixture"}))};
  workspace=editPrompt(workspace,"comic","video",null,"DO_NOT_SEND_EXISTING_VIDEO_PROMPT");
  const save=async(value:TaskWorkspace)=>{const current=services.repository.getTask(taskId);assert.equal((await send("tasks.saveWorkspace",{id:taskId,expectedRevision:current.revision,workspace:value})).ok,true);return services.repository.getTask(taskId);};
  task=await save(workspace);const scriptHistory=services.repository.listScriptHistory({taskId});const videoHistory=services.repository.getPromptHistory({taskId,kind:"video",shotId:null,version:1});
  const stale=await send("storyboard.generatePreview",{taskId,expectedRevision:task.revision-1});assert.equal(stale.ok,false);assert.equal(calls,0);assert.equal(consents,0);
  const generated=await send("storyboard.generatePreview",{taskId,expectedRevision:task.revision});assert.ok(generated.ok&&generated.data.status==="ready"&&generated.data.adoptionToken);assert.equal(calls,1);assert.equal(consents,1);
  assert.deepEqual(services.repository.getTask(taskId),task);
  const token=generated.data.adoptionToken;const adopted=await send("storyboard.adoptDraft",{taskId,expectedRevision:task.revision,token});assert.ok(adopted.ok);
  const draft=appendStoryboardDraft({taskId,revision:task.revision,workspace:task.workspace,state:{dirty:false,saving:false,conflict:false,error:null,requestId:null}},adopted.data);assert.ok(draft);
  task=await save(draft);assert.equal(task.workspace.shots.length,2);
  workspace=task.workspace;for(const shot of workspace.shots)workspace=setAssetLink(workspace,person,shot.id,true);workspace=setAssetLink(workspace,prop,workspace.shots[1]!.id,true);task=await save(workspace);
  const texts:string[]=[];
  for(const shot of task.workspace.shots){
   task=services.repository.getTask(taskId);let slot=emptyTemplateSlotFields(task.workspace,"shot",shot.id);slot=updateTemplateSlotField(slot,"duration","用户明确的时长说明");slot=updateTemplateSlotField(slot,"continuity","保持合成主体一致");
   const context:TemplateDraftSelectionContext={taskId,revision:task.revision,workspace:task.workspace,plan:"comic",kind:"shot",shotId:shot.id,globalFields:{tone:"平静",lighting:"柔光",colorAnchor:"蓝色"},slotFields:slot,saveState:{dirty:false,saving:false,error:null,conflict:false}};
   const formatted=formatPromptTemplate(task.workspace,"comic","shot",shot.id,{...context.globalFields,shots:{[shot.id]:{duration:"用户明确的时长说明",continuity:"保持合成主体一致"}}});
   let editor=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),context);assert.equal(editor.buffer!.text,formatted);editor=editTemporaryTemplate(editor,formatted+"\n人工核对补充。");texts.push(editor.buffer!.text);
   const applied=applyTemporaryTemplate(captureTemporaryTemplateApply(editor),context,editor,true);assert.equal(applied.status,"draft-applied");if(applied.status!=="draft-applied")throw Error("blocked");
   assert.equal(services.repository.getTask(taskId).workspace.prompts!.some(p=>p.kind==="shot"&&p.shotId===shot.id),false);
   const controller=new WorkspaceAutosave(task,async(w,revision)=>{assert.equal((await send("tasks.saveWorkspace",{id:taskId,expectedRevision:revision,workspace:w})).ok,true);return services.repository.getTask(taskId);},()=>{},60000);
   controller.update(applied.workspace);assert.equal(await controller.flush(),true);controller.dispose();
  }
  task=services.repository.getTask(taskId);const staleAfter=await send("storyboard.generatePreview",{taskId,expectedRevision:task.revision-1});assert.equal(staleAfter.ok,false);assert.equal(calls,1);assert.equal(captured.length,1);
  assert.deepEqual(services.repository.listScriptHistory({taskId}),scriptHistory);assert.deepEqual(services.repository.getPromptHistory({taskId,kind:"video",shotId:null,version:1}),videoHistory);
  assert.deepEqual(task.workspace.assets.map(a=>a.id),[person,prop]);
  assert.deepEqual(task.workspace.assetLinks,[{assetId:person,shotId:task.workspace.shots[0]!.id},{assetId:person,shotId:task.workspace.shots[1]!.id},{assetId:prop,shotId:task.workspace.shots[1]!.id}]);
  const expected=task.workspace;database.close();const reopened=new ApplicationDatabase(path);
  try{const read=createApplicationServices({database:reopened,logger:{command(){}},sessions:{async open(){}},version:"synthetic",dataDirectory:dir});const restored=read.repository.getTask(taskId);assert.deepEqual(restored.workspace,expected);
   const summary=getSavedShotSummary(restored.workspace,"comic",restored.revision,{dirty:false,saving:false,error:null,conflict:false});assert.deepEqual(summary.sections.map(s=>s.status),["current","current"]);assert.deepEqual(summary.sections.map(s=>s.text),texts);assert.deepEqual(summary.sections.map(s=>s.version),[1,1]);
   for(const shot of restored.workspace.shots){
    assert.equal(read.repository.listPromptHistory({taskId,kind:"shot",shotId:shot.id}).items.length,1);
    const history=read.repository.getPromptHistory({taskId,kind:"shot",shotId:shot.id,version:1});
    const current=restored.workspace.prompts!.find(p=>p.kind==="shot"&&p.shotId===shot.id)!;
    assert.equal(history.text,current.text);assert.equal(history.inputSnapshot,current.inputSnapshot);
   }
   assert.deepEqual(read.repository.listScriptHistory({taskId}),scriptHistory);assert.deepEqual(read.repository.getPromptHistory({taskId,kind:"video",shotId:null,version:1}),videoHistory);
  }finally{reopened.close();}
 }finally{if(database.connection.isOpen)database.close();rmSync(dir,{recursive:true,force:true});}
});
