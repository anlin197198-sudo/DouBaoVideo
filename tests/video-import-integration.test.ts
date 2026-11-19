import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VideoImportCoordinator, type VideoImportArtifact, type VideoImportPorts, type VideoImportStage } from "../src/main/application/video-import-coordinator";
import { initializeImportJournal, VideoImportJournal, type ImportJournalRequest } from "../src/main/infrastructure/video-import-journal";
import { writeVerifiedVideoBytes } from "../src/main/infrastructure/video-byte-writer";

// Integration of real local primitives, not a production adapter or codec test.
// Fixture stage evidence survives this DB close/reopen in private test memory. The
// journal does NOT contain decoder/stage evidence sufficient for process recovery.
for (const fault of ["none", "commit-response-lost", "publish-response-lost"] as const) {
 test(`synthetic import integration: ${fault}, reopen never republishes`, async () => {
  const root = await mkdtemp(join(tmpdir(), "import-integration-"));
  const directory = join(root, "outputs"), database = join(root, "standalone.sqlite");
  await mkdir(directory);
  let db = new DatabaseSync(database);
  const bytes = Buffer.from("Synthetic fixture bytes, deliberately not a playable video.");
  const fingerprint = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  const request: ImportJournalRequest = { intent: { requestId: randomUUID(), taskId: randomUUID(), intentToken: randomUUID(), expectedFingerprint: fingerprint }, expectedTaskRevision: 4, expectedVersion: 1 };
  const events: string[] = [];
  let stages = 0, writes = 0, commits = 0;
  let fixtureArtifact: VideoImportArtifact | null = null;
  try {
   initializeImportJournal(db);
   let journal = new VideoImportJournal(db);
   journal.provisionTask({ taskId: request.intent.taskId, revision: 4, nextVersion: 1 });
   const ports: VideoImportPorts = {
    async reserve(intent) {
     events.push("reserve");
     assert.deepEqual(intent, request.intent);
     const reservation = journal.reserve({ ...request, intent });
     return { status: reservation.created ? "reserved" : "existing", binding: { intent: reservation.record.request.intent, reservationId: reservation.record.key.reservationId, fenceToken: reservation.record.key.fenceToken } };
    },
    async stage(binding) {
     events.push("stage"); stages++;
     // Explicit trusted synthetic decoder fixture ONLY; no media validity claim.
     const stage: VideoImportStage = { binding, stageId: randomUUID(), fingerprint, decoder: { status: "verified", fingerprint, format: "mp4", width: 16, height: 9, durationSeconds: 1 } };
     return stage;
    },
    async recheck(stage) {
     events.push("recheck");
     const row = journal.read(stage.binding.intent.requestId)!;
     return row.state === "reserved" && row.key.fenceToken === stage.binding.fenceToken && JSON.stringify(row.request) === JSON.stringify(request);
    },
    async publish(stage) {
     const key = { requestId: stage.binding.intent.requestId, reservationId: stage.binding.reservationId, fenceToken: stage.binding.fenceToken };
     assert.equal(journal.markPublicationPossible(key).transitioned, true);
     events.push("possible");
     assert.equal(journal.read(key.requestId)!.state, "publication-possible");
     writes++; events.push("writer");
     const result = await writeVerifiedVideoBytes({ directory,
      // The writer's legacy executionId naming field is an opaque synthetic
      // reservation UUID here; no real execution is borrowed/created.
      identity: { taskId: request.intent.taskId, executionId: key.reservationId, version: 1, title: "synthetic import" },
      expectedBytes: bytes.length, expectedSha256: fingerprint.sha256,
      chunks: (async function* () { yield bytes.subarray(0, 13); yield bytes.subarray(13); })() });
     assert.equal(result.status, "published"); assert.equal(result.mediaValidated, false);
     assert.equal(result.databaseCompleted, false); assert.equal(result.cleanup, "removed");
     fixtureArtifact = structuredClone({ stage, artifactId: randomUUID(), cleanup: "complete" });
     Object.freeze(fixtureArtifact); // No mutation of captured evidence in this fixture.
     if (fault === "publish-response-lost") throw new Error("synthetic lost publish response");
     return { status: "published", artifact: fixtureArtifact };
    },
    async commit(artifact) {
     events.push("commit"); commits++;
     assert.deepEqual(artifact, fixtureArtifact);
     journal.commit({ requestId: request.intent.requestId, reservationId: artifact.stage.binding.reservationId, fenceToken: artifact.stage.binding.fenceToken,
      artifactId: artifact.artifactId, version: request.expectedVersion, fingerprint: artifact.stage.fingerprint });
     if (fault === "commit-response-lost") throw new Error("synthetic lost commit response");
     return { status: "committed", artifact };
    },
    async reconcile(intent) {
     const row = journal.read(intent.requestId);
     assert.deepEqual(intent, request.intent);
     if (!row?.receipt || row.state !== "confirmed" || !fixtureArtifact) throw new Error("no complete fixture receipt");
     assert.deepEqual(row.request, request);
     assert.deepEqual(row.receipt, { ...row.key, artifactId: fixtureArtifact.artifactId, version: 1, fingerprint });
     assert.equal(row.key.reservationId, fixtureArtifact.stage.binding.reservationId);
     assert.equal(row.key.fenceToken, fixtureArtifact.stage.binding.fenceToken);
     assert.deepEqual(fixtureArtifact.stage.binding.intent, intent);
     // This combines a real journal read with retained test-only evidence, NOT
     // reconstruction of decoder evidence from journal data after process death.
     return { status: "committed", artifact: fixtureArtifact };
    }
   };
   const coordinator = new VideoImportCoordinator(ports);
   assert.equal((await coordinator.run(null)).status, "cancelled"); assert.deepEqual(events, []);
   const outcome = await coordinator.run(request.intent);
   assert.equal(outcome.status, fault === "none" ? "recorded" : "reconcile-required");
   assert.equal(outcome.automaticRetry, false); assert.equal(outcome.taskCompleted, false);
   assert.deepEqual(events, ["reserve", "stage", "recheck", "possible", "writer", ...(fault === "publish-response-lost" ? [] : ["commit"])]);
   const names = await readdir(directory); assert.equal(names.length, 1); assert.ok(names[0]!.endsWith(".mp4"));
   const original = await readFile(join(directory, names[0]!)); assert.deepEqual(original, bytes);
   const before = journal.read(request.intent.requestId);
   db.close(); db = new DatabaseSync(database); journal = new VideoImportJournal(db);
   assert.deepEqual(journal.read(request.intent.requestId), before);
   const reopened = new VideoImportCoordinator(ports);
   assert.equal((await reopened.run(request.intent)).status, "reconcile-required");
   const reconciled = await reopened.reconcile(request.intent);
   assert.equal(reconciled.status, fault === "publish-response-lost" ? "reconcile-required" : "recorded");
   assert.equal(reconciled.automaticRetry, false);
   assert.equal(stages, 1); assert.equal(writes, 1); assert.equal(commits, fault === "publish-response-lost" ? 0 : 1);
   assert.deepEqual(await readdir(directory), names); assert.deepEqual(await readFile(join(directory, names[0]!)), original);
   assert.equal(db.prepare("SELECT COUNT(*) AS n FROM import_journal").get()!.n, 1);
   assert.equal(db.prepare("SELECT revision FROM journal_tasks").get()!.revision, 4);
   assert.equal(db.prepare("SELECT next_version FROM journal_tasks").get()!.next_version, fault === "publish-response-lost" ? 1 : 2);
   assert.equal(journal.read(request.intent.requestId)!.state, fault === "publish-response-lost" ? "publication-possible" : "confirmed");
   const stored = JSON.stringify(db.prepare("SELECT * FROM import_journal").all());
   assert.ok(!stored.includes(root)); assert.ok(!stored.includes(names[0]!));
   assert.doesNotMatch(stored, /decoder|file_path|executionId/);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
 });
}
