import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { enqueueWorkflowNotification } from "./model.ts";
import { createRun, loadRun, saveNewRun } from "./run-store.ts";
import { isWorkerInspectionStale } from "./supervisor.ts";

test("workflow notifications are durable and deduplicated by key", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-state-"));

  try {
    const run = createRun({
      task: "Verify asynchronous workflow state",
      originSessionId: "session-123",
      workspaceId: "workspace-123",
    });
    const first = enqueueWorkflowNotification(run, {
      key: "tests:1:blocked:7",
      kind: "worker-blocked",
      message: "Tests are blocked.",
    });
    const duplicate = enqueueWorkflowNotification(run, {
      key: "tests:1:blocked:7",
      kind: "worker-blocked",
      message: "This duplicate must not replace the original.",
    });
    const second = enqueueWorkflowNotification(run, {
      key: "reviews-complete:1:1:1",
      kind: "reviews-complete",
      message: "Reviews are complete.",
    });

    run.workers.tests.result = {
      output: "VERDICT: PASS",
      capturedAt: new Date().toISOString(),
    };
    await saveNewRun(projectRoot, run);

    const loaded = await loadRun(projectRoot, run.id);
    assert.equal(first, duplicate);
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(loaded.originSessionId, "session-123");
    assert.equal(loaded.notifications?.length, 2);
    assert.equal(loaded.workers.tests.result?.output, "VERDICT: PASS");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("legacy version-one runs load without supervision fields", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-legacy-"));

  try {
    const run = createRun({
      task: "Load a legacy workflow run",
      originSessionId: "session-legacy",
      workspaceId: "workspace-legacy",
    });

    delete run.originSessionId;
    delete run.nextNotificationSequence;
    delete run.notifications;
    await saveNewRun(projectRoot, run);

    const loaded = await loadRun(projectRoot, run.id);
    assert.equal(loaded.version, 1);
    assert.equal(loaded.originSessionId, undefined);
    assert.equal(loaded.notifications, undefined);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("worker inspections older than coordinator prompts are rejected", () => {
  const run = createRun({
    task: "Reject stale worker observations",
    originSessionId: "session-stale",
    workspaceId: "workspace-stale",
  });
  const worker = run.workers.tests;

  worker.attempt = 1;
  worker.state = "working";
  worker.stateChangeSeq = 12;
  worker.pendingPromptStartSeq = 14;

  assert.equal(
    isWorkerInspectionStale(worker, { stateChangeSeq: 13 }),
    true,
  );
  assert.equal(
    isWorkerInspectionStale(worker, { stateChangeSeq: undefined }),
    true,
  );
  assert.equal(
    isWorkerInspectionStale(worker, { stateChangeSeq: 14 }),
    false,
  );

  worker.pendingPromptStartSeq = undefined;
  assert.equal(
    isWorkerInspectionStale(worker, { stateChangeSeq: 11 }),
    true,
  );
  assert.equal(
    isWorkerInspectionStale(worker, { stateChangeSeq: 12 }),
    false,
  );
});
