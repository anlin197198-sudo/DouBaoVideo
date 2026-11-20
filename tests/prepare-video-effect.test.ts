import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createVideoDecodePreparation } from "../src/main/application/prepare-video-decode";
import { VideoProbeRegistry } from "../src/main/application/video-probe-registry";
import { intakeMp4 } from "../src/main/infrastructure/mp4-intake";

function box(type: string, payload: Buffer) {
  const heading = Buffer.alloc(8);
  heading.writeUInt32BE(8 + payload.length);
  heading.write(type, 4, "ascii");
  return Buffer.concat([heading, payload]);
}
const bytes = Buffer.concat([box("ftyp", Buffer.from("isom0000")), box("moov", Buffer.from("synthetic")),
  box("mdat", Buffer.alloc(74_000, 53))]);
const positive = { status: "first-presented-frame", evidence: { durationSeconds: 1.25, videoWidth: 8, videoHeight: 6,
  mediaTime: 0.1, presentedFrames: 1, width: 8, height: 6 } };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "doubao-decode-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "source.mp4"), stagingParent = join(root, "stage");
  await mkdir(stagingParent);
  await writeFile(sourcePath, bytes);
  const owner = { ownerId: 17, documentId: randomUUID() };
  let now = 1, live = true;
  const registry = new VideoProbeRegistry({ isLive: (id, doc) => live && id === owner.ownerId && doc === owner.documentId,
    now: () => now, ttlMs: 10 });
  const get = (url: string, range?: string, requestOwner = owner) => registry.response({ url, method: "GET",
    headers: new Headers(range ? { range } : {}) }, requestOwner);
  return { owner, stagingParent, sourcePath, registry, get, expire: () => { now = 11; }, leave: () => { live = false; },
    intake: async () => intakeMp4(sourcePath, await lstat(sourcePath)) };
}

test("effect awaits settlement after EOF and late cancellation, preserving outcome before discard",async t=>{
 const f=await fixture(t);let stopped=false,release!:()=>void,reached!:()=>void;const gate=new Promise<void>(done=>release=done),entered=new Promise<void>(done=>reached=done);
 const prepare=await createVideoDecodePreparation({stagingParent:f.stagingParent,registry:f.registry,probe:async url=>{await (await f.get(url)).arrayBuffer();return positive;},stopProbe:()=>{stopped=true;return true;}});
 const abort=new AbortController();let returned=false;
 const pending=prepare(await f.intake(),f.owner,abort.signal,undefined,{mode:"await-settlement",isCurrent:()=>true,async settle(snapshot){assert.equal(stopped,true);const data=await new Response(await snapshot.open()).arrayBuffer();assert.deepEqual(Buffer.from(data),bytes);reached();await gate;return {publication:"already-published"};}}).then(value=>{returned=true;return value;});
 await entered;abort.abort();await new Promise(done=>setTimeout(done,15));assert.equal(returned,false);assert.notDeepEqual(await readdir(f.stagingParent),[]);
 release();const result=await pending;assert.equal(result.status,"cancelled");assert.deepEqual(result.effect,{status:"settled",outcome:{publication:"already-published"}});assert.deepEqual(await readdir(f.stagingParent),[]);
});
test("effect rejection reports unconfirmed; simultaneous handoffs never execute",async t=>{
 const f=await fixture(t);const prepare=await createVideoDecodePreparation({stagingParent:f.stagingParent,registry:f.registry,probe:async url=>{await (await f.get(url)).arrayBuffer();return positive;},stopProbe:()=>true});
 const result=await prepare(await f.intake(),f.owner,undefined,undefined,{mode:"await-settlement",isCurrent:()=>true,async settle(snapshot){const reader=(await snapshot.open()).getReader();await reader.read();throw Error("unconfirmed effect");}});
 assert.equal(result.status,"handoff-rejected");assert.deepEqual(result.effect,{status:"unconfirmed"});assert.deepEqual(await readdir(f.stagingParent),[]);
 let calls=0;const both=await prepare(await f.intake(),f.owner,undefined,{isCurrent:()=>true,async consume(){calls++;}},{mode:"await-settlement",isCurrent:()=>true,async settle(){calls++;}});assert.equal(both.status,"handoff-rejected");assert.equal(calls,0);
});
test("late cancellation inside final effect lease check preserves outcome but never reports current success",async t=>{
 const f=await fixture(t),abort=new AbortController();let settled=false;
 const prepare=await createVideoDecodePreparation({stagingParent:f.stagingParent,registry:f.registry,probe:async url=>{await (await f.get(url)).arrayBuffer();return positive;},stopProbe:()=>true});
 const result=await prepare(await f.intake(),f.owner,abort.signal,undefined,{mode:'await-settlement',isCurrent:()=>{if(settled)abort.abort();return true;},async settle(snapshot){await new Response(await snapshot.open()).arrayBuffer();settled=true;return {recorded:true};}});
 assert.equal(result.status,'cancelled');assert.deepEqual(result.effect,{status:'settled',outcome:{recorded:true}});assert.deepEqual(await readdir(f.stagingParent),[]);
});
