import assert from "node:assert/strict";
import { test } from "node:test";
import { registeredVideoResponse, type RegisteredVideoSource } from "../src/main/application/registered-video-response";

const url = "app://video/a1b2c3d4-0000-4000-8000-000000000123";
function fakeSource(options: { size?: number; fail?: boolean } = {}) {
  const events: unknown[] = [];
  const lookup = async (id: string): Promise<RegisteredVideoSource | null> => {
    events.push(["lookup", id]);
    return {
      byteLength: options.size ?? 8,
      stream(start, end) {
        events.push(["stream", start, end]);
        if (options.fail) throw new Error("private filesystem path");
        return new ReadableStream({
          start(controller) {
            controller.enqueue(Uint8Array.from("01234567".slice(start, end + 1), c => Number(c)));
          },
          cancel() { events.push("cancelled"); },
        });
      },
      close() { events.push("closed"); },
    };
  };
  return { events, lookup };
}

test("video policy serves the verified source range and transfers cancellation ownership", async () => {
  const { events, lookup } = fakeSource();
  const response = await registeredVideoResponse(new Request(url, { headers: { Range: "bytes=2-4" } }), lookup);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 2-4/8");
  assert.equal(response.headers.get("content-length"), "3");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("content-type"), "video/mp4");
  const reader = response.body!.getReader();
  assert.deepEqual((await reader.read()).value, Uint8Array.of(2, 3, 4));
  await reader.cancel();
  assert.deepEqual(events.slice(1), [["stream", 2, 4], "cancelled"]);
});

test("video policy closes without streaming on HEAD, invalid range, invalid source, or stream acquisition failure", async () => {
  const request = (method: string, range: string) => new Request(url, { method, headers: { Range: range } });
  for (const [method, range, options, status] of [
    ["HEAD", "bytes=2-4", {}, 200], ["GET", "bytes=9-", {}, 416],
    ["GET", "bytes=2-4", { size: 0 }, 404], ["GET", "bytes=2-4", { fail: true }, 404],
  ] as const) {
    const { events, lookup } = fakeSource(options);
    const response = await registeredVideoResponse(request(method, range), lookup);
    assert.equal(response.status, status);
    assert.equal(response.body, null);
    assert.equal(events.at(-1), "closed");
    if (status === 416) assert.equal(response.headers.get("content-range"), "bytes */8");
    if (method === "HEAD") assert.equal(response.headers.get("content-length"), "8");
  }
});

test("video policy never looks up external paths, decorated URLs or unsupported methods", async () => {
  const { events, lookup } = fakeSource();
  for (const [badUrl, method] of [
    [url + "?path=/tmp/movie", "GET"], [url + "#fragment", "GET"], [url + "/", "GET"],
    [url.replace("video", "media"), "GET"], [url.replace("a1", "A1"), "GET"], [url, "POST"],
    ["file:///tmp/movie.mp4", "GET"], [url.replace("app://", "app://user@"), "GET"],
  ]) {
    const response = await registeredVideoResponse({ url: badUrl!, method: method!, headers: new Headers() }, lookup);
    assert.equal(response.status, 404);
  }
  assert.deepEqual(events, []);
  assert.equal((await registeredVideoResponse(new Request(url), async () => null)).status, 404);
});
