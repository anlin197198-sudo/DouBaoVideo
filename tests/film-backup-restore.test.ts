import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { WorkspaceRepository } from "../src/main/infrastructure/workspace-repository";
import { WorkspaceBackup } from "../src/main/infrastructure/workspace-backup";
import { validateBackupDirectory } from "../src/main/infrastructure/backup-validation";
import { IsolatedRestore } from "../src/main/infrastructure/isolated-restore";
import { createRegisteredVideoLookup } from "../src/main/infrastructure/registered-video-source";
import { registeredVideoResponse } from "../src/main/application/registered-video-response";
import type { WorkspaceSnapshot } from "../src/shared/models";

// Synthetic historical metadata and arbitrary bytes, not a playable/decoded video.
test("V7 film metadata restores without video bytes, path projection or implicit read registration", async () => {
 const root = mkdtempSync(join(tmpdir(), "film-backup-restore-"));
 const live = join(root, "live"), backups = join(root, "backups"), output = join(root, "restores");
 for (const directory of [live, backups, output, join(live, "media"), join(live, "media", "videos")]) mkdirSync(directory);
 const db = new ApplicationDatabase(join(live, "workspace.sqlite"));
 let restored: ApplicationDatabase | null = null;
 try {
  const repository = new WorkspaceRepository(db);
  const task = db.transaction(() => repository.createPlan({ title: "合成历史成片", style: "comic", startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
  const executionId = randomUUID(), filmId = randomUUID();
  const sourcePath = join(live, "media", "videos", "PRIVATE_SOURCE_ONLY.mp4");
  const bytes = Buffer.from("Synthetic archived bytes; no actual codec or provider involved.");
  writeFileSync(sourcePath, bytes);
  db.connection.prepare("INSERT INTO executions(id,task_id,operation,status,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
   .run(executionId, task.id, "local-import", "recorded", "{}", "2026-11-19T00:00:00.000Z", "2026-11-19T00:00:00.000Z");
  db.connection.prepare("INSERT INTO films(id,execution_id,task_id,file_path,version,created_at) VALUES(?,?,?,?,?,?)")
   .run(filmId, executionId, task.id, sourcePath, 2, "2026-11-19T01:00:00.000Z");
  const business = (database: ApplicationDatabase) => Object.fromEntries(["plans", "tasks", "executions", "films"].map(table => [table, database.connection.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const originalBusiness = business(db), originalSnapshot = repository.snapshot();
  // This fixture contains no reference images. Any decode invocation is a failure.
  const decode = async (_bytes: Buffer): Promise<{ png: Buffer; width: number; height: number }> => { throw new Error("unexpected synthetic image decode"); };
  const backup = await new WorkspaceBackup({ database: db, mediaDirectory: join(live, "media"), applicationVersion: "synthetic-test", chooseDirectory: async () => backups, decode }).create();
  assert.ok(backup); assert.equal(backup.databaseVersion, 7); assert.equal(backup.filmRecordCount, 1);
  const tree = (directory: string, prefix = ""): [string, string][] => readdirSync(directory, { withFileTypes: true }).flatMap<[string, string]>(entry => {
   const relative = prefix + entry.name, path = join(directory, entry.name);
   return entry.isDirectory() ? tree(path, relative + "/") : [[relative, createHash("sha256").update(readFileSync(path)).digest("hex")]];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const originalBackup = tree(backup.directory);
  assert.deepEqual(originalBackup.map(([name]) => name), ["manifest.json", "workspace.sqlite"]);
  const manifest = JSON.parse(readFileSync(join(backup.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.databaseVersion, 7); assert.equal(manifest.videoFilesIncluded, false); assert.equal(manifest.filmRecordCount, 1);
  assert.ok(manifest.excluded.includes("video files"));
  await validateBackupDirectory(backup.directory, decode);
  const result = await new IsolatedRestore({ currentWorkspace: live, decode }).restore(backup.directory, output);
  assert.equal(result.workspaceActivated, false); assert.equal(result.videoFilesIncluded, false); assert.notEqual(result.directory, live);
  assert.equal(existsSync(join(result.directory, "media", "videos")), false);
  assert.deepEqual(tree(result.directory), originalBackup);
  restored = new ApplicationDatabase(join(result.directory, "workspace.sqlite"));
  assert.equal(restored.connection.prepare("PRAGMA user_version").get()!.user_version, 7);
  assert.deepEqual(business(restored), originalBusiness);
  const snapshot = new WorkspaceRepository(restored).snapshot();
  assert.deepEqual(snapshot.films, originalSnapshot.films);
  assert.equal(snapshot.films[0]!.id, filmId); assert.equal(snapshot.films[0]!.version, 2);
  assert.equal(snapshot.films[0]!.provenance, "local-import");
  assert.doesNotMatch(JSON.stringify(snapshot.films), /PRIVATE_SOURCE_ONLY|filePath|file_path/);
  const modulePath = "../src/renderer/src/pages/FilmsPage.tsx";
  const Page = (await import(modulePath)).FilmsPage as ComponentType<{ snapshot: Pick<WorkspaceSnapshot, "films" | "tasks"> }>;
  const html = renderToStaticMarkup(createElement(Page, { snapshot }));
  assert.match(html, /合成历史成片/); assert.match(html, /版本 2/); assert.match(html, /记录来源：本地导入/); assert.match(html, /文件可读性及媒体有效性未验证/);
  assert.doesNotMatch(html, /PRIVATE_SOURCE_ONLY|<video|<a\s/); assert.ok(!html.includes(sourcePath));
  // Even an existing source file and a restored film row grant no read authority.
  const lookup = await createRegisteredVideoLookup(join(live, "media", "videos"), []);
  assert.equal(await lookup(filmId), null);
  const response = await registeredVideoResponse({ url: `app://video/${filmId}`, method: "GET", headers: new Headers() }, lookup);
  assert.equal(response.status, 404); assert.ok(!(await response.text()).includes(sourcePath));
  assert.deepEqual(readFileSync(sourcePath), bytes);
  assert.deepEqual(business(db), originalBusiness);
  assert.deepEqual(tree(backup.directory), originalBackup);
  assert.equal(db.connection.prepare("SELECT count(*) AS n FROM executions").get()!.n, 1);
  assert.equal(restored.connection.prepare("SELECT count(*) AS n FROM executions").get()!.n, 1);
 } finally { restored?.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});
