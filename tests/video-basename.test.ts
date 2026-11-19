import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVideoBasename, MAX_VIDEO_TITLE_UNITS } from "../src/shared/video-basename";
const a={taskId:"AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",executionId:"BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",version:1,title:"合成影片"};
const prefix=(name:string)=>name.split("--")[0]!;
test("stable complete identities prevent same-title task, execution and version collisions case-insensitively",()=>{
 const before=structuredClone(a),name=buildVideoBasename(a);assert.equal(name,buildVideoBasename({...a}));assert.match(name,/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa--bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb--v1\.mp4$/);
 const names=[name,buildVideoBasename({...a,taskId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}),buildVideoBasename({...a,executionId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd"}),buildVideoBasename({...a,version:2})];assert.equal(new Set(names.map(n=>n.toLowerCase())).size,4);assert.deepEqual(a,before);
 assert.equal(buildVideoBasename({...a,taskId:a.taskId.toLowerCase(),executionId:a.executionId.toLowerCase()}),name);
});
test("Windows unsafe title characters, reserved stems, empty titles and Unicode are bounded without broken surrogate pairs",()=>{
 for(const title of ["CON","con.txt","PRN","AUX","NUL",...Array.from({length:9},(_,i)=>`COM${i+1}`),...Array.from({length:9},(_,i)=>`LPT${i+1}.txt`),"COM¹","LPT²","COM³","ＣＯＮ"]){assert.ok(prefix(buildVideoBasename({...a,title})).startsWith("_"),title);}
 for(const title of ["","..."," . ","<>:?*", "\u0000\u001f"]){assert.equal(prefix(buildVideoBasename({...a,title})),"video");}
 for(const title of ['a<>:"/\\|?*\u0000\u001f\u007f\u0085 b.  ',"../escape", "\ud800bad\udfff", "😀".repeat(1000),"汉".repeat(2000)]){
 const name=buildVideoBasename({...a,title,version:Number.MAX_SAFE_INTEGER});assert.ok(name.length<=240);assert.doesNotMatch(name,/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/);assert.ok(name.endsWith(".mp4"));
 for(const point of name)assert.ok(!(point.length===1&&/[\uD800-\uDFFF]/.test(point)));
 assert.doesNotMatch(prefix(name),/[. ]$/);
 }
});
test("strict malformed input rejects without echoing secrets or accepting alternate paths/extensions",()=>{
 for(const raw of [{...a,title:"x".repeat(MAX_VIDEO_TITLE_UNITS+1)},{...a,version:0},{...a,version:1.5},{...a,version:NaN},{...a,version:Infinity},{...a,version:Number.MAX_SAFE_INTEGER+1},{...a,taskId:"secret"},{...a,extension:"exe"},{...a,path:"private"},{get title(){throw Error("secret")}},null])assert.throws(()=>buildVideoBasename(raw),/^Error: 视频候选文件名输入无效。$/);
});
