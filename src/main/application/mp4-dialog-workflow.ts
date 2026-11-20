import { z } from "zod";
import type { intakeMp4, Mp4Selection } from "../infrastructure/mp4-intake";
import { storyboardApprovalOwner } from "./storyboard-dialog-owner";

const requestSchema = z.object({ taskId: z.string().uuid(), revision: z.number().int().nonnegative().safe() }).strict();
type Binding = Readonly<z.infer<typeof requestSchema>>;
type Media = Awaited<ReturnType<typeof intakeMp4>>;

interface Ports<W extends object> {
  window(): W | null;
  epoch(window: W): number;
  live(window: W): boolean;
  /** Must check the initiating editor session as well as persisted task identity/revision. */
  current(binding: Binding): boolean;
  select(window: W): Promise<{ canceled: boolean; filePaths: string[] }>;
  snapshot(path: string): Promise<Mp4Selection>;
  intake(path: string, snapshot: Mp4Selection, signal: AbortSignal): Promise<Media>;
  /** Trusted main-only inspection, no publication or reservation. Do not retain media or stream.
   * Any future mutating consumer requires its own durable fencing, not just a freshness check here. */
  inspect(binding: Binding, media: Pick<Media, "evidence" | "stream">, stillCurrent: () => boolean, signal: AbortSignal): Promise<void>;
}

export type Mp4DialogStatus =
  "invalid-request" | "in-flight" | "stale" | "cancelled" | "inspected" | "failed";

export function createMp4DialogWorkflow<W extends object>(ports: Ports<W>) {
  let running = false;
  return async (raw: unknown, invalidation?: AbortSignal): Promise<Mp4DialogStatus> => {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return "invalid-request";
    if (running) return "in-flight";
    const binding = Object.freeze(parsed.data);
    const owner = ports.window();
    if (!owner || !ports.live(owner)) return "stale";
    const ownerIsCurrent = storyboardApprovalOwner(owner, ports.window, ports.epoch, ports.live);
    const controller = new AbortController();
    const invalidate = () => controller.abort();
    const stillCurrent = () => !controller.signal.aborted && !invalidation?.aborted
      && ownerIsCurrent() && ports.current(binding) === true;
    let media: Media | undefined;
    let result: Mp4DialogStatus = "failed";
    async function run(window: W): Promise<Mp4DialogStatus> {
      if (!stillCurrent()) return "stale";
      const selection = await ports.select(window);
      if (!stillCurrent()) return "stale";
      if (selection.canceled || selection.filePaths.length === 0) return "cancelled";
      if (selection.filePaths.length !== 1 || typeof selection.filePaths[0] !== "string"
        || !/\.mp4$/i.test(selection.filePaths[0])) return "failed";
      const path = selection.filePaths[0];
      const snapshot = await ports.snapshot(path);
      if (!stillCurrent()) return "stale";
      media = await ports.intake(path, snapshot, controller.signal);
      if (!stillCurrent()) return "stale";
      const input = media;
      const inspected = Object.freeze({ evidence: input.evidence, stream() {
        if (!stillCurrent()) throw new Error("选择已失效。");
        return input.stream();
      } });
      await ports.inspect(binding, inspected, stillCurrent, controller.signal);
      return stillCurrent() ? "inspected" : "stale";
    }
    running = true;
    invalidation?.addEventListener("abort", invalidate, { once: true });
    try { result = await run(owner); }
    catch {
      try { result = stillCurrent() ? "failed" : "stale"; }
      catch { result = "failed"; }
    } finally {
      try {
        await media?.close();
        if (result === "inspected" && !stillCurrent()) result = "stale";
      } catch { result = "failed"; }
      invalidate();
      invalidation?.removeEventListener("abort", invalidate);
      running = false;
    }
    return result;
  };
}
