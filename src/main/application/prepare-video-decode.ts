import { z } from "zod";
import { createMp4Stage } from "../infrastructure/mp4-stage";
import type { intakeMp4 } from "../infrastructure/mp4-intake";
import type { VideoProbeAcquire, VideoProbeFingerprint, VideoProbeOwner, VideoProbeRegistry } from "./video-probe-registry";

const positiveDimension = z.number().int().positive().max(100_000);
const evidenceSchema = z.object({
  durationSeconds: z.number().finite().positive(),
  videoWidth: positiveDimension, videoHeight: positiveDimension,
  mediaTime: z.number().finite().nonnegative(), presentedFrames: z.number().int().positive().safe(),
  width: positiveDimension, height: positiveDimension,
}).strict().refine(value => value.mediaTime <= value.durationSeconds);
const resultSchema = z.object({ status: z.literal("first-presented-frame"), evidence: evidenceSchema }).strict();
type Intake = Awaited<ReturnType<typeof intakeMp4>>;
type Cleanup = "removed" | "not-created" | "retained-or-unknown";
type Unsuccessful = "cancelled" | "staging-failed" | "probe-rejected" | "deadline" | "handoff-rejected" | "cleanup-unconfirmed";
type EffectResult = Readonly<{status:"settled";outcome:unknown}> | Readonly<{status:"unconfirmed"}>;
type Preparation = (
  | Readonly<{ status: "first-frame-observed"; fingerprint: Readonly<VideoProbeFingerprint>;
    evidence: Readonly<z.infer<typeof evidenceSchema>>; cleanup: "removed"; handoff?: "consumed" }>
  | Readonly<{ status: Unsuccessful; cleanup: Cleanup; inputCloseConfirmed: boolean }>) & Readonly<{effect?:EffectResult}>;

/** Trusted host must establish the isolated probe document, pass through only URL and signal there,
 * and close/tear down that document on abort. The owner is supplied by trusted main, never the renderer. */
type NativeDecoderHost = (url: string, owner: Readonly<VideoProbeOwner>, signal: AbortSignal) => Promise<unknown>;

type SnapshotHandoff = Readonly<{
  /** Trusted initiating editor/task lease, independent of the destroyed decoder document. */
  isCurrent: () => boolean;
  /** Main-only, await all reads before returning. No filesystem publication or other side effects. */
  consume(snapshot: Readonly<{ fingerprint: Readonly<VideoProbeFingerprint>;
    open: () => Promise<ReadableStream<Uint8Array<ArrayBuffer>>> }>, signal: AbortSignal): Promise<void>;
}>;

export type SnapshotEffect<T=unknown> = Readonly<{
 mode:"await-settlement";isCurrent:()=>boolean;
 /** Trusted side-effect port MUST settle only after all its work stops, even on rejection.
  * Cancellation is cooperative; no timeout/race may discard its bytes while it is working. */
 settle(snapshot:Readonly<{fingerprint:Readonly<VideoProbeFingerprint>;open:()=>Promise<ReadableStream<Uint8Array<ArrayBuffer>>>}>,signal:AbortSignal):Promise<T>;
}>;
async function settleSnapshot(effect:SnapshotEffect,acquire:VideoProbeAcquire,fingerprint:Readonly<VideoProbeFingerprint>,outerSignal?:AbortSignal){
 const controller=new AbortController(),signal=controller.signal;let available=true,opened=false,cleanupConfirmed=true;
 const pending:Promise<unknown>[]=[],readers:ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>[]=[];
 const cancel=()=>controller.abort();outerSignal?.addEventListener("abort",cancel,{once:true});if(outerSignal?.aborted)cancel();
 const refused=()=>new Error("暂存副作用移交不可用。");
 const check=()=>{if(!available||signal.aborted)throw refused();const answer:unknown=effect.isCurrent();if(answer instanceof Promise)void answer.catch(()=>undefined);if(answer!==true||!available||signal.aborted)throw refused();};
 const accessor=Object.freeze({fingerprint,open:()=>{
  const task=(async()=>{check();if(opened)throw refused();opened=true;const {source,fingerprint:pinned}=await acquire();
   try{check();if(pinned.sha256!==fingerprint.sha256||pinned.bytes!==fingerprint.bytes||source.byteLength!==fingerprint.bytes)throw refused();
    const reader=source.stream(0,fingerprint.bytes-1).getReader();readers.push(reader);let count=0,cancelled=false;
    return new ReadableStream<Uint8Array<ArrayBuffer>>({async pull(out){try{if(cancelled)return;check();const item=await reader.read();if(cancelled)return;check();if(item.done){if(count!==fingerprint.bytes)throw refused();out.close();}else{count+=item.value.byteLength;if(count>fingerprint.bytes)throw refused();out.enqueue(item.value);}}catch{try{await reader.cancel();}catch{cleanupConfirmed=false;}if(!cancelled)out.error(refused());}},async cancel(){cancelled=true;try{await reader.cancel();}catch{cleanupConfirmed=false;throw refused();}}},{highWaterMark:0});
   }catch{try{await source.close();}catch{cleanupConfirmed=false;}throw refused();}
  })();pending.push(task);void task.catch(()=>undefined);return task;
 }});
 let result:EffectResult=Object.freeze({status:"unconfirmed"});
 try{check();const outcome=await effect.settle(accessor,signal);result=Object.freeze({status:"settled",outcome});}catch{/* Never infer no side effect from a rejected callback. */}
 finally{available=false;cancel();outerSignal?.removeEventListener("abort",cancel);await Promise.allSettled(pending);for(const reader of readers)try{await reader.cancel();}catch{cleanupConfirmed=false;}}
 return {result,cleanupConfirmed};
}

async function consumeSnapshot(handoff: SnapshotHandoff, acquire: VideoProbeAcquire,
  fingerprint: Readonly<VideoProbeFingerprint>, outerSignal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController(), signal = controller.signal;
  let available = true, opened = false, complete = false;
  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined;
  const refused = () => new Error("已验证的暂存输入不可用。");
  const check = () => {
    if (!available || signal.aborted || outerSignal?.aborted || handoff.isCurrent() !== true) throw refused();
  };
  const cancel = () => controller.abort();
  outerSignal?.addEventListener("abort", cancel, { once: true });
  if (outerSignal?.aborted) cancel();
  const accessor = Object.freeze({ fingerprint, async open() {
    check();
    if (opened) throw refused();
    opened = true;
    const { source, fingerprint: pinned } = await acquire();
    try {
      check();
      if (pinned.sha256 !== fingerprint.sha256 || pinned.bytes !== fingerprint.bytes
        || source.byteLength !== fingerprint.bytes) throw refused();
      const input = source.stream(0, fingerprint.bytes - 1).getReader();
      reader = input;
      let count = 0, cancelled = false;
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        async pull(out) {
          try {
            if (cancelled) return;
            check();
            const item = await input.read();
            if (cancelled) return;
            check();
            if (item.done) {
              if (count !== fingerprint.bytes) throw refused();
              complete = true;
              out.close();
            } else {
              count += item.value.byteLength;
              if (count > fingerprint.bytes) throw refused();
              out.enqueue(item.value);
            }
          } catch {
            await input.cancel().catch(() => undefined);
            if (!cancelled) out.error(refused());
          }
        },
        async cancel() { cancelled = true; await input.cancel(); },
      }, { highWaterMark: 0 });
    } catch {
      await source.close();
      throw refused();
    }
  } });
  try {
    check();
    const aborted = new Promise<false>(resolve =>
      signal.addEventListener("abort", () => resolve(false), { once: true }));
    const result = await Promise.race([aborted, Promise.resolve().then(async () => {
      check();
      await handoff.consume(accessor, signal);
      return true;
    })]);
    check();
    return result && complete;
  } catch { return false; }
  finally {
    available = false;
    cancel();
    outerSignal?.removeEventListener("abort", cancel);
    if (reader && !complete) await reader.cancel().catch(() => undefined);
  }
}

/** Main-only decode preparation. A presented frame is not complete decode, publication or playback readiness. */
export async function createVideoDecodePreparation(options: {
  stagingParent: string; registry: VideoProbeRegistry; probe: NativeDecoderHost; deadlineMs?: number;
  /** Trusted host confirms this document's own probe has stopped before staged bytes are discarded.
   * A timeout does not cancel the hook: late settlement must never trigger stage deletion. */
  stopProbe?: (owner: Readonly<VideoProbeOwner>) => boolean | Promise<boolean>;
  stopProbeTimeoutMs?: number;
}) {
  const { registry, probe, deadlineMs = 8_000, stopProbe, stopProbeTimeoutMs = 1_000 } = options;
  if (!Number.isSafeInteger(stopProbeTimeoutMs) || stopProbeTimeoutMs < 1 || stopProbeTimeoutMs > 1_000 ||
      (stopProbe !== undefined && typeof stopProbe !== "function")) throw new Error("无效的视频清理时限。");
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 15_000) throw new Error("无效的视频探测时限。");
  const stage = await createMp4Stage(options.stagingParent);
  return async (input: Intake, ownerInput: VideoProbeOwner, outerSignal?: AbortSignal,
    handoff?: SnapshotHandoff, effect?: SnapshotEffect): Promise<Preparation> => {
    const controller = new AbortController(), signal = controller.signal;
    let timedOut = false, inputCloseConfirmed = true, consumed = false;
    let effectResult:EffectResult|undefined;
    const cancel = () => controller.abort();
    outerSignal?.addEventListener("abort", cancel, { once: true });
    if (outerSignal?.aborted) cancel();
    let staged: Awaited<ReturnType<typeof stage>> | undefined, token: ReturnType<typeof registry.issue> | undefined;
    let cleanup: Cleanup = "not-created", failure: Unsuccessful = "staging-failed";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let evidence: Readonly<z.infer<typeof evidenceSchema>> | undefined;
    let fingerprint: Readonly<VideoProbeFingerprint> | undefined;
    let probeOwner: Readonly<VideoProbeOwner> | undefined;
    const timeout = () => { timedOut = true; cancel(); };
    const onStopped = () => { if (token) registry.revoke(token.id); };
    signal.addEventListener("abort", onStopped, { once: true });
    try {
      if ((handoff && effect) || (effect && effect.mode!=="await-settlement") || ((handoff || effect) && !stopProbe)) {
        failure = "handoff-rejected";
        throw new Error("暂存移交需要明确的原生停止确认。");
      }
      const owner = probeOwner = Object.freeze({ ownerId: ownerInput.ownerId, documentId: ownerInput.documentId });
      staged = await stage(input, signal);
      if (staged.status !== "staged") cleanup = staged.cleanup;
      else if (!signal.aborted) {
        failure = "probe-rejected";
        fingerprint = staged.snapshot.fingerprint;
        const { acquire } = staged.snapshot;
        let pinnedBytesAcquired = false;
        const issued = registry.issue({ ...owner, fingerprint }, async () => {
          const acquired = await acquire();
          pinnedBytesAcquired = true;
          return acquired;
        });
        token = issued;
        const expires = performance.now() + deadlineMs;
        const aborted = Symbol("probe stopped");
        const stop = <T>(result: T) => new Promise<T>(resolve => {
          if (signal.aborted) resolve(result);
          else signal.addEventListener("abort", () => resolve(result), { once: true });
        });
        timer = setTimeout(timeout, deadlineMs);
        // Race a host that fails to settle on abort; do not reuse or accept a late reply.
        const reply = await Promise.race([stop(aborted), Promise.resolve().then(() => {
          if (signal.aborted || !registry.accepts(issued.id, owner)) return aborted;
          return probe(issued.url, owner, signal);
        })]);
        if (performance.now() >= expires) timeout();
        if (!signal.aborted && reply !== aborted && pinnedBytesAcquired && registry.accepts(issued.id, owner)) {
          const parsed = resultSchema.safeParse(reply);
          if (parsed.success) evidence = Object.freeze(parsed.data.evidence);
        }
      }
    } catch { /* Report a fixed status; no native exception, path or capability leaves this coordinator. */ }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (token) registry.revoke(token.id);
      signal.removeEventListener("abort", onStopped);
      // Stop native activity even after a positive result before releasing the staged bytes.
      cancel();
      if (staged?.status === "staged") {
        let stopped = stopProbe === undefined;
        if (stopProbe && probeOwner) {
          let stopTimer: ReturnType<typeof setTimeout> | undefined;
          const stopExpires = performance.now() + stopProbeTimeoutMs;
          try {
            stopped = await Promise.race([
              Promise.resolve().then(() => stopProbe(probeOwner!)).then(value => value === true, () => false),
              new Promise<boolean>(resolve => { stopTimer = setTimeout(() => resolve(false), stopProbeTimeoutMs); }),
            ]);
            if (performance.now() >= stopExpires) stopped = false;
          } catch { stopped = false; }
          finally { if (stopTimer !== undefined) clearTimeout(stopTimer); }
        }
        if (!stopped) cleanup = "retained-or-unknown";
        else {
          if (handoff && evidence && fingerprint) {
            // The optional handoff always requires explicit positive native teardown acknowledgement.
            consumed = !!stopProbe && !outerSignal?.aborted &&
              await consumeSnapshot(handoff, staged.snapshot.acquire, fingerprint, outerSignal);
            if (!consumed) { evidence = undefined; failure = "handoff-rejected"; }
          }
          let effectCleanup=true;
          if(effect&&evidence&&fingerprint&&!handoff){
            const settled=await settleSnapshot(effect,staged.snapshot.acquire,fingerprint,outerSignal);
            effectResult=settled.result;effectCleanup=settled.cleanupConfirmed;
            if(effectResult.status!=="settled"){evidence=undefined;failure="handoff-rejected";}
          }
          if(!effectCleanup)cleanup="retained-or-unknown";
          else try { cleanup = await staged.discard(); } catch { cleanup = "retained-or-unknown"; }
        }
      }
      try { await input.close(); } catch { inputCloseConfirmed = false; }
      outerSignal?.removeEventListener("abort", cancel);
    }
    if (!inputCloseConfirmed || cleanup === "retained-or-unknown")
      return Object.freeze({ status: "cleanup-unconfirmed", cleanup, inputCloseConfirmed,...(effectResult?{effect:effectResult}:{}) });
    if (outerSignal?.aborted) failure = "cancelled";
    else if (timedOut) failure = "deadline";
    else if (fingerprint && evidence && cleanup === "removed") {
      let current = !handoff && !effect;
      if(effect)try{const answer:unknown=effect.isCurrent();if(answer instanceof Promise)void answer.catch(()=>undefined);current=answer===true&&!outerSignal?.aborted;}catch{}
      if (handoff) try { current = handoff.isCurrent() === true; } catch { /* Fixed rejection. */ }
      if (current) return Object.freeze({ status: "first-frame-observed", cleanup, evidence, fingerprint,
        ...(effectResult?{effect:effectResult}:{}),
        ...(consumed ? { handoff: "consumed" as const } : {}) });
      failure = outerSignal?.aborted ? "cancelled" : "handoff-rejected";
    }
    return Object.freeze({ status: failure, cleanup, inputCloseConfirmed,...(effectResult?{effect:effectResult}:{}) });
  };
}
