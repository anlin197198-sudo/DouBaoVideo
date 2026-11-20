/** Developer-only native smoke entry. Never imported by normal application startup. */
import { app, BrowserWindow, protocol, session } from "electron";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, writeSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";
import { createPrivateVideoDecodeInspector, createPrivateVideoFirstFrameHost } from "../src/main/electron/private-video-first-frame-host";
import { SYNTHETIC_MP4_BASE64, SYNTHETIC_MP4_SHA256 } from "../tests/fixtures/f17-native-smoke-mp4";

import { createBoundArchiveRecorder } from "../src/main/application/bound-archive-evidence";
import { createVerifiedLocalImport } from "../src/main/application/verified-local-import";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { buildVideoBasename } from "../src/shared/video-basename";

const fullImport = process.argv.length === 3 && process.argv[2] === "--run-f17-native-full-import";
let reported=false,exitCode=1;
const report=(status:"refused"|"setup-failed"|"first-frame-observed"|"not-observed"|"deadline"|"import-recorded",retained:boolean,width?:number,height?:number)=>{
 if(reported)return;reported=true;exitCode=status==="first-frame-observed"||status==="import-recorded"?0:1;
 writeSync(1,JSON.stringify({stage:fullImport?"f17-native-full-import":"f17-native-probe",...(status==="import-recorded"?{taskUnchanged:true,archiveVerified:true,metadataRecorded:true}:{}),result:status==="deadline"?"timeout":status==="setup-failed"||status==="refused"?"failed":status,retained,...(width===undefined?{}:{width,height})})+"\n");
};
if(process.argv.slice(2).length!==1||(process.argv[2]!=="--run-f17-native-probe"&&!fullImport)){
 report("refused",false);app.exit(2);
}else{
 let root:string|undefined;
 const controller=new AbortController();
 const watchdog=setTimeout(()=>{controller.abort();report("deadline",root!==undefined);app.exit(3);},15000);
 // Kept referenced: even app.ready/native decode that never settles has a bounded exit.
 try{
  root=mkdtempSync(join(tmpdir(),"doubao-f17-native-smoke-"));
  for(const name of ["user-data","sessions","logs","crashes","staging"])mkdirSync(join(root,name));
  app.setPath("userData",join(root,"user-data"));
  app.setPath("sessionData",join(root,"sessions"));
  app.setAppLogsPath(join(root,"logs"));
  app.setPath("crashDumps",join(root,"crashes"));
  protocol.registerSchemesAsPrivileged([{scheme:"app",privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}}]);
  app.on("window-all-closed",()=>{/* Do not quit between the host closing and its final cleanup result. */});
  void app.whenReady().then(async()=>{
   try{
    if(typeof SYNTHETIC_MP4_BASE64!=="string"||SYNTHETIC_MP4_BASE64.length>1400000||! /^[A-Za-z0-9+/]+={0,2}$/.test(SYNTHETIC_MP4_BASE64))throw Error();
    const bytes=Buffer.from(SYNTHETIC_MP4_BASE64,"base64");
    if(!bytes.length||bytes.length>1024*1024||bytes.toString("base64")!==SYNTHETIC_MP4_BASE64||createHash("sha256").update(bytes).digest("hex")!==SYNTHETIC_MP4_SHA256)throw Error();
    const path=join(root!,"synthetic-source.mp4");writeFileSync(path,bytes,{flag:"wx",mode:0o600});
    const input=await intakeMp4(path,lstatSync(path),controller.signal);
    if(input.evidence.bytes!==bytes.length||input.evidence.sha256!==createHash("sha256").update(bytes).digest("hex")){await input.close();throw Error();}
    if(fullImport){
     await runSyntheticImport(root!,input,bytes,controller.signal);
     report("import-recorded",true);
     return;
    }
    const inspect=createPrivateVideoDecodeInspector({electron:{session,BrowserWindow},rendererDirectory:resolve(__dirname,"../renderer"),stagingParent:join(root!,"staging")});
    const result=await inspect(input,controller.signal);
    // Root retained intentionally: do not recursively remove possibly live Chromium data.
    // A separate launcher may inspect/clean its isolated environment after process termination.
    if(result.status==="first-frame-observed")report("first-frame-observed",true,result.evidence.videoWidth,result.evidence.videoHeight);
    else report("not-observed",true);
   }catch{report(fullImport?"setup-failed":"not-observed",root!==undefined);}
   finally{clearTimeout(watchdog);controller.abort();app.exit(exitCode);}
  }).catch(()=>{clearTimeout(watchdog);controller.abort();report("setup-failed",root!==undefined);app.exit(2);});
 }catch{clearTimeout(watchdog);controller.abort();report("setup-failed",root!==undefined);app.exit(2);}
}

/** No input/destination arguments from the CLI: all paths are inside this fresh synthetic root. */
async function runSyntheticImport(root:string,input:Awaited<ReturnType<typeof intakeMp4>>,bytes:Buffer,signal:AbortSignal){
 let db:ApplicationDatabase|undefined,host:ReturnType<typeof createPrivateVideoFirstFrameHost>|undefined;
 let delegated=false;
 try{
  const directory=join(root,"archive");mkdirSync(directory);
  const databasePath=join(root,"workspace.sqlite");
  db=new ApplicationDatabase(databasePath);
  const task=db.transaction(()=>new WorkspaceRepository(db!).createPlan({title:"Synthetic native import",style:"comic",startDate:"2026-11-19",dailyCount:1,executionTime:"09:00"})).tasks[0]!;
  const before=JSON.stringify(db.connection.prepare("SELECT * FROM tasks WHERE id=?").get(task.id));
  host=createPrivateVideoFirstFrameHost({electron:{session,BrowserWindow},rendererDirectory:resolve(__dirname,"../renderer"),signal});
  const intent={requestId:randomUUID(),filmId:randomUUID(),taskId:task.id,executionId:randomUUID(),expectedRevision:task.revision,version:1,title:"Synthetic native import",directory,owner:host.owner,fingerprint:{bytes:input.evidence.bytes,sha256:input.evidence.sha256}};
  const run=await createVerifiedLocalImport({database:db,stagingParent:join(root,"staging"),registry:host.registry,probe:host.probe,stopProbe:host.stop});
  delegated=true;
  const result=await run(input,host.owner,intent,()=>!signal.aborted,signal);
  if(result.status!=="settled"||result.preparation?.status!=="first-frame-observed"||result.preparation.cleanup!=="removed"||result.archive?.receipt?.status!=="published"||!result.archive.sourceCleanupConfirmed||result.record?.status!=="recorded"||signal.aborted)throw Error();
  if(!await host.stop())throw Error();
  db.close();db=undefined;
  // Reopen real V7 metadata; this readback does not recreate a capability or replay a write.
  db=new ApplicationDatabase(databasePath);
  if(JSON.stringify(db.connection.prepare("SELECT * FROM tasks WHERE id=?").get(task.id))!==before)throw Error();
  const metadataReader=createBoundArchiveRecorder();
  try{if(metadataReader.readRecordedMetadata(db,intent)?.status!=="prior-recorded")throw Error();}
  finally{metadataReader.close();}
  const film=db.connection.prepare("SELECT * FROM films WHERE id=?").get(intent.filmId);
  const execution=db.connection.prepare("SELECT * FROM executions WHERE id=?").get(intent.executionId);
  const receipt=db.connection.prepare("SELECT * FROM command_receipts WHERE request_id=?").get(intent.requestId);
  const target=join(directory,buildVideoBasename({taskId:task.id,executionId:intent.executionId,version:1,title:intent.title}));
  if(film?.task_id!==task.id||film.execution_id!==intent.executionId||film.version!==1||film.file_path!==target||execution?.task_id!==task.id||execution.operation!=="local-import"||execution.status!=="recorded"||execution.account_id!==null||execution.remote_reference!==null||receipt?.command!=="f17.local-import.record")throw Error();
  for(const table of ["executions","films","command_receipts"])if(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n!==1)throw Error();
  const stat=lstatSync(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==bytes.length||!readFileSync(target).equals(bytes)||!readFileSync(join(root,"synthetic-source.mp4")).equals(bytes)||readdirSync(directory).length!==1||readdirSync(join(root,"staging")).length!==0||signal.aborted)throw Error();
 }finally{
  try{if(host&&!await host.stop())throw Error();}
  finally{try{db?.close();}finally{if(!delegated)await input.close();}}
 }
}
