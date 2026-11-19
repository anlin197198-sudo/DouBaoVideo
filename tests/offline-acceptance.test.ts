import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { ReferenceImageStore } from "../src/main/infrastructure/reference-image-store";
import { WorkspaceBackup } from "../src/main/infrastructure/workspace-backup";
import { validateBackupDirectory } from "../src/main/infrastructure/backup-validation";
import { IsolatedRestore } from "../src/main/infrastructure/isolated-restore";
import { createApplicationServices } from "../src/main/application/services";
import { addShot, editScript } from "../src/shared/storyboard";
import { addAsset } from "../src/shared/assets";
import { setAssetLink } from "../src/shared/asset-links";
import { previewAssetLinks, adoptAssetLinkSuggestions } from "../src/shared/asset-link-suggestions";
import { editPrompt } from "../src/shared/prompts";
import { addFrameCandidate, chooseFrame, currentFrame, hasCurrentConfirmation } from "../src/shared/frames";
import type { CommandInputs, CommandName, CommandOutputs } from "../src/shared/bridge";

const decode = async (bytes: Buffer) => {
  const image = await sharp(bytes).png().toBuffer({ resolveWithObject: true });
  return { png: image.data, width: image.info.width, height: image.info.height };
};
function fingerprints(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  function visit(relative: string) {
    for (const item of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) visit(path);
      else { assert.equal(item.isFile(), true); files[path] = createHash("sha256").update(readFileSync(join(directory, path))).digest("hex"); }
    }
  }
  visit(""); return files;
}
function openWorkspace(directory: string, backupParent: string) {
  const database = new ApplicationDatabase(join(directory, "workspace.sqlite"));
  const store = new ReferenceImageStore(database, join(directory, "media"), decode);
  let selectedFile: string | null = null;
  const backups = new WorkspaceBackup({ database, mediaDirectory: join(directory, "media"), applicationVersion: "synthetic-offline-acceptance", decode, chooseDirectory: async () => backupParent });
  const services = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() { throw new Error("No account sessions in offline acceptance"); } },
    version: "test", dataDirectory: directory, backups,
    references: { async importForTask(taskId) { const selected = selectedFile; selectedFile = null; return selected ? store.importFile(taskId, selected) : null; }, isAvailable: id => store.isAvailable(id) } });
  async function run<K extends CommandName>(command: K, input: CommandInputs[K]): Promise<CommandOutputs[K]> {
    const result = await services.router.dispatch({ requestId: randomUUID(), command, input }, { trusted: true });
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data as CommandOutputs[K];
  }
  return { database, store, run, select(path: string) { selectedFile = path; } };
}

test("offline manual production through closed reopen, V7 backup validation and isolated restore preserves complete audited business content", async () => {
  const root = mkdtempSync(join(tmpdir(), "doubao-offline-acceptance-")), live = join(root, "live"), backups = join(root, "backups"), restoredParent = join(root, "isolated");
  for (const directory of [live, backups, restoredParent]) mkdirSync(directory);
  let source = openWorkspace(live, backups);
  let restored: ReturnType<typeof openWorkspace> | undefined;
  try {
    const { plan, tasks } = await source.run("plans.create", { title: "手动车站短片", style: "comic", styleNotes: "水墨色彩，人物造型一致", startDate: "2026-11-19", dailyCount: 1, executionTime: "19:30" });
    assert.equal(tasks.length, 7); assert.deepEqual(tasks.map(t => t.businessDate), ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25"]);
    let task = tasks[0]!;
    task = await source.run("tasks.saveWorkspace", { id: task.id, expectedRevision: task.revision, workspace: editScript(task.workspace, "旅客进入车站。") });
    let w = editScript(task.workspace, "旅客走进车站，握住提灯回望。");
    const firstShot = randomUUID(), lastShot = randomUUID();
    w = addShot(addShot(w, firstShot), lastShot);
    w = { ...w, shots: w.shots.map((shot, i) => ({ ...shot, title: i ? "旅客回望" : "旅客到站", description: "车站晨光", action: i ? "抬手照明" : "缓慢前行" })),
      viewport: { x: -100, y: 70, zoom: 0.75 }, productionPositions: { "prompt:video": { x: 1400, y: 180 }, "frame:first": { x: 1700, y: 80 }, "frame:last": { x: 1700, y: 470 } } };
    const person = randomUUID(), scene = randomUUID(), prop = randomUUID();
    w = addAsset(addAsset(addAsset(w, person, "person"), scene, "scene"), prop, "prop");
    w = { ...w, assets: w.assets.map(asset => ({ ...asset, name: asset.id === person ? "旅客" : asset.id === scene ? "车站" : "提灯", description: "手工录入一致设定" })) };
    const preview = previewAssetLinks(w);
    assert.equal(preview.suggestions.length, 4);
    w = adoptAssetLinkSuggestions(w, preview, preview.suggestions.map(s => s.id));
    w = setAssetLink(w, prop, lastShot, true);
    assert.equal(w.assetLinks.length, 5);
    assert.equal(w.assetLinks.filter(link => link.assetId === person).length, 2);
    assert.deepEqual(w.assetLinks.filter(link => link.assetId === prop).map(link => link.shotId), [lastShot]);
    for (const shot of w.shots) w = editPrompt(w, plan, "shot", shot.id, `手写镜头词：${shot.title}`);
    for (const kind of ["firstFrame", "lastFrame", "video"] as const) w = editPrompt(w, plan, kind, null, `手写${kind}提示词`);
    task = await source.run("tasks.saveWorkspace", { id: task.id, expectedRevision: task.revision, workspace: w });
    task = await source.run("tasks.saveWorkspace", { id: task.id, expectedRevision: task.revision, workspace: editPrompt(task.workspace, plan, "video", null, "手写视频修订：从到站过渡到回望。") });
    w = task.workspace;
    const sourceFiles: string[] = [], pixels = new Map<string, Buffer>();
    for (const [slot, color, width, height] of [["first", "#145f32", 96, 64], ["last", "#cb7531", 80, 120]] as const) {
      const path = join(root, `${slot}.png`); sourceFiles.push(path);
      writeFileSync(path, await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer());
      source.select(path); const image = await source.run("assets.importReference", { taskId: task.id }); assert.ok(image);
      assert.equal(image.width, width); assert.equal(image.height, height);
      pixels.set(image.id, source.store.readVerifiedBytes(image.id)!);
      const candidateId = randomUUID(); w = chooseFrame(addFrameCandidate(w, plan, slot, image.id, candidateId, "2026-11-19T12:00:00.000Z"), slot, candidateId);
    }
    task = await source.run("tasks.saveWorkspace", { id: task.id, expectedRevision: task.revision, workspace: w });
    task = await source.run("tasks.confirmFrames", { id: task.id, expectedRevision: task.revision });
    assert.equal(hasCurrentConfirmation(task.workspace, plan), true);
    assert.notEqual(currentFrame(task.workspace, "first")!.imageId, currentFrame(task.workspace, "last")!.imageId);
    const confirmation = JSON.parse(task.workspace.frames!.confirmation!.inputSnapshot);
    assert.equal(confirmation.first.slot, "first"); assert.equal(confirmation.last.slot, "last");
    assert.match(confirmation.videoInput, /水墨色彩/);
    const expected = await source.run("workspace.read", {});
    const scriptHistory = await source.run("scripts.historyList", { taskId: task.id }); assert.deepEqual(scriptHistory.items.map(item => item.version), [2, 1]);
    const scriptDetails = await Promise.all(scriptHistory.items.map(item => source.run("scripts.historyDetail", { taskId: task.id, version: item.version })));
    const promptDetails = [];
    for (const prompt of task.workspace.prompts!) {
      const page = await source.run("prompts.historyList", { taskId: task.id, kind: prompt.kind, shotId: prompt.shotId });
      for (const item of page.items) promptDetails.push({ kind: prompt.kind, shotId: prompt.shotId,
        detail: await source.run("prompts.historyDetail", { taskId: task.id, kind: prompt.kind, shotId: prompt.shotId, version: item.version }) });
    }
    assert.equal(promptDetails.length, 6);
    source.database.close(); assert.equal(source.database.connection.isOpen, false);
    for (const file of sourceFiles) renameSync(file, `${file}.moved`);
    source = openWorkspace(live, backups);
    assert.deepEqual(await source.run("workspace.read", {}), expected);
    const backup = await source.run("workspace.backup", {}); assert.ok(backup); assert.equal(backup.databaseVersion, 7);
    const backupBefore = fingerprints(backup.directory);
    assert.equal(Object.keys(backupBefore).length, 4); // manifest + database + 2 archived PNGs
    const validation = await validateBackupDirectory(backup.directory, decode);
    assert.equal(validation.databaseVersion, 7); assert.equal(validation.taskCount, 7); assert.equal(validation.imageCount, 2);
    source.database.close(); // No live application DB handles during the restore/readback phase.
    const liveBefore = fingerprints(live);
    const result = await new IsolatedRestore({ currentWorkspace: live, decode }).restore(backup.directory, restoredParent);
    assert.equal(result.workspaceActivated, false); assert.equal(result.isolated, true); assert.equal(result.videoFilesIncluded, false);
    assert.notEqual(result.directory, live); assert.notEqual(result.directory, backup.directory); assert.equal(readdirSync(restoredParent).length, 1);
    restored = openWorkspace(result.directory, backups);
    assert.deepEqual(await restored.run("workspace.read", {}), expected);
    assert.deepEqual(await restored.run("scripts.historyList", { taskId: task.id }), scriptHistory);
    for (const detail of scriptDetails) assert.deepEqual(await restored.run("scripts.historyDetail", { taskId: task.id, version: detail.version }), detail);
    for (const { kind, shotId, detail } of promptDetails) assert.deepEqual(await restored.run("prompts.historyDetail", { taskId: task.id, kind, shotId, version: detail.version }), detail);
    const recovered = (await restored.run("workspace.read", {})).tasks.find(t => t.id === task.id)!;
    assert.equal(hasCurrentConfirmation(recovered.workspace, plan), true);
    for (const slot of ["first", "last"] as const) {
      const candidate = currentFrame(recovered.workspace, slot)!;
      assert.equal(candidate.slot, slot); assert.deepEqual(restored.store.readVerifiedBytes(candidate.imageId), pixels.get(candidate.imageId));
    }
    assert.deepEqual(fingerprints(backup.directory), backupBefore);
    assert.deepEqual(fingerprints(live), liveBefore);
    assert.deepEqual(expected.accounts, []); assert.deepEqual(expected.executions, []); assert.deepEqual(expected.films, []);
  } finally {
    if (source.database.connection.isOpen) source.database.close();
    if (restored?.database.connection.isOpen) restored.database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
