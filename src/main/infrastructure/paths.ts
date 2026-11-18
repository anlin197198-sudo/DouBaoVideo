import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function createApplicationPaths(dataDirectory: string) {
  const paths = {
    dataDirectory,
    database: join(dataDirectory, "workspace.sqlite"),
    logs: join(dataDirectory, "logs"),
    media: join(dataDirectory, "media"),
  };
  for (const directory of [paths.dataDirectory, paths.logs, paths.media])
    mkdirSync(directory, { recursive: true });
  return paths;
}
