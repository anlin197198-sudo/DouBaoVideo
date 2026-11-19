import { registeredVideoRange } from "./registered-video-range";

export interface RegisteredVideoSource {
  /** Exact positive size from a trusted read handle after media/identity validation. */
  byteLength: number;
  /** Transfer ownership of the verified source to a stream; it owns close on EOF/error/cancel. */
  stream(start: number, endInclusive: number): ReadableStream<Uint8Array<ArrayBuffer>>;
  /** Close an acquired source if no stream took ownership. */
  close(): void | Promise<void>;
}

type RegisteredVideoLookup = (registeredId: string) => Promise<RegisteredVideoSource | null>;
const exactVideoUrl = /^app:\/\/video\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const privateHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

/** Dormant protocol policy: no disk paths, no app-scheme wiring and no production registration.
 * The injected layer must only resolve explicitly verified app-owned movies, never legacy path rows. */
export async function registeredVideoResponse(
  request: Pick<Request, "url" | "method" | "headers">, lookup: RegisteredVideoLookup,
): Promise<Response> {
  const unavailable = () => new Response(null, { status: 404, headers: privateHeaders });
  let source: RegisteredVideoSource | null = null;
  let body: ReadableStream<Uint8Array<ArrayBuffer>> | null = null;
  let streamOwnsSource = false;
  try {
    const id = exactVideoUrl.exec(request.url)?.[1];
    if (!id || (request.method !== "GET" && request.method !== "HEAD")) return unavailable();
    source = await lookup(id);
    if (!source) return unavailable();
    const partial = registeredVideoRange(request.method === "GET" ? request.headers.get("range") : null, source.byteLength);
    const headers = new Headers({ ...privateHeaders, "Accept-Ranges": "bytes" });
    if (partial.kind === "invalid-file") return unavailable();
    if (partial.kind === "unsatisfiable") {
      headers.set("Content-Range", partial.contentRange);
      return new Response(null, { status: 416, headers });
    }
    headers.set("Content-Type", "video/mp4");
    headers.set("Content-Length", String(partial.length));
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });
    if (partial.kind === "partial") headers.set("Content-Range", partial.contentRange);
    body = source.stream(partial.start, partial.end);
    const response = new Response(body, { status: partial.kind === "partial" ? 206 : 200, headers });
    streamOwnsSource = true;
    return response;
  } catch {
    return unavailable();
  } finally {
    if (!streamOwnsSource && source) {
      try {
        if (body) await body.cancel(); else await source.close();
      } catch { /* No paths or internal resource errors in the response. */ }
    }
  }
}
