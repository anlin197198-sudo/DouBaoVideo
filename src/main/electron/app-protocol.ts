import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

export function registerApplicationProtocol(rendererDirectory: string, getImagePath?: (id: string) => string | null): void {
  protocol.handle("app", (request) => {
    try {
      const url = new URL(request.url);
      if (url.host === "media") {
        const id = url.pathname.slice(1);
        const filePath = request.method === "GET" ? getImagePath?.(id) : null;
        return filePath ? net.fetch(pathToFileURL(filePath).toString()) : new Response("Not found", { status: 404 });
      }
      if (url.host !== "renderer")
        return new Response("Not found", { status: 404 });
      const pathname = decodeURIComponent(url.pathname);
      const filePath = resolve(
        rendererDirectory,
        "." + (pathname === "/" ? "/index.html" : pathname),
      );
      const localPath = relative(rendererDirectory, filePath);
      if (
        localPath === ".." ||
        localPath.startsWith(".." + sep) ||
        isAbsolute(localPath) ||
        !existsSync(filePath) ||
        !statSync(filePath).isFile()
      ) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    } catch {
      return new Response("Invalid request", { status: 400 });
    }
  });
}
