import type { BrowserWindow,Dialog } from "electron";
import { lstat } from "node:fs/promises";
import type { ApplicationDatabase } from "../infrastructure/database";
import { createLocalImportCommand,type LocalImportRequest } from "../application/local-import-command";
import { createPrivateVideoFirstFrameHost } from "./private-video-first-frame-host";
import type { PrivateProbeWindowOptions } from "./private-video-probe-window";
export interface NativeLocalImportCommandOptions {
 window:BrowserWindow;documentId:string;epoch:number;getEpoch:()=>number;database:ApplicationDatabase;
 stagingParent:string;rendererDirectory:string;
 electron:PrivateProbeWindowOptions["electron"]&{dialog:Pick<Dialog,"showOpenDialog"|"showMessageBox">};
 /** Trusted main editor lease, not a renderer-reported identity or dirty flag. */
 isCurrentEditor:(request:Readonly<LocalImportRequest>,document:Readonly<{documentId:string;epoch:number}>)=>boolean;
 isAllowedDestination:(directory:string)=>boolean;
}
/** Dormant native adapter: no IPC/startup wiring and no runtime Electron import. Native selectors
 * are bound to the captured initiating window. No caller-provided source/destination paths.
 * Host provides actual current-editor authority, trusted app database/roots and directory policy. */
export function createNativeLocalImportCommand(options:NativeLocalImportCommandOptions){
 const window=options.window,contents=window.webContents,windowId=window.id,contentsId=contents.id;
 const document=Object.freeze({documentId:options.documentId,epoch:options.epoch});
 const {database,stagingParent,rendererDirectory,isCurrentEditor,isAllowedDestination,getEpoch}=options;
 const electron=options.electron,dialog=electron.dialog;
 let active=true;
 const live=()=>{try{return active&&!window.isDestroyed()&&!contents.isDestroyed()&&window.id===windowId&&window.webContents===contents&&contents.id===contentsId&&getEpoch()===document.epoch&&active;}catch{return false;}};
 const requireLive=()=>{if(!live())throw new Error("本地导入发起窗口已失效。");};
 const command=createLocalImportCommand({database,stagingParent,origin:{windowId,documentId:document.documentId,epoch:document.epoch},
  isCurrent:(_origin,request)=>{if(!live())return false;try{const answer:unknown=isCurrentEditor(request,document);if(answer instanceof Promise)void answer.catch(()=>undefined);return answer===true&&live();}catch{return false;}},
  isAllowedDestination,
  async selectSource(){
   requireLive();const selected=await dialog.showOpenDialog(window,{title:"选择本地 MP4 文件",properties:["openFile"],filters:[{name:"MP4 视频",extensions:["mp4"]}]});requireLive();
   if(selected.canceled)return null;if(selected.filePaths.length!==1||typeof selected.filePaths[0]!=="string"||!/\.mp4$/i.test(selected.filePaths[0]))throw new Error("本地文件选择无效。");
   const path=selected.filePaths[0],stat=await lstat(path);requireLive();if(!stat.isFile()||stat.isSymbolicLink())throw new Error("本地文件选择无效。");
   return {path,selection:Object.freeze({dev:stat.dev,ino:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs})};
  },
  async selectDestination(){
   requireLive();const selected=await dialog.showOpenDialog(window,{title:"选择本地归档目录",properties:["openDirectory"]});requireLive();
   if(selected.canceled)return null;if(selected.filePaths.length!==1||typeof selected.filePaths[0]!=="string"||!selected.filePaths[0])throw new Error("归档目录选择无效。");return selected.filePaths[0];
  },
  async confirm(preview){
   requireLive();const answer=await dialog.showMessageBox(window,{type:"question",title:"确认本地导入",message:"检查首个呈现帧后，将文件归档并记录本地成片元数据。",
    detail:`任务：${preview.taskTitle}\n版本：${preview.version}\n大小：${preview.bytes} 字节\n目标目录：${preview.directory}\nSHA256：${preview.sha256}\n不提交生成任务、不使用账号、不标记任务完成。首帧检查不代表整段解码或可播放性认证。`,
    buttons:["取消","确认导入"],defaultId:0,cancelId:0,noLink:true});requireLive();return answer.response===1;
  },
  createProbeHost(){requireLive();return createPrivateVideoFirstFrameHost({electron,rendererDirectory});},
 });
 const close=()=>{if(!active)return;active=false;command.close();for(const [emitter,event] of subscriptions)emitter.removeListener(event as never,close);};
 const subscriptions:Array<[Pick<BrowserWindow,"on"|"removeListener">,string]>=[];
 // No listeners prevent or navigate the user's window; they only invalidate this command.
 const bind=(emitter:Pick<BrowserWindow,"on"|"removeListener">,event:string)=>{emitter.on(event as never,close);subscriptions.push([emitter,event]);};
 try{bind(window,"closed");for(const event of ["did-start-navigation","did-navigate-in-page","render-process-gone","destroyed"])bind(contents as unknown as Pick<BrowserWindow,"on"|"removeListener">,event);requireLive();}
 catch{close();throw new Error("无法绑定本地导入发起窗口。");}
 return Object.freeze({run:command.run,close});
}
