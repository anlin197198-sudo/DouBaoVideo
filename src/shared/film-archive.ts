import type { Film, VideoTask } from "./models";
/** Metadata ordering only: highest valid version, then latest valid time, then stable ID.
 * A local record is not proof that its video exists or was verified playable. */
export function filmArchiveGroups(films:readonly Film[],tasks:readonly Pick<VideoTask,"id"|"title">[]) {
  const title=new Map(tasks.map(t=>[t.id,t.title])),groups=new Map<string,Film[]>();
  for(const film of films){const rows=groups.get(film.taskId)??[];rows.push({...film});groups.set(film.taskId,rows);}
  const valid=(f:Film)=>typeof f.version==="number"&&Number.isSafeInteger(f.version)&&f.version>0;
  const time=(f:Film)=>f.createdAt&&Number.isFinite(Date.parse(f.createdAt))?Date.parse(f.createdAt):Number.NEGATIVE_INFINITY;
  return [...groups].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([taskId,rows])=>{
    rows.sort((a,b)=>(valid(b)?b.version!:0)-(valid(a)?a.version!:0)||time(b)-time(a)||(a.id<b.id?-1:a.id>b.id?1:0));
    const latest=rows.find(valid)??null;
    return Object.freeze({taskId,title:title.get(taskId)||"原任务不可用",latest:latest?Object.freeze(latest):null,
      duplicateLatest:!!latest&&rows.filter(r=>r.version===latest.version).length>1,
      otherVersions:Object.freeze(rows.filter(r=>r!==latest).map(r=>Object.freeze(r)))});
  });
}
