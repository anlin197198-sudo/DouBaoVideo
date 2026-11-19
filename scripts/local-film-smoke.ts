import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredVideoResponse } from "../src/main/application/registered-video-response";
import { createRegisteredVideoLookup } from "../src/main/infrastructure/registered-video-source";
import { writeVerifiedVideoBytes } from "../src/main/infrastructure/video-byte-writer";

function run(executable: "ffmpeg" | "ffprobe", args: string[]) {
  const result = spawnSync(executable, args, {
    stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    timeout: 15_000, maxBuffer: 512 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`${executable} failed or is unavailable. This optional check requires local FFmpeg tools.`);
  return result.stdout;
}

async function smoke() {
  if (process.argv.length !== 2) throw new Error("This check accepts no paths, credentials, or external input.");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "dvb-synthetic-film-"));
  try {
    const fixture = join(directory, "synthetic-input.mp4");
    run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-n", "-f", "lavfi", "-i",
      "testsrc2=size=160x90:rate=12", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-threads", "1", "-movflags", "+faststart", fixture]);
    const bytes = await readFile(fixture);
    assert.ok(bytes.length > 200 && bytes.length < 512 * 1024);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const identity = { title: "成片合成烟测", taskId: randomUUID(), executionId: randomUUID(), version: 1 };
    const result = await writeVerifiedVideoBytes({
      directory, identity, expectedBytes: bytes.length, expectedSha256: sha256, chunks: createReadStream(fixture),
    });
    assert.equal(result.status, "published");
    assert.equal(result.cleanup, "removed");
    const { dev, ino } = await lstat(result.target);
    const registered = randomUUID();
    const lookup = await createRegisteredVideoLookup(directory, [{ id: registered, identity, bytes: bytes.length, sha256, dev, ino }]);
    const url = `app://video/${registered}`;
    const full = await registeredVideoResponse(new Request(url), lookup);
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
    const tail = await registeredVideoResponse(new Request(url, { headers: { Range: "bytes=-100" } }), lookup);
    assert.equal(tail.status, 206);
    assert.equal(tail.headers.get("content-range"), `bytes ${bytes.length - 100}-${bytes.length - 1}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(-100));
    const metadata = JSON.parse(run("ffprobe", ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,nb_frames", "-of", "json", result.target])) as {
        streams: Array<{ codec_name: string; width: number; height: number; nb_frames: string }>;
      };
    assert.deepEqual(metadata.streams, [{ codec_name: "h264", width: 160, height: 90, nb_frames: "12" }]);
    run("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-xerror", "-threads", "1",
      "-i", result.target, "-map", "0:v:0", "-f", "null", "-"]);
    console.log("Synthetic H.264 MP4: archived, exact full/range bytes verified and all frames decoded with local FFmpeg.");
    console.log("No application player, Windows runtime, provider, or user media was exercised.");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

smoke().catch(() => {
  console.error("Synthetic local film smoke failed. Check the archive and decoder; ffmpeg with libx264 and ffprobe are prerequisites.");
  process.exitCode = 1;
});
