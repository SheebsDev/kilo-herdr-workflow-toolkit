import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { createRun, loadRun, saveNewRun, saveRun } from "./run-store.ts";
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
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.workerOrder, ["tests", "code-review", "readability"]);
    assert.equal(loaded.workers.tests.definition?.agentKind, "kilo");
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

test("version-one runs are rejected without migration or deletion", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-legacy-"));

  try {
    const run = createRun({
      task: "Load a legacy workflow run",
      originSessionId: "session-legacy",
      workspaceId: "workspace-legacy",
    });
    const legacyRun = { ...run, version: 1 };
    const runDirectory = path.join(projectRoot, ".workflow", "runs", run.id);
    const runPath = path.join(runDirectory, "run.json");
    const contents = `${JSON.stringify(legacyRun, null, 2)}\n`;

    await mkdir(runDirectory, { recursive: true });
    await writeFile(runPath, contents, "utf8");

    await assert.rejects(
      loadRun(projectRoot, run.id),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("unsupported version 1") &&
        error.message.includes(`.workflow/runs/${run.id}`),
    );
    assert.equal(await readFile(runPath, "utf8"), contents);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("invalid version-two worker maps are rejected before persistence", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-invalid-"));

  try {
    const run = createRun({
      task: "Reject an invalid worker map",
      originSessionId: "session-invalid",
      workspaceId: "workspace-invalid",
    });
    delete run.workers.tests;

    await assert.rejects(
      saveNewRun(projectRoot, run),
      /is invalid\.$/,
    );
    await assert.rejects(
      readFile(path.join(projectRoot, ".workflow", "runs", "latest")),
      { code: "ENOENT" },
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("version-two runs can be updated atomically and loaded through latest", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-atomic-"));

  try {
    const run = createRun({
      task: "Persist an atomic update",
      originSessionId: "session-atomic",
      workspaceId: "workspace-atomic",
    });
    await saveNewRun(projectRoot, run);

    run.workers.tests.state = "done";
    await saveRun(projectRoot, run);

    const loaded = await loadRun(projectRoot);
    assert.equal(loaded.version, 2);
    assert.equal(loaded.workers.tests.state, "done");
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("version-two storage accepts arbitrary valid role IDs", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-roles-"));

  try {
    const run = createVersionTwoRun();
    run.workerOrder = ["security-audit"];
    run.workers = {
      "security-audit": {
        ...run.workers.tests,
        kind: "security-audit",
        roleId: "security-audit",
        definition: {
          ...run.workers.tests.definition!,
          roleId: "security-audit",
          label: "Security Audit",
        },
      },
    };

    await saveNewRun(projectRoot, run);
    const loaded = await loadRun(projectRoot, run.id);
    assert.deepEqual(loaded.workerOrder, ["security-audit"]);
    assert.equal(loaded.workers["security-audit"].kind, "security-audit");
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

  const invalidSkillSnapshot = JSON.parse(JSON.stringify(run));
  invalidSkillSnapshot.workers.tests.definition.skill.body = "tampered";
  assert.equal(isWorkflowRun(invalidSkillSnapshot), false);
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
         hash: createHash("sha256")
           .update("Review the implementation and verify it.", "utf8")
           .digest("hex"),
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
