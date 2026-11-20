import { VideoProbeRegistry, type VideoProbeOwner } from "../application/video-probe-registry";
import { createVideoDecodePreparation } from "../application/prepare-video-decode";
import type { intakeMp4 } from "../infrastructure/mp4-intake";
import { createPrivateVideoProbePageLoader } from "./private-video-probe-page-loader";
import { installPrivateVideoProbeProtocol } from "./private-video-probe-protocol";
import { reservePrivateVideoProbeWindow, type PrivateProbeWindowOptions } from "./private-video-probe-window";

// Fixed, main-authored read only. Never interpolate a URL, caller script, path or selector.
const READ_RESULT = "globalThis.__doubaoF17ProbeResult ?? null";
const capability = /^app:\/\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
type Options = { electron: PrivateProbeWindowOptions["electron"]; rendererDirectory: string; signal?: AbortSignal };

/** Main-only, one reservation/one staged capability. Creates a native window only when explicitly
 * called by a qualified host; not called by current startup. The caller must always await stop(). */
export function createPrivateVideoFirstFrameHost(options: Options) {
  // Fail closed before constructing native state if the packaged resources cannot be verified.
  const loadBuiltAsset = createPrivateVideoProbePageLoader(options.rendererDirectory);
  const reservation = reservePrivateVideoProbeWindow({ electron: options.electron, signal: options.signal });
  const owner = reservation.owner;
  const same = (candidate: Readonly<VideoProbeOwner>) => candidate.ownerId === owner.ownerId && candidate.documentId === owner.documentId;
  const registry = new VideoProbeRegistry({ isLive: (ownerId, documentId) =>
    ownerId === owner.ownerId && documentId === owner.documentId && reservation.isLive() });
  let invoked = false, installed = false;
  const stop = async (candidate: Readonly<VideoProbeOwner> = owner) => {
    if (!same(candidate)) return false;
    registry.invalidateOwner(owner.ownerId);
    const result = reservation.close();
    return result.windowClosed && (!installed || result.routeCleanup === "completed");
  };
  const probe = async (url: string, candidate: Readonly<VideoProbeOwner>, signal: AbortSignal): Promise<unknown> => {
    const id = capability.exec(url)?.[1];
    if (invoked || !same(candidate) || !id || signal.aborted || !registry.accepts(id, owner)) return null;
    invoked = true;
    let read: (() => Promise<unknown>) | undefined, abort!: () => void;
    const stopped = new Promise<null>(resolve => { abort = () => { void stop(); resolve(null); }; });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 8_000);
    let success = false;
    try {
      const work = async () => {
        await reservation.loadProbe(id, context => {
          if (!same(context.owner) || !registry.accepts(id, owner) || !context.verifyBinding()) throw Error();
          const contents = context.window.webContents;
          read = () => contents.executeJavaScript(READ_RESULT, false);
          // Installation may fail after native registration: stop must not claim it was removed.
          installed = true;
          return installPrivateVideoProbeProtocol({ session: context.session, owner, registry, loadBuiltAsset,
            verifyExclusiveBinding: (session, bound) => session === context.session && same(bound) && context.verifyBinding() });
        });
        while (!signal.aborted && reservation.isLive() && registry.accepts(id, owner)) {
          const reply = await read!();
          if (signal.aborted || !reservation.isLive() || !registry.accepts(id, owner)) return null;
          if (reply !== null && reply !== undefined) return reply;
          await new Promise<void>(resolve => setTimeout(resolve, 25));
        }
        return null;
      };
      const reply = await Promise.race([work(), stopped]);
      success = reply !== null && reply !== undefined && !signal.aborted && reservation.isLive() && registry.accepts(id, owner);
      return success ? reply : null;
    } catch { return null; }
    finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (!success) await stop();
    }
  };
  return Object.freeze({ owner, registry, probe, stop });
}

/** Complete dormant preparation composition: a private owner exists BEFORE staging issues its
 * token. Native shutdown is awaited before the stage closes its readers and removes its own bytes.
 * This still does not publish/register a film or prove complete-video decode. */
export function createPrivateVideoDecodeInspector(options: Omit<Options, "signal"> & { stagingParent: string }) {
  return async (input: Awaited<ReturnType<typeof intakeMp4>>, signal?: AbortSignal) => {
    let host: ReturnType<typeof createPrivateVideoFirstFrameHost> | undefined, handedOff = false;
    try {
      host = createPrivateVideoFirstFrameHost({ electron: options.electron, rendererDirectory: options.rendererDirectory, signal });
      const prepare = await createVideoDecodePreparation({ stagingParent: options.stagingParent, registry: host.registry,
        probe: host.probe, stopProbe: host.stop });
      handedOff = true;
      return await prepare(input, host.owner, signal);
    } finally {
      await host?.stop();
      if (!handedOff) await input.close();
    }
  };
}
