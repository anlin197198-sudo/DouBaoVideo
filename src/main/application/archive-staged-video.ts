import { isAbsolute, parse, resolve } from "node:path";
import { buildVideoBasename, type VideoBasenameInput } from "../../shared/video-basename";
import { MAX_VIDEO_WRITE_BYTES, writeVerifiedVideoBytes, type VideoByteWriteResult } from "../infrastructure/video-byte-writer";
import type { VideoProbeFingerprint } from "./video-probe-registry";

type Snapshot = Readonly<{ fingerprint: Readonly<VideoProbeFingerprint>;
  open: () => Promise<ReadableStream<Uint8Array<ArrayBuffer>>> }>;
export interface StagedVideoArchiveResult {
  status: "not-started" | "settled" | "receipt-unconfirmed";
  receipt: VideoByteWriteResult | null;
  currentAtReturn: boolean;
  sourceCleanupConfirmed: boolean;
  automaticRetry: false;
  databaseCompleted: false;
}
/** Main-only side-effect boundary. MUST NOT be invoked inside the current read-only
 * SnapshotHandoff.consume (that callback races cancellation). The trusted caller owns the
 * verified staged snapshot until this promise settles, including cancellation and publication.
 * No media-validity, durable import reservation, DB completion or renderer API is implied.
 * isCurrent is a short synchronous lease check, not an atomic OS/DB fencing transaction. */
export async function archiveStagedVideo(options: {
  directory: string; identity: VideoBasenameInput; snapshot: Snapshot;
  isCurrent: () => boolean; signal?: AbortSignal;
}, io: Parameters<typeof writeVerifiedVideoBytes>[1] = {}): Promise<Readonly<StagedVideoArchiveResult>> {
  const directory=options.directory,identity=Object.freeze({...options.identity}),signal=options.signal;
  const isCurrent=options.isCurrent,snapshot=options.snapshot;
  const fingerprint=Object.freeze({bytes:snapshot.fingerprint.bytes,sha256:snapshot.fingerprint.sha256});
  // Validate the whole destination/identity/fingerprint contract before opening any source.
  buildVideoBasename(identity);
  if(typeof directory!=="string"||!isAbsolute(directory)||resolve(directory)!==directory||parse(directory).root===directory
    || !Number.isSafeInteger(fingerprint.bytes)||fingerprint.bytes<1||fingerprint.bytes>MAX_VIDEO_WRITE_BYTES
    || typeof fingerprint.sha256!=="string"|| !/^[0-9a-f]{64}$/.test(fingerprint.sha256))throw new Error("暂存归档参数无效。");
  const current=()=>{try{
    if(signal?.aborted)return false;
    const answer:unknown=isCurrent();
    if(answer instanceof Promise)void answer.catch(()=>undefined);
    return answer===true;
  }catch{return false;}};
  let receipt:VideoByteWriteResult|null=null,sourceCleanupConfirmed=true,writerStarted=false;
  let stream:ReadableStream<Uint8Array<ArrayBuffer>>|undefined;
  let reader:ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>|undefined,completed=false;
  const result=(status:StagedVideoArchiveResult["status"])=>Object.freeze({status,receipt,currentAtReturn:current(),sourceCleanupConfirmed,automaticRetry:false as const,databaseCompleted:false as const});
  if(!current())return result("not-started");
  try {
    stream=await snapshot.open();reader=stream.getReader();
    async function* chunks(){
      for(;;){
        if(!current())throw new Error("暂存归档已失效。");
        const item=await reader!.read();
        if(!current())throw new Error("暂存归档已失效。");
        if(item.done){completed=true;return;}
        yield item.value;
      }
    }
    if(current()){
    writerStarted=true;
    receipt=await writeVerifiedVideoBytes({directory,identity,expectedBytes:fingerprint.bytes,
      expectedSha256:fingerprint.sha256,chunks:chunks(),beforePublish:current},io);
    }
  } catch { /* Never turn an unknown writer outcome into a claim of cancellation/no publication. */ }
  finally {
    try {
      if(reader){if(!completed)await reader.cancel();reader.releaseLock();}
      else if(stream)await stream.cancel();
    }catch{sourceCleanupConfirmed=false;}
  }
  return result(receipt?"settled":writerStarted?"receipt-unconfirmed":"not-started");
}
