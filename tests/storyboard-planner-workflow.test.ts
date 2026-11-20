import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { CommandResult } from "../src/shared/bridge";
import { createApplicationServices } from "../src/main/application/services";
import type { StoryboardPlannerPort, StoryboardPlannerResult } from "../src/main/application/storyboard-planner-workflow";
import { ApplicationDatabase } from "../src/main/infrastructure/database";
import { appendStoryboardDraft } from "../src/shared/storyboard-draft";
import { addShot, editScript } from "../src/shared/storyboard";

const model = { model: "deepseek-flash", modelVersion: "DeepSeek-V4.1-Flash-1017" } as const;
const payload = JSON.stringify({ formatVersion: 1, shots: [{ order: 1, title: "合成候选", visual: "一只方块", action: "", framing: "近景", motion: "固定", dialogue: "" }] });
const script = "合成已保存剧本。";
function fixture(overrides: Partial<Parameters<typeof createApplicationServices>[0]> = {}, empty = false, noShots = false) {
  const database = new ApplicationDatabase(":memory:");
  const { repository, router } = createApplicationServices({ database, logger: { command() {} }, sessions: { async open() {} },
    version: "synthetic", dataDirectory: "synthetic", ...overrides });
  const first = database.transaction(() => repository.createPlan({ title: "合成标题", style: "comic",
    startDate: "2026-11-19", dailyCount: 1, executionTime: "09:00" })).tasks[0]!;
  const saved = empty ? first : database.transaction(() => repository.saveWorkspace({
    id: first.id, expectedRevision: first.revision, workspace: noShots ? editScript(first.workspace, script) : addShot(editScript(first.workspace, script), randomUUID()),
  }));
  const run = (input: unknown = { taskId: saved.id, expectedRevision: saved.revision }, trusted = true) =>
    router.dispatch({ requestId: randomUUID(), command: "storyboard.generatePreview", input }, { trusted }) as Promise<CommandResult<StoryboardPlannerResult>>;
  const edit = (text: string) => database.transaction(() => {
    const current = repository.getTask(saved.id);
    return repository.saveWorkspace({ id: current.id, expectedRevision: current.revision, workspace: editScript(current.workspace, text) });
  });
  const adopt = (input: unknown, trusted = true) => router.dispatch({
    requestId: randomUUID(), command: "storyboard.adoptDraft", input,
  }, { trusted }) as Promise<CommandResult<import("../src/shared/bridge").CommandOutputs["storyboard.adoptDraft"]>>;
  const readiness = (trusted = true, input: unknown = {}) => router.dispatch({
    requestId: randomUUID(), command: "storyboard.readiness", input,
  }, { trusted });
  return { database, repository, run, adopt, readiness, saved, edit };
}
function port(generateJson: StoryboardPlannerPort["generateJson"], state: ReturnType<StoryboardPlannerPort["readiness"]>["state"] = "configured"): StoryboardPlannerPort {
  return { readiness: () => ({ state, ...model }), generateJson };
}
function errorCode<T>(result: CommandResult<T>) { return result.ok ? null : result.error.code; }
test("requires a trusted sender, valid saved task/revision, and native consent; renderer cannot pass data or consent", async () => {
  let conf = 0, sent = 0;
  const f = fixture({ storyboardPlanner: port(async () => { sent++; return payload; }), confirmStoryboard: async request => {
    conf++; assert.equal(request.scriptLength, script.length); assert.equal(Object.hasOwn(request, "script"), false); return false;
  } });
  try {
    assert.equal(errorCode(await f.run(undefined, false)), "UNAUTHORIZED");
    assert.equal(errorCode(await f.run({ taskId: randomUUID(), expectedRevision: 1 })), "NOT_FOUND");
    assert.equal(errorCode(await f.run({ taskId: f.saved.id, expectedRevision: 0 })), "CONFLICT");
    assert.equal(errorCode(await f.run({ taskId: f.saved.id, expectedRevision: 1, consent: true, script })), "INVALID_INPUT");
    const result = await f.run();
    assert.ok(result.ok); assert.deepEqual(result.data, { status: "cancelled" });
    assert.equal(conf, 1); assert.equal(sent, 0);
  } finally { f.database.close(); }
});
test("sends only saved script and technical instructions, previews ordered diff without saving or receipt", async () => {
  const f = fixture({ storyboardPlanner: port(async ({ system, user }) => {
    assert.match(system, /JSON/); assert.equal(user, script);
    assert.doesNotMatch(system + user, /合成标题/); return payload;
  }), confirmStoryboard: async () => true });
  try {
    const before = f.repository.getTask(f.saved.id);
    const result = await f.run();
    assert.ok(result.ok); assert.equal(result.data.status, "ready");
    if (result.data.status === "ready") {
      assert.equal(result.data.adoptionToken, null);
      assert.equal(result.data.revision, f.saved.revision); assert.equal(result.data.preview.rows[0]?.candidate?.title, "合成候选");
      assert.equal(result.data.preview.rows[0]?.current?.title, before.workspace.shots[0]?.title);
    }
    assert.deepEqual(f.repository.getTask(f.saved.id), before);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n, 0);
  } finally { f.database.close(); }
});
test("fails closed for disabled/unavailable and empty planning input", async () => {
  let calls = 0;
  for (const [state, empty, expected] of [["disabled", false, "PROVIDER_UNAVAILABLE"], ["missing_key", false, "PROVIDER_UNAVAILABLE"], ["configured", true, "INVALID_INPUT"]] as const) {
    const f = fixture({ storyboardPlanner: port(async () => { calls++; return payload; }, state), confirmStoryboard: async () => { calls++; return true; } }, empty);
    try { assert.equal(errorCode(await f.run()), expected); } finally { f.database.close(); }
  }
  assert.equal(calls, 0);
});
test("only one request is in flight, rejects revisions changed during consent without sending", async () => {
  let allow!: (answer: boolean) => void, calls = 0;
  const f = fixture({ storyboardPlanner: port(async () => { calls++; return payload; }), confirmStoryboard: () => new Promise(resolve => { allow = resolve; }) });
  try {
    const request = f.run(); assert.equal(errorCode(await f.run()), "CONFLICT");
    f.edit("合成修改"); allow(true);
    assert.equal(errorCode(await request), "CONFLICT"); assert.equal(calls, 0);
  } finally { f.database.close(); }
});
test("drops stale responses and redacts malformed replies and transport errors; caller remains retryable", async () => {
  let resolve!: (value: string) => void;
  let call = 0, logs = "";
  const f = fixture({ storyboardPlanner: port(async () => {
    call++;
    if (call === 1) return new Promise(resolveValue => { resolve = resolveValue; });
    if (call === 2) throw new Error("SYNTHETIC_PRIVATE_DETAIL");
    if (call === 3) return "SYNTHETIC_PRIVATE_DETAIL";
    return payload;
  }), confirmStoryboard: async () => true, logger: { command: entry => { logs += JSON.stringify(entry); } } });
  try {
    const pending = f.run(); await Promise.resolve();
    const current = f.edit("新的合成正文"); resolve(payload);
    assert.equal(errorCode(await pending), "CONFLICT");
    const input = { taskId: current.id, expectedRevision: current.revision };
    for (const i of [2, 3]) {
      const result = await f.run(input);
      assert.equal(call, i); assert.equal(errorCode(result), "PROVIDER_UNAVAILABLE");
      assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_DETAIL/);
    }
    const next = await f.run(input); assert.ok(next.ok && next.data.status === "ready");
    assert.doesNotMatch(logs, /SYNTHETIC_PRIVATE_DETAIL|新的合成正文/);
    assert.deepEqual(f.repository.getTask(current.id), current);
  } finally { f.database.close(); }
});

for (const stage of ["consent", "provider"] as const) {
  test(`rejects stale F07 candidates after saving only manual placement and asset links during ${stage}`, async () => {
    const candidate = JSON.stringify({ formatVersion: 1, shots: [
      { order: 1, title: "未命名镜头", visual: "", action: "", framing: "", motion: "", dialogue: "" },
      { order: 2, title: "合成追加镜头", visual: "方块", action: "", framing: "近景", motion: "固定", dialogue: "" },
    ] });
    let begin!: () => void, release!: () => void, approvals = 0, sends = 0;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const waitHere = () => new Promise<void>(resolve => { release = resolve; begin(); });
    const f = fixture({ storyboardPlanner: port(async input => {
      assert.equal(input.user, script);
      if (++sends === 1 && stage === "provider") await waitHere();
      return candidate;
    }), confirmStoryboard: async () => {
      if (++approvals === 1 && stage === "consent") await waitHere();
      return true;
    } });
    try {
      const pending = f.run();
      assert.equal(await Promise.race([started.then(() => "waiting"), pending.then(() => "finished")]), "waiting");
      const before = f.repository.getTask(f.saved.id);
      const shot = { ...before.workspace.shots[0]!, position: { x: 30, y: 70 } };
      const asset = { id: randomUUID(), type: "person" as const, name: "合成角色", description: "", referenceImageId: null,
        version: 1, position: { x: 5, y: 0 }, needsReview: false };
      const fresh = f.database.transaction(() => f.repository.saveWorkspace({ id: before.id, expectedRevision: before.revision,
        workspace: { ...before.workspace, shots: [shot], assets: [asset], assetLinks: [{ shotId: shot.id, assetId: asset.id }] },
      }));
      assert.equal(fresh.workspace.script, before.workspace.script);
      assert.equal(fresh.revision, before.revision + 1);
      release();
      const stale = await pending;
      assert.equal(errorCode(stale), "CONFLICT");
      assert.equal(Object.hasOwn(stale, "data"), false);
      const staleSends = stage === "consent" ? 0 : 1;
      assert.equal(sends, staleSends);
      assert.deepEqual(f.repository.getTask(fresh.id), fresh);

      const request = { taskId: fresh.id, expectedRevision: fresh.revision };
      const retried = await f.run(request);
      assert.ok(retried.ok && retried.data.status === "ready" && retried.data.adoptionToken);
      assert.equal(approvals, 2);
      assert.equal(sends, staleSends + 1);
      const adopted = await f.adopt({ ...request, token: retried.data.adoptionToken });
      assert.ok(adopted.ok);
      const draft = appendStoryboardDraft({ taskId: fresh.id, revision: fresh.revision, workspace: fresh.workspace,
        state: { dirty: false, saving: false, conflict: false, error: null, requestId: null } }, adopted.data);
      assert.ok(draft);
      assert.deepEqual(draft.shots[0], fresh.workspace.shots[0]);
      assert.deepEqual(draft.assetLinks, fresh.workspace.assetLinks);
      assert.deepEqual(draft.assets, fresh.workspace.assets);
      assert.equal(draft.shots[1]?.title, "合成追加镜头");
      assert.deepEqual(f.repository.getTask(fresh.id), fresh);
    } finally { f.database.close(); }
  });
}

test("first candidate adoption requires a matching one-use token and yields ordered editable shots without creating writes", async () => {
  const second = { order: 2, title: " 第二个 ", visual: "另一场景", action: "举手", framing: "远景", motion: "摇镜头", dialogue: "合成对白" };
  const content = JSON.parse(payload);
  content.shots.push(second);
  let calls = 0;
  const f = fixture({ storyboardPlanner: port(async () => { calls++; return JSON.stringify(content); }), confirmStoryboard: async () => true }, false, true);
  try {
    const current = f.repository.getTask(f.saved.id);
    const generated = await f.run();
    assert.ok(generated.ok && generated.data.status === "ready" && generated.data.adoptionToken);
    assert.deepEqual(f.repository.getTask(f.saved.id), current);
    const input = { taskId: current.id, expectedRevision: current.revision, token: generated.data.adoptionToken };
    assert.equal(errorCode(await f.adopt(input, false)), "UNAUTHORIZED");
    assert.equal(errorCode(await f.adopt({ ...input, shots: [] })), "INVALID_INPUT");
    assert.equal(errorCode(await f.adopt({ ...input, token: randomUUID() })), "CONFLICT");
    assert.equal(errorCode(await f.adopt({ ...input, taskId: randomUUID() })), "CONFLICT");
    const [accepted, replay] = await Promise.all([f.adopt(input), f.adopt(input)]);
    assert.ok(accepted.ok);
    assert.equal(errorCode(replay), "CONFLICT");
    assert.equal(calls, 1);
    assert.equal(accepted.data.taskId, current.id);
    assert.equal(accepted.data.revision, current.revision);
    assert.equal(accepted.data.shots.length, 2);
    assert.equal(new Set(accepted.data.shots.map(s => s.id)).size, 2);
    assert.deepEqual(accepted.data.shots.map(s => s.title), ["合成候选", "第二个"]);
    const { id, position, ...other } = accepted.data.shots[1]!;
    assert.ok(id); assert.equal(position.y, 310);
    assert.deepEqual(other, { title: "第二个", description: second.visual, action: second.action,
      shotSize: second.framing, cameraMovement: second.motion, audio: second.dialogue, needsReview: true });
    assert.deepEqual(f.repository.getTask(f.saved.id), current);
    assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n, 0);
    const state = { dirty: false, saving: false, conflict: false, error: null, requestId: null };
    const local = { taskId: current.id, revision: current.revision, workspace: current.workspace, state };
    for (const changed of [{ dirty: true }, { saving: true }, { conflict: true }, { error: "合成错误" }]) {
      assert.equal(appendStoryboardDraft({ ...local, state: { ...state, ...changed } }, accepted.data), null);
    }
    assert.equal(appendStoryboardDraft({ ...local, taskId: randomUUID() }, accepted.data), null);
    assert.equal(appendStoryboardDraft({ ...local, revision: local.revision + 1 }, accepted.data), null);
    const occupied = addShot(local.workspace, randomUUID());
    assert.equal(appendStoryboardDraft({ ...local, workspace: occupied }, accepted.data), null);
    assert.equal(occupied.shots.length, 1);
    const draft = appendStoryboardDraft(local, accepted.data);
    assert.ok(draft);
    assert.deepEqual({ ...draft, shots: [] }, current.workspace);
    const saved = f.database.transaction(() => f.repository.saveWorkspace({ id: current.id, expectedRevision: current.revision, workspace: draft }));
    assert.deepEqual(saved.workspace.shots, accepted.data.shots);
  } finally { f.database.close(); }
});

test("cannot adopt across a concurrent manual save or replace its identifiers/content", async () => {
  const f = fixture({ storyboardPlanner: port(async () => payload), confirmStoryboard: async () => true }, false, true);
  try {
    const generated = await f.run();
    assert.ok(generated.ok && generated.data.status === "ready" && generated.data.adoptionToken);
    const old = f.repository.getTask(f.saved.id);
    const manualId = randomUUID();
    const draft = addShot(old.workspace, manualId);
    draft.shots[0]!.description = "保留手动镜头";
    const current = f.database.transaction(() => f.repository.saveWorkspace({ id: old.id, expectedRevision: old.revision, workspace: draft }));
    const input = { taskId: old.id, expectedRevision: old.revision, token: generated.data.adoptionToken };
    assert.equal(errorCode(await f.adopt(input)), "CONFLICT");
    assert.deepEqual(f.repository.getTask(old.id), current);
    const newer = await f.run({ taskId: current.id, expectedRevision: current.revision });
    assert.ok(newer.ok && newer.data.status === "ready");
    assert.equal(newer.data.adoptionToken, null);
    assert.equal(newer.data.preview.rows[0]?.currentId, manualId);
    assert.equal(newer.data.preview.rows[0]?.current?.description, "保留手动镜头");
  } finally { f.database.close(); }
});

test("readiness exposes only fixed local states without contacting the provider or writing", async () => {
  let fetched = 0, dialogs = 0;
  const cases = [
    ["disabled", "disabled"],
    ["missing_key", "missing_key"],
    ["configured", "configuration_present"],
  ] as const;
  for (const [adapterState, expected] of cases) {
    const f = fixture({ storyboardPlanner: {
      readiness: () => ({ state: adapterState, ...model, accessKey: "SYNTHETIC_DO_NOT_EXPOSE", arbitrary: "SYNTHETIC_OTHER" }),
      generateJson: async () => { fetched++; return payload; },
    }, confirmStoryboard: async () => { dialogs++; return true; } });
    try {
      const result = await f.readiness();
      assert.ok(result.ok); assert.deepEqual(result.data, { state: expected });
      assert.equal(errorCode(await f.readiness(false)), "UNAUTHORIZED");
      assert.equal(errorCode(await f.readiness(true, { key: "synthetic-forgery" })), "INVALID_INPUT");
      assert.equal(f.database.connection.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()?.n, 0);
      assert.deepEqual(f.repository.getTask(f.saved.id), f.saved);
    } finally { f.database.close(); }
  }
  assert.equal(fetched, 0); assert.equal(dialogs, 0);
});

test("readiness defaults to disabled when not wired and sanitizes adapter exceptions", async () => {
  const f = fixture();
  try {
    const result = await f.readiness();
    assert.ok(result.ok); assert.deepEqual(result.data, { state: "disabled" });
  } finally { f.database.close(); }
  const broken = fixture({ storyboardPlanner: {
    readiness() { throw new Error("SYNTHETIC_PRIVATE_DETAIL"); },
    async generateJson() { throw new Error("must never generate during readiness"); },
  }, confirmStoryboard: async () => { throw new Error("must not prompt"); } });
  try {
    const result = await broken.readiness();
    assert.equal(errorCode(result), "PROVIDER_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_DETAIL/);
  } finally { broken.database.close(); }
});

test("exact saved prefix permits explicit append while preserving manual shot, position, IDs and asset links", async () => {
  const existing = { order: 1, title: "保留镜头", visual: "窗前", action: "静站", framing: "中景", motion: "固定", dialogue: "窗外声" };
  const suffix = { order: 2, title: "追加镜头", visual: "切换场景", action: "回头", framing: "近景", motion: "缓推", dialogue: "" };
  const f = fixture({ storyboardPlanner: port(async () => JSON.stringify({ formatVersion: 1, shots: [existing, suffix] })), confirmStoryboard: async () => true });
  try {
    const current = f.repository.getTask(f.saved.id);
    const manual = { ...current.workspace.shots[0]!, title: existing.title, description: existing.visual, action: existing.action,
      shotSize: existing.framing, cameraMovement: existing.motion, audio: existing.dialogue, position: { x: 5, y: 7 }, needsReview: false };
    const asset = { id: randomUUID(), type: "person" as const, name: "保留角色", description: "", referenceImageId: null,
      version: 1, position: { x: 100, y: 0 }, needsReview: false };
    const saved = f.database.transaction(() => f.repository.saveWorkspace({ id: current.id, expectedRevision: current.revision,
      workspace: { ...current.workspace, shots: [manual], assets: [asset], assetLinks: [{ shotId: manual.id, assetId: asset.id }] },
    }));
    const request = { taskId: saved.id, expectedRevision: saved.revision };
    const generated = await f.run(request);
    assert.ok(generated.ok && generated.data.status === "ready" && generated.data.adoptionToken);
    assert.deepEqual(generated.data.preview.rows[0]?.changedFields, []);
    assert.deepEqual(f.repository.getTask(saved.id), saved);
    const adopted = await f.adopt({ ...request, token: generated.data.adoptionToken });
    assert.ok(adopted.ok);
    assert.equal(adopted.data.shots.length, 1);
    assert.equal(adopted.data.shots[0]?.title, suffix.title);
    assert.notEqual(adopted.data.shots[0]?.id, manual.id);
    assert.equal(adopted.data.shots[0]?.needsReview, true);
    assert.equal(adopted.data.shots[0]?.position.y, 310);
    const local = { taskId: saved.id, revision: saved.revision, workspace: saved.workspace,
      state: { dirty: false, saving: false, conflict: false, error: null, requestId: null } };
    const draft = appendStoryboardDraft(local, adopted.data);
    assert.ok(draft);
    assert.deepEqual(draft.shots[0], saved.workspace.shots[0]);
    assert.deepEqual(draft.assetLinks, saved.workspace.assetLinks);
    assert.deepEqual(draft.assets, saved.workspace.assets);
    for (const forged of [{ ...saved.workspace.shots[0]!, audio: "迟到更改" }, { ...saved.workspace.shots[0]!, id: randomUUID() }]) {
      assert.equal(appendStoryboardDraft({ ...local, workspace: { ...local.workspace, shots: [forged] } }, adopted.data), null);
    }
    assert.equal(appendStoryboardDraft(local, { ...adopted.data, shots: [{ ...adopted.data.shots[0]!, id: manual.id }] }), null);
    const written = f.database.transaction(() => f.repository.saveWorkspace({ id: saved.id, expectedRevision: saved.revision, workspace: draft }));
    assert.deepEqual(written.workspace.shots[0], saved.workspace.shots[0]);
    assert.deepEqual(written.workspace.assetLinks, saved.workspace.assetLinks);
    assert.equal(written.workspace.shots[1]?.title, suffix.title);
  } finally { f.database.close(); }
});

test("every changed prefix field, no suffix, and shorter comparisons remain read-only", async () => {
  const prefix = { order: 1, title: "未命名镜头", visual: "", action: "", framing: "", motion: "", dialogue: "" };
  const suffix = { ...prefix, order: 2, title: "追加镜头" };
  let reply = "";
  const f = fixture({ storyboardPlanner: port(async () => reply), confirmStoryboard: async () => true });
  try {
    for (const field of ["title", "visual", "action", "framing", "motion", "dialogue"] as const) {
      reply = JSON.stringify({ formatVersion: 1, shots: [{ ...prefix, [field]: prefix[field] + " " }, suffix] });
      const result = await f.run();
      assert.ok(result.ok && result.data.status === "ready");
      assert.equal(result.data.adoptionToken, null);
      assert.equal(result.data.preview.extraCandidatePositions, 1);
    }
    reply = JSON.stringify({ formatVersion: 1, shots: [prefix] });
    const result = await f.run();
    assert.ok(result.ok && result.data.status === "ready");
    assert.equal(result.data.adoptionToken, null);
    assert.deepEqual(result.data.preview.rows[0]?.changedFields, []);
    assert.deepEqual(f.repository.getTask(f.saved.id), f.saved);
    const longer = f.database.transaction(() => f.repository.saveWorkspace({ id: f.saved.id, expectedRevision: f.saved.revision,
      workspace: addShot(f.saved.workspace, randomUUID()),
    }));
    const short = await f.run({ taskId: longer.id, expectedRevision: longer.revision });
    assert.ok(short.ok && short.data.status === "ready");
    assert.equal(short.data.adoptionToken, null);
    assert.equal(short.data.preview.extraCurrentPositions, 1);
    assert.deepEqual(f.repository.getTask(longer.id), longer);
  } finally { f.database.close(); }
});
