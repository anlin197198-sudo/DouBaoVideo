import React from "react";
import { LocalFilmImportPanel } from "../components/LocalFilmImportPanel";
import type { LocalFilmImportCapability } from "./local-film-import-state";
import { filmArchiveGroups } from "../../../shared/film-archive";
import type { Film, WorkspaceSnapshot } from "../../../shared/models";
function Record({film}:{film:Film}) {return <div>版本 {film.version??"无效／未记录"} · 记录时间 {film.createdAt?<time dateTime={film.createdAt}>{film.createdAt}</time>:"未记录"} · 记录来源：{film.provenance === "local-import" ? "本地导入" : "未确认"}<p className="helper">本地记录 ID：{film.id}。文件可读性及媒体有效性未验证。</p></div>;}
export function FilmsPage({snapshot,localImport}:{snapshot:Pick<WorkspaceSnapshot,"films"|"tasks">;localImport?:LocalFilmImportCapability}) {
 const groups=filmArchiveGroups(snapshot.films,snapshot.tasks);
 return <><div className="page-heading"><h1>成片</h1></div>
 <p className="helper">{localImport ? "此列表仅查看本地成片记录，不读取文件路径，不打开或播放文件。" : "只读查看本地成片记录，不读取文件路径，不打开或播放文件。真实下载、媒体校验与播放尚未接入。"}</p>
 {localImport && <LocalFilmImportPanel tasks={snapshot.tasks} capability={localImport}/>}
 {!groups.length?<div className="empty"><h2>暂无本地成片记录</h2><p>已有记录不代表视频已验证可用。</p></div>:<>
 <p className="helper">每条任务默认展示最高有效版本；同版本按记录时间、记录 ID 排序。旧版本及异常记录可展开，不改写历史。</p>
 {groups.map(group=><section key={group.taskId}><h2>{group.title}</h2>
 {group.latest?<Record film={group.latest}/>:<p role="status">没有有效版本号，不能判定最新版本。</p>}
 {group.duplicateLatest&&<p role="status">最高版本存在重复记录，请核对；当前仅按时间和 ID 确定展示顺序。</p>}
 {!!group.otherVersions.length&&<details><summary>查看其他版本及异常记录（{group.otherVersions.length}）</summary>{group.otherVersions.map(film=><Record key={film.id} film={film}/>)}</details>}
 </section>)}</>}
 </>;
}
