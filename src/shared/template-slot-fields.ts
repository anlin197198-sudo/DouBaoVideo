import { z } from "zod";
import type { PromptKind, TaskWorkspace } from "./models";
import type { PromptTemplateFields } from "./prompt-template";
import { getTemplateInputGaps } from "./template-input-gaps";
export type TemplateSlotKind = "shot" | "firstFrame" | "lastFrame";
const text = z.string().max(2000);
const schema = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("shot"),shotId:z.string().min(1),values:z.object({duration:text,continuity:text}).strict()}).strict(),
  z.object({kind:z.literal("firstFrame"),shotId:z.string().min(1).nullable(),values:z.object({composition:text,state:text}).strict()}).strict(),
  z.object({kind:z.literal("lastFrame"),shotId:z.string().min(1).nullable(),values:z.object({composition:text,state:text}).strict()}).strict(),
]);
export type TemplateSlotFields = z.infer<typeof schema>;
export type TemplateSlotFieldKey = "duration"|"continuity"|"composition"|"state";
function parse(raw:TemplateSlotFields):TemplateSlotFields {
  try {return schema.parse(raw);} catch {throw new Error("临时镜头字段无效，每项最多 2000 个字符。");}
}
function boundId(workspace:TaskWorkspace,kind:PromptKind,shotId:string|null):string|null {
  if(kind==="shot") {if(!shotId||!workspace.shots.some(shot=>shot.id===shotId))throw new Error("镜头已不存在。");return shotId;}
  if((kind!=="firstFrame"&&kind!=="lastFrame")||shotId!==null)throw new Error("临时字段范围无效。");
  return (kind==="firstFrame"?workspace.shots[0]:workspace.shots.at(-1))?.id??null;
}
const frozen=(value:TemplateSlotFields):TemplateSlotFields=>Object.freeze({...value,values:Object.freeze({...value.values})}) as TemplateSlotFields;
/** Temporary input binds to a role AND the actual endpoint identity, not its array index. */
export function emptyTemplateSlotFields(workspace:TaskWorkspace,kind:PromptKind,shotId:string|null):TemplateSlotFields {
  const id=boundId(workspace,kind,shotId);
  if(kind==="video")throw new Error("临时字段范围无效。");
  return frozen(kind==="shot"?{kind,shotId:id!,values:{duration:"",continuity:""}}:{kind,shotId:id,values:{composition:"",state:""}});
}
export function updateTemplateSlotField(raw:TemplateSlotFields,key:string,value:string):TemplateSlotFields {
  const fields=parse(raw);
  if(!Object.hasOwn(fields.values,key)||typeof value!=="string"||value.length>2000)throw new Error("临时镜头字段无效，每项最多 2000 个字符。");
  return frozen(parse({...fields,values:{...fields.values,[key]:value}} as TemplateSlotFields));
}
/** No persistence or inference: mismatched roles/endpoints reject rather than reuse stale prose. */
export function toPromptTemplateSlotFields(workspace:TaskWorkspace,kind:PromptKind,shotId:string|null,raw:TemplateSlotFields):PromptTemplateFields {
  const fields=parse(raw),id=boundId(workspace,kind,shotId);
  if(fields.kind!==kind||fields.shotId!==id)throw new Error("镜头或首尾位置已变化，请重新填写临时字段。");
  if(fields.kind==="shot")return {shots:{[fields.shotId]:{...fields.values}}};
  return {[fields.kind]:{...fields.values}};
}
export function getSlotTemplateInputGaps(workspace:TaskWorkspace,kind:PromptKind,shotId:string|null,raw:TemplateSlotFields) {
  toPromptTemplateSlotFields(workspace,kind,shotId,raw);
  const fields=parse(raw),summary=getTemplateInputGaps(workspace,kind,shotId);
  return Object.freeze({...summary,gaps:Object.freeze(summary.gaps.filter(gap=>!(gap.scope===fields.kind&&gap.shotId===fields.shotId
    &&gap.category==="field-unavailable"&&Object.hasOwn(fields.values,gap.code)
    &&(fields.values as Record<string,string>)[gap.code]!.trim()))) });
}
