import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

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
      {
        name: "development-refresh-policy",
        apply: "serve",
        transformIndexHtml(html) {
          return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
        },
      },
    ],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
