import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { privateVideoProbeManifest } from "./packaging/private-video-probe-manifest";

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve("src/main/index.ts") } },
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve("src/preload/index.ts"),
        output: { format: "cjs", entryFileNames: "index.cjs" },
      },
    },
  },
  renderer: {
    root: resolve("src/renderer"),
    plugins: [
      react(),
      privateVideoProbeManifest(),
      {
        name: "development-refresh-policy",
        apply: "serve",
        transformIndexHtml(html, context) {
          if (context.path !== "/" && context.path !== "/index.html") return html;
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
        },
      },
    ],
    build: { rollupOptions: { input: {
      index: resolve("src/renderer/index.html"),
      "f17-video-probe": resolve("src/renderer/f17-video-probe.html"),
    } } },
  },
});
