import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import * as path from "node:path";
import test, { mock } from "node:test";
import { tmpdir } from "node:os";

import {
  createRun as createFixtureRun,
  createTestCheckpoint,
} from "../plugin/workflow/supervisor-test-helpers.ts";
import type {
  ProjectContext,
} from "./workflow-contracts.ts";
import type { WorkflowServiceWorkerOperations } from "./workflow-service.ts";

const runs = new Map<string, ReturnType<typeof createFixtureRun>>();
const listedRuns: ReturnType<typeof createFixtureRun>[] = [];
const preflightSelections: unknown[] = [];
const supervisedRuns: string[] = [];
const cancelledWorkers: string[] = [];
const closedWorkers: string[] = [];
const promptedWorkers: string[] = [];
let supervisorCreations = 0;
let checkpointCount = 0;
let saveFailure: Error | undefined;
let supervisorStatusCalls = 0;
let abortDuringLaunch = false;
let abortOnSaveNewRun = false;

mock.module("./run-store.ts", {
  namedExports: {
    createRun: (options: {
      context: ProjectContext;
      workerAgents: Record<string, "kilo" | "claude" | "codex">;
    }) => {
      const run = createFixtureRun();
      run.origin = { ...options.context.origin };
      run.originSessionId = run.origin.sessionId;
      run.herdrWorkspaceId = run.origin.workspaceId;
      for (const [kind, agentKind] of Object.entries(options.workerAgents)) {
        run.workers[kind].definition = {
          ...run.workers[kind].definition!,
          agentKind,
        };
      }
      return run;
    },
    normalizeTaskCardPath: async () => undefined,
    listRuns: async () => listedRuns,
    saveNewRun: async (_projectRoot: string, run: ReturnType<typeof createFixtureRun>) => {
      runs.set(run.id, run);
      if (abortOnSaveNewRun) {
        testSignal?.abort(new Error("cancelled before worker launch"));
      }
    },
    saveRun: async (_projectRoot: string, run: ReturnType<typeof createFixtureRun>) => {
      if (saveFailure) {
        throw saveFailure;
      }
      runs.set(run.id, run);
    },
    withLockedRun: async (
      _projectRoot: string,
      runId: string | undefined,
      _signal: AbortSignal | undefined,
      operation: (run: ReturnType<typeof createFixtureRun>) => Promise<unknown>,
    ) => {
      const run = runs.get(runId ?? "") ?? [...runs.values()].at(-1);
      if (!run) {
        throw new Error("No test workflow run exists.");
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

mock.module("./source-checkpoint.ts", {
  namedExports: {
    captureSourceCheckpoint: async () => {
      checkpointCount += 1;
      return createTestCheckpoint();
    },
  },
});

mock.module("./worker-profile.ts", {
  namedExports: {
    resolveWorkerAgents: (value: Record<string, string> | undefined) => ({
      tests: value?.tests ?? "kilo",
      "code-review": value?.["code-review"] ?? "kilo",
      readability: value?.readability ?? "kilo",
    }),
    preflightWorkerSelections: async (selections: unknown) => {
      preflightSelections.push(selections);
    },
  },
});

mock.module("./worker-service.ts", {
  namedExports: {
    closeWorker: async (
      _run: ReturnType<typeof createFixtureRun>,
      worker: { kind: string },
    ) => {
      closedWorkers.push(worker.kind);
    },
    inspectWorker: async () => ({ state: "working" }),
    promptWorker: async (agentName: string) => {
      promptedWorkers.push(agentName);
      return 7;
    },
    spawnWorker: async (options: {
      run: ReturnType<typeof createFixtureRun>;
      kind: "tests" | "code-review" | "readability";
      attempt: number;
      sourceCheckpoint: ReturnType<typeof createTestCheckpoint>;
    }) => {
      if (abortDuringLaunch) {
        abortDuringLaunch = false;
        testSignal?.abort(new Error("launch cancelled"));
      }
      const worker = options.run.workers[options.kind];
      return {
        ...worker,
        attempt: options.attempt,
        agentName: `agent-${options.kind}`,
        tabId: `tab-${options.kind}`,
        paneId: `pane-${options.kind}`,
        sourceCheckpoint: options.sourceCheckpoint,
        state: "working" as const,
      };
    },
    workerErrorRecord: (
      kind: "tests" | "code-review" | "readability",
      attempt: number,
      error: unknown,
      options: {
        definition: ReturnType<typeof createFixtureRun>["workers"]["tests"]["definition"];
        sourceCheckpoint: ReturnType<typeof createTestCheckpoint>;
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
  namedExports: {
    WorkflowSupervisor: class {
      private readonly supervised = new Set<string>();

      constructor() {
        supervisorCreations += 1;
      }

      async reconcileOnce(): Promise<Map<"tests" | "code-review" | "readability", never>> {
        supervisorStatusCalls += 1;
        return new Map();
      }

      supervise(runId: string): void {
        if (this.supervised.has(runId)) {
          return;
        }
        this.supervised.add(runId);
        supervisedRuns.push(runId);
      }

      cancelWorker(runId: string, kind: string): void {
        cancelledWorkers.push(`${runId}:${kind}`);
      }

      async dispose(): Promise<void> {}
    },
  },
});

const { WorkflowService } = await import("./workflow-service.ts");

let testSignal: AbortController | undefined;

test("service start preflights, snapshots, launches, and returns serializable data", async () => {
  reset();
  const service = createService();
  const result = await service.start({
    context: createContext(),
    task: "centralize workflow operations",
    workerAgents: { tests: "codex", "code-review": "claude" },
  });

  assert.deepEqual(preflightSelections, [
    { tests: "codex", "code-review": "claude", readability: "kilo" },
  ]);
  assert.equal(checkpointCount, 1);
  assert.equal(runs.get(result.runId)?.workers.tests.definition?.agentKind, "codex");
  assert.deepEqual(supervisedRuns, [result.runId]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("status performs explicit cross-origin inspection without supervision or wake delivery", async () => {
  reset();
  const run = createFixtureRun();
  runs.set(run.id, run);
  const notifierCalls: unknown[] = [];
  const service = createService({
    notifier: { notify: async (batch) => notifierCalls.push(batch) },
  });

  const result = await service.status({
    context: createContext("other-pane", "other-session"),
    runId: run.id,
  });

  assert.equal(result.runId, run.id);
  assert.equal(supervisorStatusCalls, 1);
  assert.deepEqual(supervisedRuns, []);
  assert.deepEqual(notifierCalls, []);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("send and stop share origin checks and persist their mutation results", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  const service = createService();
  const context = createContext();

  const sent = await service.send({
    context,
    runId: run.id,
    worker: "tests",
    message: "Please report the current evidence.",
  });
  const stopped = await service.stop({
    context,
    runId: run.id,
    worker: "tests",
  });

  assert.equal(sent.worker, "tests");
  assert.equal(stopped.message, "tests stopped.");
  assert.deepEqual(promptedWorkers, ["agent-tests"]);
  assert.deepEqual(closedWorkers, ["tests"]);
  assert.equal(run.workers.tests.state, "stopped");
  assert.equal(run.workers.tests.tabId, undefined);
});

test("blocked workers accept guidance, while stale resource identity and prompt failures refuse send", async () => {
  reset();
  const run = createActiveRun();
  run.workers.tests.state = "blocked";
  runs.set(run.id, run);
  const service = createService();

  await service.send({
    context: createContext(),
    runId: run.id,
    worker: "tests",
    message: "Continue and report the blocker.",
  });
  assert.deepEqual(promptedWorkers, ["agent-tests"]);

  run.workers.tests.tabId = undefined;
  await assert.rejects(
    service.send({
      context: createContext(),
      runId: run.id,
      worker: "tests",
      message: "This identity is stale.",
    }),
    /incomplete Herdr resource identity/,
  );

  run.workers.tests.tabId = "tab-tests";
  const promptFailure = new Error("prompt failed");
  await assert.rejects(
    createService({
      operations: {
        promptWorker: async () => {
          throw promptFailure;
        },
      },
    }).send({
      context: createContext(),
      runId: run.id,
      worker: "tests",
      message: "The prompt should fail.",
    }),
    /prompt failed/,
  );
});

test("status supports latest lookup and preserves pending delivery failures", async () => {
  reset();
  const run = createFixtureRun();
  run.notifications = [
    {
      sequence: 1,
      key: "tests:1:error:1",
      kind: "worker-error",
      message: "Tests failed.",
      createdAt: new Date().toISOString(),
      deliveryError: "origin unavailable",
    },
  ];
  runs.set(run.id, run);
  const result = await createService().status({
    context: createContext(),
  });

  assert.equal(result.runId, run.id);
  assert.equal(result.notifications[0].deliveryError, "origin unavailable");
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("recovery resumes only same-origin active runs and pending terminal outboxes", async () => {
  reset();
  const active = createFixtureRun();
  const pendingTerminal = createFixtureRun();
  for (const worker of Object.values(pendingTerminal.workers)) {
    worker.state = "stopped";
  }
  pendingTerminal.state = "stopped";
  pendingTerminal.notifications = [
    {
      sequence: 1,
      key: "tests:1:error:1",
      kind: "worker-error",
      message: "Tests failed.",
      createdAt: new Date().toISOString(),
    },
  ];

  const completed = createFixtureRun();
  for (const worker of Object.values(completed.workers)) {
    worker.state = "stopped";
  }
  completed.state = "stopped";

  const differentPane = createFixtureRun();
  differentPane.origin = { ...active.origin, paneId: "other-pane" };
  const differentWorkspace = createFixtureRun();
  differentWorkspace.origin = { ...active.origin, workspaceId: "other-workspace" };
  const differentKind = createFixtureRun();
  differentKind.origin = { ...active.origin, coordinatorKind: "claude" };
  const differentSession = createFixtureRun();
  differentSession.origin = { ...active.origin, sessionId: "other-session" };

  listedRuns.push(
    active,
    pendingTerminal,
    completed,
    differentPane,
    differentWorkspace,
    differentKind,
    differentSession,
  );

  const result = await createService().recover({ context: createContext() });

  assert.deepEqual(result.runIds, [active.id, pendingTerminal.id]);
  assert.deepEqual(supervisedRuns, [active.id, pendingTerminal.id]);
});

test("recovery allows a pane match when optional Kilo session metadata is absent", async () => {
  reset();
  const run = createFixtureRun();
  run.origin = {
    workspaceId: "workspace-test",
    paneId: "pane-origin",
    coordinatorKind: "kilo",
  };
  run.originSessionId = undefined;
  listedRuns.push(run);

  const result = await createService().recover({
    context: createContext("pane-origin", "new-session"),
  });

  assert.deepEqual(result.runIds, [run.id]);
});

test("recovery shares one supervisor across symlink-equivalent project roots", async () => {
  reset();
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-recovery-"));
  const linkedRoot = `${projectRoot}-link`;

  try {
    await symlink(
      projectRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir",
    );
    const run = createFixtureRun();
    listedRuns.push(run);
    const service = createService();

    await service.recover({ context: createContext("pane-origin", "session-test", undefined, projectRoot) });
    await service.recover({ context: createContext("pane-origin", "session-test", undefined, linkedRoot) });

    assert.equal(supervisorCreations, 1);
    assert.deepEqual(supervisedRuns, [run.id]);
  } finally {
    await rm(linkedRoot, { force: true, recursive: true });
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("disposal stops the current supervisor and permits same-origin restart recovery", async () => {
  reset();
  const run = createFixtureRun();
  listedRuns.push(run);
  const service = createService();

  await service.recover({ context: createContext() });
  await service.dispose();
  await service.recover({ context: createContext() });

  assert.equal(supervisorCreations, 2);
  assert.deepEqual(supervisedRuns, [run.id, run.id]);
});

test("persistence and cleanup failures do not report send, stop, or retry success", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  saveFailure = new Error("durable save failed");

  await assert.rejects(
    createService().send({
      context: createContext(),
      runId: run.id,
      worker: "tests",
      message: "Persist this instruction.",
    }),
    /durable save failed/,
  );

  await assert.rejects(
    createService().stop({
      context: createContext(),
      runId: run.id,
      worker: "tests",
    }),
    /durable save failed/,
  );

  await assert.rejects(
    createService().retry({
      context: createContext(),
      runId: run.id,
      worker: "tests",
    }),
    /durable save failed/,
  );
  saveFailure = undefined;

  await assert.rejects(
    createService({
      operations: {
        closeWorker: async () => {
          throw new Error("close failed");
        },
      },
    }).stop({
      context: createContext(),
      runId: run.id,
      worker: "tests",
    }),
    /close failed/,
  );
});

test("send and stop cancellation never report success", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  testSignal = new AbortController();

  await assert.rejects(
    createService({
      operations: {
        promptWorker: async () => {
          testSignal?.abort(new Error("send cancelled"));
          return 8;
        },
      },
    }).send({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
      message: "Cancel this send.",
    }),
    /send cancelled/,
  );

  testSignal = new AbortController();
  await assert.rejects(
    createService({
      operations: {
        closeWorker: async () => {
          testSignal?.abort(new Error("stop cancelled"));
        },
      },
    }).stop({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /stop cancelled/,
  );
});

test("retry cancellation cleans the replacement attempt before failing", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  testSignal = new AbortController();

  await assert.rejects(
    createService({
      operations: {
        spawnWorker: async (workerOptions) => {
          testSignal?.abort(new Error("retry cancelled"));
          return {
            ...workerOptions.run.workers[workerOptions.kind],
            attempt: workerOptions.attempt,
            agentName: "replacement-tests",
            tabId: "replacement-tab-tests",
            paneId: "replacement-pane-tests",
            sourceCheckpoint: workerOptions.sourceCheckpoint,
            state: "working" as const,
          };
        },
      },
    }).retry({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /retry cancelled/,
  );
  assert.equal(run.workers.tests.state, "error");
  assert.ok(closedWorkers.length > 0);
  assert.deepEqual(supervisedRuns, []);
});

test("retry cancellation during checkpoint capture leaves the existing attempt untouched", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  testSignal = new AbortController();

  await assert.rejects(
    createService({
      operations: {
        captureSourceCheckpoint: async () => {
          testSignal?.abort(new Error("checkpoint cancelled"));
          return createTestCheckpoint();
        },
      },
    }).retry({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /checkpoint cancelled/,
  );
  assert.equal(run.workers.tests.state, "working");
  assert.equal(run.workers.tests.tabId, "tab-tests");
  assert.deepEqual(closedWorkers, []);
  assert.deepEqual(cancelledWorkers, []);
});

test("retry cancellation during existing-tab cleanup keeps the attempt supervised", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  testSignal = new AbortController();
  const closeError = new Error("close cancelled");

  await assert.rejects(
    createService({
      operations: {
        closeWorker: async () => {
          testSignal?.abort(closeError);
          throw closeError;
        },
      },
    }).retry({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /close cancelled/,
  );
  assert.equal(run.workers.tests.state, "working");
  assert.equal(run.workers.tests.tabId, "tab-tests");
  assert.deepEqual(cancelledWorkers, []);
});

test("retry cancellation after closing a stale attempt clears active evidence", async () => {
  reset();
  const run = createActiveRun();
  const worker = run.workers.tests;
  worker.state = "stale";
  worker.result = {
    output: "stale report",
    capturedAt: worker.sourceCheckpoint!.capturedAt,
  };
  worker.staleDetails = {
    baseline: worker.sourceCheckpoint!,
    current: createTestCheckpoint({ unstagedTrackedDiffSha256: "c".repeat(64) }),
    reason: "source changed",
  };
  runs.set(run.id, run);
  testSignal = new AbortController();

  await assert.rejects(
    createService({
      operations: {
        closeWorker: async () => {
          testSignal?.abort(new Error("cancelled after close"));
        },
      },
    }).retry({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /cancelled after close/,
  );
  assert.equal(worker.state, "error");
  assert.equal(worker.result, undefined);
  assert.equal(worker.staleDetails, undefined);
  assert.equal(worker.attemptHistory?.[0].result?.output, "stale report");
  assert.notEqual(run.state, "reviews-complete");
});

test("stop cancellation during tab cleanup keeps supervision active", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  testSignal = new AbortController();
  const closeError = new Error("stop close cancelled");

  await assert.rejects(
    createService({
      operations: {
        closeWorker: async () => {
          testSignal?.abort(closeError);
          throw closeError;
        },
      },
    }).stop({
      context: createContext("pane-origin", "session-test", testSignal.signal),
      runId: run.id,
      worker: "tests",
    }),
    /stop close cancelled/,
  );
  assert.equal(run.workers.tests.state, "working");
  assert.deepEqual(cancelledWorkers, []);
});

test("cross-origin retry is refused before checkpoint capture or resource mutation", async () => {
  reset();
  const run = createActiveRun();
  runs.set(run.id, run);
  const service = createService();

  await assert.rejects(
    service.retry({
      context: createContext("other-pane", "other-session"),
      runId: run.id,
      worker: "tests",
    }),
    /not the workflow origin pane/,
  );
  assert.equal(checkpointCount, 0);
  assert.deepEqual(cancelledWorkers, []);
  assert.deepEqual(closedWorkers, []);
});

test("cancellation after worker launch closes owned tabs and never starts supervision", async () => {
  reset();
  testSignal = new AbortController();
  abortDuringLaunch = true;
  const service = createService();

  await assert.rejects(
    service.start({
      context: createContext("origin-pane", "origin-session", testSignal.signal),
      task: "cancel a launch transaction",
    }),
    /launch cancelled/,
  );
  assert.ok(closedWorkers.length > 0);
  assert.deepEqual(supervisedRuns, []);
});

test("cancellation before worker launch persists a stopped run without supervision", async () => {
  reset();
  testSignal = new AbortController();
  abortOnSaveNewRun = true;
  const service = createService();

  await assert.rejects(
    service.start({
      context: createContext("origin-pane", "origin-session", testSignal.signal),
      task: "cancel before a worker tab exists",
    }),
    /before worker launch/,
  );
  const run = [...runs.values()].at(-1);
  assert.ok(run);
  assert.equal(run.state, "stopped");
  assert.ok(Object.values(run.workers).every((worker) => worker.state === "stopped"));
  assert.deepEqual(supervisedRuns, []);
});

function createService(options: {
  notifier?: { notify: (batch: unknown) => Promise<void> };
  operations?: Partial<WorkflowServiceWorkerOperations>;
} = {}) {
  const operations: WorkflowServiceWorkerOperations = {
    captureSourceCheckpoint: async () => {
      checkpointCount += 1;
      return createTestCheckpoint();
    },
    inspectWorker: async () => ({ state: "working" }),
    waitForWorkerState: async () => undefined,
    closeWorker: async (_run, worker) => {
      closedWorkers.push(worker.kind);
    },
    spawnWorker: async (workerOptions) => {
      if (abortDuringLaunch) {
        abortDuringLaunch = false;
        testSignal?.abort(new Error("launch cancelled"));
      }
      return {
        ...workerOptions.run.workers[workerOptions.kind],
        attempt: workerOptions.attempt,
        agentName: `agent-${workerOptions.kind}`,
        tabId: `tab-${workerOptions.kind}`,
        paneId: `pane-${workerOptions.kind}`,
        sourceCheckpoint: workerOptions.sourceCheckpoint,
        state: "working" as const,
      };
    },
    promptWorker: async (agentName) => {
      promptedWorkers.push(agentName);
      return 7;
    },
    workerErrorRecord: (kind, attempt, error, workerOptions) => ({
      kind,
      roleId: kind,
      attempt,
      definition: workerOptions.definition,
      sourceCheckpoint: workerOptions.sourceCheckpoint,
      state: "error" as const,
      lastError: error instanceof Error ? error.message : String(error),
    }),
  };

  return new WorkflowService({
    notifier: options.notifier ?? { notify: async () => undefined },
    workerOperations: { ...operations, ...options.operations },
  });
}

function createActiveRun() {
  const run = createFixtureRun();
  const worker = run.workers.tests;
  worker.attempt = 1;
  worker.agentName = "agent-tests";
  worker.tabId = "tab-tests";
  worker.paneId = "pane-tests";
  worker.state = "working";
  for (const kind of ["code-review", "readability"] as const) {
    run.workers[kind].state = "stopped";
  }
  return run;
}

function createContext(
  paneId = "pane-origin",
  sessionId = "session-test",
  signal = new AbortController().signal,
  projectRoot = path.resolve(process.cwd()),
): ProjectContext {
  return {
    projectRoot,
    origin: {
      workspaceId: "workspace-test",
      paneId,
      coordinatorKind: "kilo",
      sessionId,
    },
    signal,
    hostSession: { sessionId },
  };
}

function reset(): void {
  runs.clear();
  listedRuns.length = 0;
  preflightSelections.length = 0;
  supervisedRuns.length = 0;
  cancelledWorkers.length = 0;
  closedWorkers.length = 0;
  promptedWorkers.length = 0;
  supervisorCreations = 0;
  checkpointCount = 0;
  saveFailure = undefined;
  supervisorStatusCalls = 0;
  abortDuringLaunch = false;
  abortOnSaveNewRun = false;
  testSignal = undefined;
}
