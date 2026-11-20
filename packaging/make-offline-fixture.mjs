import { lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const width = 320, height = 180;
const script = "【合成验收／非真实剧本】\n场景：空置的演示展台。\n镜头一：浅蓝色展台，左侧出现白色圆点。\n镜头二：橙色展台，右侧出现白色方块。\n";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, content) {
  const data = Buffer.concat([Buffer.from(type, "ascii"), content]), tags = Buffer.alloc(8);
  tags.writeUInt32BE(content.length, 0);
  tags.writeUInt32BE(crc32(data), 4);
  return Buffer.concat([tags.subarray(0, 4), data, tags.subarray(4)]);
}
function png(first) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const stride = 1 + width * 3, scanlines = Buffer.alloc(height * stride);
  const background = first ? [70, 150, 216] : [224, 115, 32], foreground = [246, 248, 251];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const glyph = first ? (x - 80) ** 2 + (y - 90) ** 2 <= 28 ** 2 : Math.abs(x - 240) <= 28 && Math.abs(y - 90) <= 28;
    const rgb = glyph ? foreground : background, offset = y * stride + 1 + x * 3;
    for (let channel = 0; channel < 3; channel++) scanlines[offset + channel] = rgb[channel];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines)), pngChunk("IEND", Buffer.alloc(0))]);
}

export function makeOfflineFixture(parent) {
  if (typeof parent !== "string" || !isAbsolute(parent) || resolve(parent) !== parent || parse(parent).root === parent)
    throw new Error("请指定已存在的规范专用父目录。");
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(parent) !== parent)
    throw new Error("专用父目录不可用。");
  const root = mkdtempSync(join(parent, "doubao-offline-fixture-"));
  const fixtures = [["script.txt", Buffer.from(script, "utf8")], ["first.png", png(true)], ["last.png", png(false)]];
  const files = fixtures.map(([name, bytes]) => {
    writeFileSync(join(root, name), bytes, { flag: "wx", mode: 0o600 });
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  return { root, files };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === "--help")) {
    console.log("Usage: node packaging/make-offline-fixture.mjs --output-parent <absolute-test-directory> (default: no files)");
  } else try {
    if (args.length !== 2 || args[0] !== "--output-parent") throw new Error();
    console.log(JSON.stringify(makeOfflineFixture(args[1]), null, 2));
  } catch {
    console.error("Fixture generation stopped. Choose a dedicated existing canonical test directory; any partial fixture stays there.");
    process.exitCode = 1;
  }
}
