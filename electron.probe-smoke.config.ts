import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { privateVideoProbeManifest } from "./packaging/private-video-probe-manifest";
/** Separate developer-only output. No production main/preload/index build or startup changes. */
export default defineConfig({
 main:{build:{outDir:resolve(".local/f17-native-smoke/main"),rollupOptions:{input:resolve("scripts/f17-native-probe-main.ts"),output:{format:"cjs",entryFileNames:"index.js"}}}},
 renderer:{root:resolve("src/renderer"),plugins:[privateVideoProbeManifest()],build:{outDir:resolve(".local/f17-native-smoke/renderer"),rollupOptions:{input:{"f17-video-probe":resolve("src/renderer/f17-video-probe.html")}}}},
});
