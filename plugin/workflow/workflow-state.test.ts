import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  createAgentName,
  deriveRunState,
  enqueueWorkflowNotification,
  isAgentKind,
  isLegacyAgentName,
  isRoleId,
  isRoleOrder,
  isWorkflowRun,
} from "./model.ts";
import type { WorkflowRunV2, WorkerRecord } from "./model.ts";
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

test("version-two model validates generic roles and rejects malformed metadata", () => {
  const run = createVersionTwoRun();

  assert.equal(isRoleId("security-audit"), true);
  assert.equal(isRoleId("Security Audit"), false);
  assert.equal(isRoleId("a".repeat(33)), false);
  assert.equal(isRoleOrder(["tests", "security-audit"]), true);
  assert.equal(isRoleOrder(["tests", "tests"]), false);
  assert.equal(isAgentKind("kilo"), true);
  assert.equal(isAgentKind("gemini"), false);
  assert.equal(isWorkflowRun(run), true);
  assert.equal(isWorkflowRun(JSON.parse(JSON.stringify(run))), true);

  const invalidOrigin = JSON.parse(JSON.stringify(run));
  invalidOrigin.origin.workspaceId = "";
  assert.equal(isWorkflowRun(invalidOrigin), false);

  const invalidMap = JSON.parse(JSON.stringify(run));
  invalidMap.workerOrder = ["tests", "tests"];
  assert.equal(isWorkflowRun(invalidMap), false);

  const swappedMap = JSON.parse(JSON.stringify(run));
  swappedMap.workers.tests.kind = "code-review";
  swappedMap.workers["code-review"].kind = "tests";
  assert.equal(isWorkflowRun(swappedMap), false);

  const invalidCheckpoint = JSON.parse(JSON.stringify(run));
  invalidCheckpoint.workers.tests.sourceCheckpoint.stagedDiffSha256 = "bad";
  assert.equal(isWorkflowRun(invalidCheckpoint), false);
});

test("stale workers block completion and arbitrary role IDs name agents safely", () => {
  const run = createVersionTwoRun();
  run.workers.tests.state = "stale";

  assert.equal(deriveRunState(run), "blocked");
  assert.equal(
    createAgentName("run-12345678", "security-audit", 2),
    "wf-12345678-security-audit-2",
  );
  assert.equal(
    isLegacyAgentName(
      "wf-12345678-review-2",
      "run-12345678",
      "code-review",
      2,
    ),
    true,
  );
});

function createVersionTwoRun(): WorkflowRunV2 {
  const capturedAt = new Date().toISOString();
  const sourceCheckpoint = {
    headId: "abc123",
    stagedDiffSha256: "a".repeat(64),
    unstagedTrackedDiffSha256: "b".repeat(64),
    capturedAt,
  };
  const workerOrder = ["tests", "code-review"];
  const workers = Object.fromEntries(
    workerOrder.map((roleId) => [roleId, createVersionTwoWorker(roleId, sourceCheckpoint)]),
  );

  return {
    version: 2,
    id: "run-12345678",
    task: "Validate the version-two model",
    createdAt: capturedAt,
    updatedAt: capturedAt,
    state: "reviews-complete",
    workerOrder,
    origin: {
      workspaceId: "workspace-123",
      paneId: "pane-123",
      coordinatorKind: "kilo",
      sessionId: "session-123",
    },
    workers,
    notifications: [],
    nextNotificationSequence: 1,
  };
}

function createVersionTwoWorker(
  roleId: string,
  sourceCheckpoint: {
    headId: string;
    stagedDiffSha256: string;
    unstagedTrackedDiffSha256: string;
    capturedAt: string;
  },
): WorkerRecord {
  return {
    kind: roleId,
    roleId,
    attempt: 1,
    definition: {
      roleId,
      label: roleId,
      agentKind: "kilo",
      skill: {
        id: "test-verification",
        hash: "c".repeat(64),
        body: "Review the implementation and verify it.",
      },
      capabilityProfile: "review-read-only",
      enforcement: {
        profile: "review-read-only",
        strength: "weak",
        allowsWrites: false,
      },
    },
    state: "done",
    sourceCheckpoint,
    result: {
      output: "VERDICT: PASS",
      capturedAt: sourceCheckpoint.capturedAt,
    },
  };
}
