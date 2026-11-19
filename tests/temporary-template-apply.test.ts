import {captureTemporaryTemplateApply,applyTemporaryTemplate} from "../src/shared/temporary-template-apply";
import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {emptyTemporaryTemplateEditor,prepareTemporaryTemplateEditor,editTemporaryTemplate,resetTemporaryTemplate,closeTemporaryTemplate,temporaryTemplateStale,captureTemporaryCopy,isCurrentTemporaryCopy} from "../src/shared/temporary-template-editor";
import {emptyTemplateSlotFields,updateTemplateSlotField} from "../src/shared/template-slot-fields";
import type {TemplateDraftSelectionContext} from "../src/shared/template-draft-selection";
import type {TaskWorkspace} from "../src/shared/models";
function context():TemplateDraftSelectionContext{
 const w:TaskWorkspace={script:"合成",shots:[{id:randomUUID(),title:"合成镜头",description:"",action:"",audio:"",shotSize:"",cameraMovement:"",position:{x:0,y:0},needsReview:false}],assets:[],assetLinks:[],scriptPosition:{x:0,y:0},viewport:{x:0,y:0,zoom:1}};
 const id=w.shots[0]!.id;let slot=emptyTemplateSlotFields(w,"shot",id);slot=updateTemplateSlotField(slot,"duration","明确时长");slot=updateTemplateSlotField(slot,"continuity","明确连续性");
 return{taskId:randomUUID(),revision:1,workspace:w,plan:"comic",kind:"shot",shotId:id,globalFields:{tone:"基调",lighting:"光线",colorAnchor:"色彩"},slotFields:slot,saveState:{dirty:false,saving:false,error:null,conflict:false}};
}
test("explicit apply writes only selected empty prompt and preserves caller; ordinary typing is isolated",()=>{
 const c=context();const actualState={...c.saveState,requestId:null};c.saveState={dirty:actualState.dirty,saving:actualState.saving,error:actualState.error,conflict:actualState.conflict};
 const before=structuredClone(c.workspace),editor=editTemporaryTemplate(prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),c),"人工临时修订");
 const envelope=captureTemporaryTemplateApply(editor),result=applyTemporaryTemplate(envelope,c,editor,true);
 assert.equal(result.status,"draft-applied");if(result.status!=="draft-applied")throw Error("blocked");
 assert.equal(result.workspace.prompts!.length,1);assert.equal(result.workspace.prompts![0]!.kind,"shot");assert.equal(result.workspace.prompts![0]!.shotId,c.shotId);assert.equal(result.workspace.prompts![0]!.text,"人工临时修订");assert.equal(result.workspace.prompts![0]!.source,"manual");
 assert.deepEqual(c.workspace,before);assert.deepEqual(result.workspace.shots,before.shots);assert.deepEqual(result.workspace.assets,before.assets);
 assert.equal(applyTemporaryTemplate(envelope,c,editor,false).status,"blocked");
 for(const kind of ["firstFrame","lastFrame"] as const){const scoped=context();scoped.kind=kind;scoped.shotId=null;let fields=emptyTemplateSlotFields(scoped.workspace,kind,null);fields=updateTemplateSlotField(fields,"composition","静态构图");fields=updateTemplateSlotField(fields,"state","静态状态");scoped.slotFields=fields;
 const buffer=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),scoped),applied=applyTemporaryTemplate(captureTemporaryTemplateApply(buffer),scoped,buffer,true);
 assert.equal(applied.status,"draft-applied");if(applied.status==="draft-applied"){assert.equal(applied.workspace.prompts!.length,1);assert.equal(applied.workspace.prompts![0]!.kind,kind);assert.equal(applied.workspace.prompts![0]!.shotId,null);}}

});
test("epoch, changed text, source, occupied content and nonclean live controller reject stale writes",()=>{
 const c=context(),editor=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),c),envelope=captureTemporaryTemplateApply(editor);
 for(const changed of [editTemporaryTemplate(editor,"new"),closeTemporaryTemplate(editor),prepareTemporaryTemplateEditor(closeTemporaryTemplate(editor),c)])assert.equal(applyTemporaryTemplate(envelope,c,changed,true).status,"blocked");
 for(const patch of [{revision:2},{taskId:randomUUID()},{plan:"realistic" as const},{globalFields:{...c.globalFields,tone:"new"}},...[{dirty:true},{saving:true},{conflict:true},{error:"failure"}].map(p=>({saveState:{...c.saveState,...p}}))])assert.equal(applyTemporaryTemplate(envelope,{...c,...patch},editor,true).status,"blocked");
 const occupied=structuredClone(c);occupied.workspace.prompts=[{kind:"shot",shotId:c.shotId,text:" ",version:1,inputSnapshot:"old",source:"manual"}];assert.equal(applyTemporaryTemplate(envelope,occupied,editor,true).status,"blocked");
 const blank=editTemporaryTemplate(editor," \n ");assert.equal(applyTemporaryTemplate(captureTemporaryTemplateApply(blank),c,blank,true).status,"blocked");
});
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {ApplicationDatabase} from "../src/main/infrastructure/database";
import {createApplicationServices} from "../src/main/application/services";
import {WorkspaceAutosave} from "../src/shared/workspace-autosave";
import {confirmationInput} from "../src/shared/frames";
test("existing empty record is not reviewed; confirmation invalidates, normal autosave adds immutable history and reopen retains",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"template-apply-")),path=join(dir,"workspace.sqlite"),db=new ApplicationDatabase(path);
 try{
 const services=createApplicationServices({database:db,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:dir});
 const send=(command:string,input:unknown)=>services.router.dispatch({requestId:randomUUID(),command,input},{trusted:true});
 assert.equal((await send("plans.create",{title:"合成",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).ok,true);
 const task=services.repository.snapshot().tasks[0]!,c=context();c.taskId=task.id;
 c.workspace.prompts=[{kind:"shot",shotId:c.shotId,text:"",version:1,inputSnapshot:"deliberately-old",source:"manual"}];
 assert.equal((await send("tasks.saveWorkspace",{id:task.id,expectedRevision:task.revision,workspace:c.workspace})).ok,true);
 const saved=services.repository.getTask(task.id);c.workspace=saved.workspace;c.revision=saved.revision;
 // Separate synthetic confirmation-state check, without claiming a real image/UI confirmation.
 const confirmed=structuredClone(c);confirmed.workspace.frames={candidates:[],firstId:null,lastId:null,parameters:{aspectRatio:"16:9",durationSeconds:5},confirmation:{inputSnapshot:confirmationInput(c.workspace,"comic"),confirmedAt:"synthetic",invalidated:false}};
 const temp=prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),confirmed),check=applyTemporaryTemplate(captureTemporaryTemplateApply(temp),confirmed,temp,true);
 assert.equal(check.status,"draft-applied");if(check.status==="draft-applied")assert.equal(check.workspace.frames!.confirmation!.invalidated,true);
 const editor=editTemporaryTemplate(prepareTemporaryTemplateEditor(emptyTemporaryTemplateEditor(),c),"第二动作人工文本"),result=applyTemporaryTemplate(captureTemporaryTemplateApply(editor),c,editor,true);
 assert.equal(result.status,"draft-applied");if(result.status!=="draft-applied")throw Error("blocked");assert.equal(result.workspace.prompts![0]!.inputSnapshot,"deliberately-old");
 let failOnce=true;
 const controller=new WorkspaceAutosave(saved,async(workspace,revision)=>{if(failOnce){failOnce=false;throw Error("synthetic storage failure");}const response=await send("tasks.saveWorkspace",{id:task.id,expectedRevision:revision,workspace});if(!response.ok)throw Error("save failed");return services.repository.getTask(task.id);},()=>{},60000);
 controller.update(result.workspace);assert.equal(await controller.flush(),false);assert.equal(controller.workspace.prompts![0]!.text,"第二动作人工文本");assert.equal(controller.state.dirty,true);assert.equal(await controller.flush(true),true);controller.dispose();
 assert.equal(services.repository.listPromptHistory({taskId:task.id,kind:"shot",shotId:c.shotId}).items.length,2);
 assert.equal(services.repository.getPromptHistory({taskId:task.id,kind:"shot",shotId:c.shotId,version:1}).text,"");
 db.close();const reopened=new ApplicationDatabase(path);try{const reader=createApplicationServices({database:reopened,logger:{command(){}},sessions:{async open(){}},version:"test",dataDirectory:dir});assert.equal(reader.repository.getTask(task.id).workspace.prompts![0]!.text,"第二动作人工文本");}finally{reopened.close();}
 }finally{if(db.connection.isOpen)db.close();rmSync(dir,{recursive:true,force:true});}
});
