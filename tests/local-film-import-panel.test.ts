import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { LocalImportCommandResult } from "../src/main/application/local-import-command";
import type { WorkspaceSnapshot, VideoTask } from "../src/shared/models";
import { createLocalFilmImportState, localFilmImportNotice,
  type FilmImportState, type LocalFilmImportCapability } from "../src/renderer/src/pages/local-film-import-state";

const base: LocalImportCommandResult = { status: "failed", archiveStatus: "none", recordStatus: "none",
  cleanupConfirmed: true, automaticRetry: false, mediaPlaybackAuthorized: false };
const binding = { taskId: "synthetic-a", revision: 4 };
function pending<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const latest = (states: FilmImportState[]) => states.at(-1);

test("local import projects durable outcomes before stale/cancel states and emits no private details", () => {
  for (const recordStatus of ["recorded", "prior-recorded"] as const) {
    const notice = localFilmImportNotice({ ...base, status: "stale", recordStatus, cleanupConfirmed: false });
    assert.match(notice.message, /成片记录.*清理尚未确认.*不代表可以播放/);
    assert.equal(notice.refresh, true);
  }
  for (const archiveStatus of ["published", "published-cleanup-failed"] as const) {
    const raw = { ...base, status: "cancelled" as const, archiveStatus, path: "/private/path/media.mp4" };
    const notice = localFilmImportNotice(raw);
    assert.match(notice.message, /文件已保存.*登记尚未确认.*不要重复提交/);
    assert.doesNotMatch(notice.message, /private|未保存|已取消/);
    assert.equal(notice.refresh, false);
  }
  for (const result of [{ ...base, archiveStatus: "publication-uncertain" as const },
    { ...base, recordStatus: "recording-unconfirmed" as const }, { ...base, status: "cleanup-unconfirmed" as const }]) {
    const notice = localFilmImportNotice(result);
    assert.match(notice.message, /无法确认.*不要重复提交/);
    assert.equal(notice.refresh, false);
  }
});

test("one click captures known scope and blocks double-submit; refresh only on confirmed records", async () => {
  const states: FilmImportState[] = [], submitted = pending<LocalImportCommandResult>(), refreshing = pending<void>();
  const controller = createLocalFilmImportState(state => states.push(state));
  let calls = 0, refreshes = 0, refreshed!: () => void;
  const entered = new Promise<void>(resolve => { refreshed = resolve; });
  const capability: LocalFilmImportCapability = {
    async run(request) { calls++; assert.deepEqual(request, binding); assert.ok(Object.isFrozen(request)); return submitted.promise; },
    async refreshRecords(signal) { assert.equal(signal.aborted, false); refreshes++; refreshed(); return refreshing.promise; },
  };
  controller.setScope(null, capability);
  await controller.submit();
  assert.equal(calls, 0);
  controller.setScope(binding, capability);
  const one = controller.submit();
  await controller.submit();
  assert.equal(calls, 1);
  assert.equal(latest(states)?.busy, true);
  submitted.resolve({ ...base, status: "stale", recordStatus: "recorded", archiveStatus: "published" });
  await entered;
  await controller.submit();
  assert.equal(calls, 1);
  refreshing.resolve();
  await one;
  assert.equal(refreshes, 1);
  assert.equal(latest(states)?.busy, false);
  assert.match(latest(states)?.message ?? "", /已登记.*不代表可以播放/);
  controller.setScope(binding, { ...capability, async run() { return { ...base, archiveStatus: "published" }; } });
  await controller.submit();
  assert.equal(refreshes, 1);
  assert.match(latest(states)?.message ?? "", /文件已保存.*尚未确认/);
});

test("task/revision/page changes abandon late status without saying persistence did not happen", async () => {
  for (const mode of ["task", "revision", "leave"] as const) {
    const states: FilmImportState[] = [], reply = pending<LocalImportCommandResult>();
    const controller = createLocalFilmImportState(state => states.push(state));
    let signal: AbortSignal | undefined, calls = 0;
    const capability: LocalFilmImportCapability = { async run(_, abort) { calls++; signal = abort; return reply.promise; },
      async refreshRecords() { assert.fail("Late response should not refresh old scope"); } };
    controller.setScope(binding, capability);
    const initial = controller.submit();
    if (mode === "leave") controller.setScope(null, undefined);
    if (mode === "task") controller.setScope({ ...binding, taskId: "synthetic-b" }, capability);
    if (mode === "revision") controller.setScope({ ...binding, revision: 5 }, capability);
    assert.equal(signal?.aborted, true);
    await controller.submit();
    assert.equal(calls, 1);
    reply.resolve({ ...base, archiveStatus: "published", recordStatus: "recorded", status: "stale" });
    await initial;
    assert.ok(states.every(state => !state.message));
  }
});

test("Films page is default-off and exposes only explicit local-import UI when capability is injected", async () => {
  const path = "../src/renderer/src/pages/FilmsPage.tsx";
  const FilmsPage = (await import(path)).FilmsPage as ComponentType<{
    snapshot: Pick<WorkspaceSnapshot, "films" | "tasks">; localImport?: LocalFilmImportCapability;
  }>;
  const snapshot = { films: [], tasks: [{ id: binding.taskId, revision: binding.revision, title: "合成任务 A",
    businessDate: "2026-11-19" } as VideoTask] };
  const capability: LocalFilmImportCapability = { async run() { assert.fail("Rendering must not call command"); },
    async refreshRecords() { assert.fail("Rendering must not refresh"); } };
  const standard = renderToStaticMarkup(createElement(FilmsPage, { snapshot }));
  assert.doesNotMatch(standard, /导入本地 MP4|<select|<button/);
  const gated = renderToStaticMarkup(createElement(FilmsPage, { snapshot, localImport: capability }));
  assert.match(gated, /导入本地 MP4.*不上传.*写入前.*另行确认/);
  assert.match(gated, /合成任务 A · 2026-11-19/);
  assert.match(gated, /<button[^>]+disabled="">选择 MP4 文件/);
  assert.doesNotMatch(gated, /<video|<input|\bfile:\/\/|<a\s/);
});

test("scope changes during confirmed-record refresh abort the refresh and hide its stale error", async () => {
  const states: FilmImportState[] = [], refresh = pending<void>(), started = pending<AbortSignal>();
  const controller = createLocalFilmImportState(state => states.push(state));
  const capability: LocalFilmImportCapability = {
    async run() { return { ...base, archiveStatus: "published", recordStatus: "recorded" }; },
    async refreshRecords(signal) { started.resolve(signal); await refresh.promise; throw new Error("/private/path"); },
  };
  controller.setScope(binding, capability);
  const operation = controller.submit();
  const refreshSignal = await started.promise;
  controller.setScope({ ...binding, revision: binding.revision + 1 }, capability);
  assert.equal(refreshSignal.aborted, true);
  refresh.resolve();
  await operation;
  assert.deepEqual(latest(states), { busy: false, message: "" });
});
