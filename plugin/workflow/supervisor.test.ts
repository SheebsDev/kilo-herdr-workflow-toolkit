import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { createAgentName } from "./model.ts";
import { createRun, createTestCheckpoint } from "./supervisor-test-helpers.ts";

const runs = new Map<string, ReturnType<typeof createRun>>();
let currentCheckpoint = createTestCheckpoint();
let inspectionOutput = "VERDICT: PASS";
let captureCount = 0;
const closedWorkers: string[] = [];

mock.module("./run-store.ts", {
  exports: {
    listRuns: async () => [...runs.values()],
    loadRun: async (_projectRoot: string, runId: string) => {
      const run = runs.get(runId);
      if (!run) {
        throw new Error(`Missing test run ${runId}.`);
      }
      return run;
    },
    saveRun: async () => undefined,
    withLockedRun: async (
      _projectRoot: string,
      runId: string | undefined,
      _signal: AbortSignal | undefined,
      operation: (run: ReturnType<typeof createRun>) => Promise<unknown>,
    ) => {
      const run = runs.get(runId ?? "");
      if (!run) {
        throw new Error(`Missing test run ${runId}.`);
      }
      return operation(run);
    },
  },
});

mock.module("./source-checkpoint.ts", {
  exports: {
    captureSourceCheckpoint: async () => {
      captureCount += 1;
      return currentCheckpoint;
    },
    sourceCheckpointsEqual: (
      left: ReturnType<typeof createTestCheckpoint>,
      right: ReturnType<typeof createTestCheckpoint>,
    ) =>
      left.headId === right.headId &&
      left.stagedDiffSha256 === right.stagedDiffSha256 &&
      left.unstagedTrackedDiffSha256 === right.unstagedTrackedDiffSha256,
  },
});

mock.module("./worker-service.ts", {
  exports: {
    closeWorker: async (
      _run: ReturnType<typeof createRun>,
      worker: { kind: string },
    ) => {
      closedWorkers.push(worker.kind);
    },
    errorMessage: (error: unknown) =>
      error instanceof Error ? error.message : String(error),
    inspectWorker: async () => ({
      state: "done",
      output: inspectionOutput,
    }),
    waitForWorkerState: async () => undefined,
  },
});

const { WorkflowSupervisor } = await import("./supervisor.ts");

test("unchanged completion is captured and valid results remain stable", async () => {
  resetTestState();
  const run = createWorkerRun();
  runs.set(run.id, run);
  const supervisor = new WorkflowSupervisor(createClient(), "/test-project");

  try {
    supervisor.supervise(run.id);
    await waitFor(() => run.workers.tests.tabId === undefined);

    const result = run.workers.tests.result;
    assert.ok(result);
    assert.equal(run.workers.tests.state, "done");
    assert.equal(run.state, "reviews-complete");
    assert.equal(run.workers.tests.staleDetails, undefined);
    assert.deepEqual(closedWorkers, ["tests"]);
    assert.equal(captureCount, 1);

    currentCheckpoint = createTestCheckpoint({
      unstagedDiffSha256: "c".repeat(64),
    });
    supervisor.supervise(run.id);

    assert.equal(run.workers.tests.result, result);
    assert.equal(run.workers.tests.state, "done");
    assert.equal(captureCount, 1);
    assert.deepEqual(closedWorkers, ["tests"]);
  } finally {
    await supervisor.dispose();
    runs.delete(run.id);
  }
});

for (const [label, change] of [
  ["HEAD", { headId: "changed-head" }],
  ["staged", { stagedDiffSha256: "c".repeat(64) }],
  ["unstaged", { unstagedTrackedDiffSha256: "c".repeat(64) }],
] as const) {
  test(`a ${label} checkpoint change marks the report stale`, async () => {
    resetTestState();
    inspectionOutput = "x".repeat(300_000);
    const run = createWorkerRun();
    runs.set(run.id, run);
    currentCheckpoint = createTestCheckpoint(change);
    const supervisor = new WorkflowSupervisor(createClient(), "/test-project");

    try {
      supervisor.supervise(run.id);
      await waitFor(() => run.workers.tests.tabId === undefined);
      supervisor.supervise(run.id);

      const worker = run.workers.tests;
      assert.equal(worker.state, "stale");
      assert.ok(worker.result);
      assert.ok(worker.result.output.length <= 256 * 1024);
      assert.match(worker.result.output, /truncated before persistence/);
      assert.deepEqual(worker.staleDetails?.current, currentCheckpoint);
      assert.equal(run.state, "blocked");
      assert.equal(
        run.notifications?.filter(({ kind }) => kind === "worker-stale").length,
        1,
      );
      assert.deepEqual(closedWorkers, ["tests"]);
    } finally {
      await supervisor.dispose();
      runs.delete(run.id);
    }
  });
}

function createWorkerRun() {
  const run = createRun();
  const worker = run.workers.tests;
  worker.attempt = 1;
  worker.agentName = createAgentName(run.id, "tests", 1);
  worker.tabId = "tab-tests";
  worker.paneId = "pane-tests";
  worker.sourceCheckpoint = createTestCheckpoint();
  worker.state = "working";

  for (const kind of ["code-review", "readability"] as const) {
    run.workers[kind].state = "stopped";
  }

  return run;
}

function createClient() {
  return {
    session: {
      promptAsync: async () => undefined,
    },
  } as never;
}

function resetTestState(): void {
  runs.clear();
  currentCheckpoint = createTestCheckpoint();
  inspectionOutput = "VERDICT: PASS";
  captureCount = 0;
  closedWorkers.length = 0;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for supervisor test state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
