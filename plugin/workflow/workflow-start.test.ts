import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  createRun as createTestRun,
  createTestCheckpoint,
} from "./supervisor-test-helpers.ts";

const persistedRuns: ReturnType<typeof createTestRun>[] = [];
const preflightSelections: unknown[] = [];
const launchedAgents: string[] = [];
const closedWorkers: string[] = [];
let preflightError: Error | undefined;
let checkpointError: Error | undefined;
let launchFailure: string | undefined;

mock.module("./run-store.ts", {
  exports: {
    createRun: (options: {
      workerAgents: Record<string, string>;
    }) => {
      const run = createTestRun();
      for (const [kind, agentKind] of Object.entries(options.workerAgents)) {
        run.workers[kind].definition = {
          ...run.workers[kind].definition!,
          agentKind: agentKind as "kilo" | "claude" | "codex",
        };
      }
      return run;
    },
    normalizeTaskCardPath: async () => undefined,
    saveNewRun: async (_projectRoot: string, run: ReturnType<typeof createTestRun>) => {
      persistedRuns.push(run);
    },
    saveRun: async () => undefined,
    withLockedRun: async (
      _projectRoot: string,
      _runId: string | undefined,
      _signal: AbortSignal | undefined,
      operation: () => Promise<unknown>,
    ) => operation(),
    withRunLock: async (
      _projectRoot: string,
      _runId: string,
      _signal: AbortSignal | undefined,
      operation: () => Promise<unknown>,
    ) => operation(),
  },
});

mock.module("./worker-profile.ts", {
  exports: {
    resolveWorkerAgents: (value: unknown) => ({
      tests: (value as { tests?: string } | undefined)?.tests ?? "kilo",
      "code-review":
        (value as { "code-review"?: string } | undefined)?.["code-review"] ??
        "kilo",
      readability:
        (value as { readability?: string } | undefined)?.readability ?? "kilo",
    }),
    preflightWorkerSelections: async (selections: unknown) => {
      preflightSelections.push(selections);
      if (preflightError) {
        throw preflightError;
      }
    },
  },
});

mock.module("./source-checkpoint.ts", {
  exports: {
    captureSourceCheckpoint: async () => {
      if (checkpointError) {
        throw checkpointError;
      }
      return createTestCheckpoint();
    },
  },
});

mock.module("./worker-service.ts", {
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
    }) => {
      const worker = options.run.workers[options.kind];
      if (launchFailure === options.kind) {
        throw new Error(`Launch failed for ${options.kind}.`);
      }
      launchedAgents.push(worker.definition!.agentKind);
      return {
        ...worker,
        attempt: 1,
        agentName: `agent-${options.kind}`,
        tabId: `tab-${options.kind}`,
        paneId: `pane-${options.kind}`,
        state: "working" as const,
      };
    },
    workerErrorRecord: (
      kind: "tests" | "code-review" | "readability",
      attempt: number,
      error: unknown,
      options: {
        definition: ReturnType<typeof createTestRun>["workers"]["tests"]["definition"];
        sourceCheckpoint: ReturnType<typeof createTestRun>["workers"]["tests"]["sourceCheckpoint"];
      },
    ) => ({
      kind,
      roleId: kind,
      attempt,
      definition: options.definition,
      sourceCheckpoint: options.sourceCheckpoint,
      state: "error" as const,
      lastError: error instanceof Error ? error.message : String(error),
    }),
  },
});

mock.module("./supervisor.ts", {
  exports: {
    WorkflowSupervisor: class {
      supervise(): void {}
      cancelWorker(): void {}
      async resumeForSession(): Promise<void> {}
      async dispose(): Promise<void> {}
    },
  },
});

const { default: workflowPlugin } = await import("../workflow.ts");

test("workflow_start preflights mixed selections before creating the run", async () => {
  resetTestState();
  const tools = await createCoordinatorTools();

  const result = await tools.tool!.workflow_start.execute(
    {
      task: "Validate mixed worker selections",
      workerAgents: {
        tests: "codex",
        "code-review": "claude",
      },
    },
    toolContext(),
  );

  assert.deepEqual(preflightSelections, [
    { tests: "codex", "code-review": "claude", readability: "kilo" },
  ]);
  assert.equal(persistedRuns.length, 1);
  assert.deepEqual(launchedAgents.sort(), ["claude", "codex", "kilo"]);
  assert.match(String(result), /run-/);
});

test("workflow_start preflight failure creates no run or worker tab", async () => {
  resetTestState();
  preflightError = new Error('Run "herdr integration install claude" and retry.');
  const tools = await createCoordinatorTools();

  await assert.rejects(
    tools.tool!.workflow_start.execute(
      {
        task: "Reject unavailable worker prerequisites",
        workerAgents: { "code-review": "claude" },
      },
      toolContext(),
    ),
    /herdr integration install claude/,
  );

  assert.equal(persistedRuns.length, 0);
  assert.deepEqual(launchedAgents, []);
  preflightError = undefined;
});

test("workflow_start checkpoint failure creates no durable run or worker tab", async () => {
  resetTestState();
  checkpointError = new Error("Git checkpoint capture failed.");
  const tools = await createCoordinatorTools();

  await assert.rejects(
    tools.tool!.workflow_start.execute(
      { task: "Reject an unreadable source state" },
      toolContext(),
    ),
    /Git checkpoint capture failed/,
  );

  assert.equal(persistedRuns.length, 0);
  assert.deepEqual(launchedAgents, []);
  checkpointError = undefined;
});

test("workflow_start cleans up already-created tabs after a partial launch failure", async () => {
  resetTestState();
  launchFailure = "code-review";
  const tools = await createCoordinatorTools();

  const result = await tools.tool!.workflow_start.execute(
    { task: "Clean up a partial launch" },
    toolContext(),
  );

  assert.match(String(result), /error/);
  assert.deepEqual(closedWorkers.sort(), ["readability", "tests"]);
  assert.equal(persistedRuns.length, 1);
  assert.equal(persistedRuns[0].workers["code-review"].state, "error");
  launchFailure = undefined;
});

function resetTestState(): void {
  persistedRuns.length = 0;
  preflightSelections.length = 0;
  launchedAgents.length = 0;
  closedWorkers.length = 0;
  preflightError = undefined;
  checkpointError = undefined;
  launchFailure = undefined;
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
  delete process.env.WORKFLOW_ROLE;

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
  }
}
