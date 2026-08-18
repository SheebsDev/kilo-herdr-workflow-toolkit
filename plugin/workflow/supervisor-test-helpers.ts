import { randomUUID } from "node:crypto";

import type { SourceCheckpoint, WorkflowRunV2 } from "./model.ts";

export function createRun(): WorkflowRunV2 {
  const capturedAt = new Date().toISOString();
  const sourceCheckpoint = createTestCheckpoint({ capturedAt });
  const runId = `run-${randomUUID()}`;

  return {
    version: 2,
    id: runId,
    task: "Test stale completion supervision",
    originSessionId: "session-test",
    herdrWorkspaceId: "workspace-test",
    createdAt: capturedAt,
    updatedAt: capturedAt,
    state: "reviewing",
    workerOrder: ["tests", "code-review", "readability"],
    origin: {
      workspaceId: "workspace-test",
      paneId: "pane-origin",
      coordinatorKind: "kilo",
      sessionId: "session-test",
    },
    workers: {
      tests: createWorker("tests", sourceCheckpoint),
      "code-review": createWorker("code-review", sourceCheckpoint),
      readability: createWorker("readability", sourceCheckpoint),
    },
    notifications: [],
    nextNotificationSequence: 1,
  };
}

export function createTestCheckpoint(
  overrides: Partial<SourceCheckpoint> = {},
): SourceCheckpoint {
  return {
    headId: "head-test",
    stagedDiffSha256: "a".repeat(64),
    unstagedTrackedDiffSha256: "b".repeat(64),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createWorker(
  kind: "tests" | "code-review" | "readability",
  sourceCheckpoint: SourceCheckpoint,
) {
  return {
    kind,
    roleId: kind,
    attempt: 0,
    state: "launching" as const,
    sourceCheckpoint,
  };
}
