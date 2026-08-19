import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { refreshRunState } from "../../core/model.ts";
import {
  createRun as createTestRun,
  createTestCheckpoint,
} from "./supervisor-test-helpers.ts";

const runs = new Map<string, ReturnType<typeof createTestRun>>();
const closedWorkers: string[] = [];
const launches: Array<{
  agentKind: string;
  attempt: number;
  checkpoint: ReturnType<typeof createTestCheckpoint>;
}> = [];
let currentCheckpoint = createTestCheckpoint({
  unstagedTrackedDiffSha256: "c".repeat(64),
});
let launchError: Error | undefined;
let saveCount = 0;
const supervisedRuns: string[] = [];

mock.module("../../core/run-store.ts", {
  exports: {
    createRun: () => createTestRun(),
    normalizeTaskCardPath: async () => undefined,
    saveNewRun: async () => undefined,
    saveRun: async () => {
      saveCount += 1;
    },
    withLockedRun: async (
      _projectRoot: string,
      runId: string | undefined,
      _signal: AbortSignal | undefined,
      operation: (run: ReturnType<typeof createTestRun>) => Promise<unknown>,
    ) => {
      const run = runs.get(runId ?? "");
      if (!run) {
        throw new Error(`Missing test run ${runId}.`);
      }
      return operation(run);
    },
    withRunLock: async (
      _projectRoot: string,
      _runId: string,
      _signal: AbortSignal | undefined,
      operation: () => Promise<unknown>,
    ) => operation(),
  },
});

mock.module("../../core/source-checkpoint.ts", {
  exports: {
    captureSourceCheckpoint: async () => currentCheckpoint,
  },
});

mock.module("../../core/worker-service.ts", {
  exports: {
    closeWorker: async (
      _run: ReturnType<typeof createTestRun>,
      worker: { kind: string },
    ) => {
      closedWorkers.push(worker.kind);
    },
    inspectWorker: async () => ({ state: "working" }),
    promptWorker: async () => 1,
    requireHerdrWorkspace: () => "workspace-test",
    spawnWorker: async (options: {
      run: ReturnType<typeof createTestRun>;
      kind: "tests" | "code-review" | "readability";
      attempt: number;
      sourceCheckpoint: ReturnType<typeof createTestCheckpoint>;
    }) => {
      if (launchError) {
        throw launchError;
      }

      const definition = options.run.workers[options.kind].definition!;
      launches.push({
        agentKind: definition.agentKind,
        attempt: options.attempt,
        checkpoint: options.sourceCheckpoint,
      });
      return {
        kind: options.kind,
        roleId: options.kind,
        attempt: options.attempt,
        definition,
        attemptHistory: options.run.workers[options.kind].attemptHistory,
        sourceCheckpoint: options.sourceCheckpoint,
        agentName: `replacement-${options.kind}`,
        tabId: `replacement-tab-${options.kind}`,
        paneId: `replacement-pane-${options.kind}`,
        state: "working" as const,
      };
    },
    workerErrorRecord: (
      kind: "tests" | "code-review" | "readability",
      attempt: number,
      error: unknown,
      options: {
        definition: ReturnType<typeof createTestRun>["workers"]["tests"]["definition"];
        sourceCheckpoint: ReturnType<typeof createTestCheckpoint>;
        attemptHistory?: ReturnType<typeof createTestRun>["workers"]["tests"]["attemptHistory"];
      },
    ) => ({
      kind,
      roleId: kind,
      attempt,
      definition: options.definition,
      attemptHistory: options.attemptHistory,
      sourceCheckpoint: options.sourceCheckpoint,
      state: "error" as const,
      lastError: error instanceof Error ? error.message : String(error),
    }),
  },
});

mock.module("./supervisor.ts", {
  exports: {
    WorkflowSupervisor: class {
      supervise(runId: string): void {
        supervisedRuns.push(runId);
      }

      cancelWorker(): void {}

      async resumeForSession(): Promise<void> {}

      async dispose(): Promise<void> {}
    },
  },
});

const { default: workflowPlugin } = await import("../workflow.ts");

test("workflow_retry preserves selected agent, snapshot evidence, and recovers completion", { concurrency: false }, async () => {
  resetTestState();
  const run = createRetryRun();
  run.workers.tests.definition = {
    ...run.workers.tests.definition!,
    agentKind: "codex",
  };
  runs.set(run.id, run);

  const tools = await createCoordinatorTools();
  const result = await tools.tool!.workflow_retry.execute(
    { runId: run.id, worker: "tests" },
    toolContext(),
  );

  assert.match(String(result), /reviews-complete|reviewing/);
  assert.deepEqual(launches, [
    {
      agentKind: "codex",
      attempt: 2,
      checkpoint: currentCheckpoint,
    },
  ]);
  assert.deepEqual(closedWorkers, ["tests"]);
  assert.equal(run.workers.tests.attempt, 2);
  assert.equal(run.workers.tests.definition?.agentKind, "codex");
  assert.equal(run.workers.tests.attemptHistory?.[0].result?.output, "stale report");
  assert.equal(run.workers.tests.attemptHistory?.[0].staleDetails?.reason, "stale source");
  assert.equal(run.workers.tests.state, "working");

  run.workers.tests.state = "done";
  run.workers.tests.result = {
    output: "replacement report",
    capturedAt: currentCheckpoint.capturedAt,
  };
  refreshRunState(run);
  assert.equal(run.state, "reviews-complete");
  assert.deepEqual(supervisedRuns, [run.id]);
});

test("workflow_retry persists actionable replacement-launch failure after cleanup", { concurrency: false }, async () => {
  resetTestState();
  launchError = new Error("replacement launch failed");
  const run = createRetryRun();
  runs.set(run.id, run);

  const tools = await createCoordinatorTools();
  await tools.tool!.workflow_retry.execute(
    { runId: run.id, worker: "tests" },
    toolContext(),
  );

  assert.deepEqual(closedWorkers, ["tests"]);
  assert.equal(run.workers.tests.state, "error");
  assert.match(run.workers.tests.lastError!, /replacement launch failed/);
  assert.equal(run.workers.tests.tabId, undefined);
  assert.equal(run.workers.tests.attemptHistory?.[0].result?.output, "stale report");
  assert.equal(saveCount, 1);
  assert.deepEqual(supervisedRuns, [run.id]);
});

function createRetryRun() {
  const run = createTestRun();
  const worker = run.workers.tests;
  worker.attempt = 1;
  worker.state = "stale";
  worker.agentName = "wf-test-tests-1";
  worker.tabId = "old-tab-tests";
  worker.paneId = "old-pane-tests";
  worker.sourceCheckpoint = createTestCheckpoint();
  worker.result = {
    output: "stale report",
    capturedAt: worker.sourceCheckpoint.capturedAt,
  };
  worker.staleDetails = {
    baseline: worker.sourceCheckpoint,
    current: currentCheckpoint,
    reason: "stale source",
  };
  run.workers["code-review"].state = "done";
  run.workers.readability.state = "done";
  run.state = "blocked";
  return run;
}

function resetTestState(): void {
  runs.clear();
  closedWorkers.length = 0;
  launches.length = 0;
  supervisedRuns.length = 0;
  currentCheckpoint = createTestCheckpoint({
    unstagedTrackedDiffSha256: "c".repeat(64),
  });
  launchError = undefined;
  saveCount = 0;
}

function toolContext() {
  return {
    sessionID: "session-test",
    messageID: "message-test",
    agent: "kilo",
    directory: "/test-project",
    worktree: "/test-project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  } as never;
}

async function createCoordinatorTools() {
  const inheritedRole = process.env.WORKFLOW_ROLE;
  const inheritedPane = process.env.HERDR_PANE_ID;
  delete process.env.WORKFLOW_ROLE;
  process.env.HERDR_PANE_ID = "pane-origin";

  try {
    return await workflowPlugin.server({
      client: {},
      directory: "/test-project",
      worktree: "/test-project",
    } as never);
  } finally {
    if (inheritedRole === undefined) {
      delete process.env.WORKFLOW_ROLE;
    } else {
      process.env.WORKFLOW_ROLE = inheritedRole;
    }
    if (inheritedPane === undefined) {
      delete process.env.HERDR_PANE_ID;
    } else {
      process.env.HERDR_PANE_ID = inheritedPane;
    }
  }
}
