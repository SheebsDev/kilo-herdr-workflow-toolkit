import assert from "node:assert/strict";
import * as path from "node:path";
import test, { mock } from "node:test";

const calls: Array<{ operation: string; input?: unknown }> = [];
let serviceConstructed = 0;

mock.module("../../core/worker-service.ts", {
  exports: {
    requireHerdrWorkspace: () => "workspace-test",
  },
});

mock.module("../../core/workflow-service.ts", {
  exports: {
    WorkflowService: class {
      constructor() {
        serviceConstructed += 1;
      }

      async start(input: unknown) {
        calls.push({ operation: "start", input });
        return { runId: "run-start", state: "reviewing", workers: {} };
      }

      async status(input: unknown) {
        calls.push({ operation: "status", input });
        return {
          runId: "run-status",
          task: "Adapter test",
          state: "reviewing",
          workers: [],
          notifications: [],
        };
      }

      async send(input: unknown) {
        calls.push({ operation: "send", input });
        return {
          runId: "run-send",
          worker: "tests",
          state: "reviewing",
          message: "Instruction sent to tests (agent-tests).",
        };
      }

      async stop(input: unknown) {
        calls.push({ operation: "stop", input });
        return {
          runId: "run-stop",
          worker: "tests",
          state: "blocked",
          message: "tests stopped.",
        };
      }

      async retry(input: unknown) {
        calls.push({ operation: "retry", input });
        return {
          runId: "run-retry",
          worker: "tests",
          state: "reviewing",
          message: "tests retry started.",
          workerRecord: { kind: "tests", state: "working" },
          workerResult: { kind: "tests", state: "working" },
        };
      }

      async recover(input: unknown) {
        calls.push({ operation: "recover", input });
        return { runIds: ["run-recovered"] };
      }

      async dispose() {
        calls.push({ operation: "dispose" });
      }
    },
  },
});

const { default: workflowPlugin } = await import("../workflow.ts");

test("Kilo adapter preserves its public tools and maps every operation", async () => {
  resetState();
  const hooks = await createCoordinatorHooks();
  const tools = hooks.tool!;

  assert.deepEqual(Object.keys(tools).sort(), [
    "workflow_retry",
    "workflow_send",
    "workflow_start",
    "workflow_status",
    "workflow_stop",
  ]);
  assert.match(tools.workflow_start.description, /parallel engineering verification workflow/);
  assert.match(tools.workflow_status.description, /durably captured state/);
  assert.match(tools.workflow_send.description, /targeted instruction/);
  assert.match(tools.workflow_stop.description, /Terminate one workflow worker/);
  assert.match(tools.workflow_retry.description, /fresh source checkpoint/);

  assert.deepEqual(
    Object.keys(tools.workflow_start.args).sort(),
    ["task", "taskCardPath", "workerAgents"],
  );
  assert.deepEqual(
    Object.keys(tools.workflow_status.args).sort(),
    ["includeOutput", "runId", "worker"],
  );
  assert.deepEqual(
    Object.keys(tools.workflow_send.args).sort(),
    ["message", "runId", "worker"],
  );
  assert.deepEqual(Object.keys(tools.workflow_stop.args).sort(), [
    "runId",
    "worker",
  ]);
  assert.deepEqual(Object.keys(tools.workflow_retry.args).sort(), [
    "additionalInstruction",
    "runId",
    "worker",
  ]);

  const context = toolContext();
  const startResult = await tools.workflow_start.execute(
    {
      task: "Adapter mapping",
      taskCardPath: ".kilo/plans/TASK-009.md",
      workerAgents: { tests: "codex" },
    },
    context,
  );
  const statusResult = await tools.workflow_status.execute(
    { runId: "run-status", worker: "tests", includeOutput: true },
    context,
  );
  const sendResult = await tools.workflow_send.execute(
    { runId: "run-send", worker: "tests", message: "Report now." },
    context,
  );
  const stopResult = await tools.workflow_stop.execute(
    { runId: "run-stop", worker: "tests" },
    context,
  );
  const retryResult = await tools.workflow_retry.execute(
    {
      runId: "run-retry",
      worker: "tests",
      additionalInstruction: "Use the current checkpoint.",
    },
    context,
  );

  assert.deepEqual(JSON.parse(String(startResult)), {
    runId: "run-start",
    state: "reviewing",
    workers: {},
  });
  assert.deepEqual(JSON.parse(String(statusResult)), {
    runId: "run-status",
    task: "Adapter test",
    state: "reviewing",
    workers: [],
    notifications: [],
  });
  assert.equal(sendResult, "Instruction sent to tests (agent-tests).");
  assert.equal(stopResult, "tests stopped.");
  assert.deepEqual(JSON.parse(String(retryResult)), {
    runId: "run-retry",
    worker: { kind: "tests", state: "working" },
    state: "reviewing",
  });

  const inputs = new Map(
    calls
      .filter(({ operation }) => operation !== "dispose")
      .map(({ operation, input }) => [operation, input as AdapterInput]),
  );
  for (const operation of ["start", "status", "send", "stop", "retry"]) {
    const input = inputs.get(operation)!;
    assert.equal(input.context.projectRoot, path.resolve("/test-project"));
    assert.deepEqual(input.context.origin, {
      workspaceId: "workspace-test",
      paneId: "pane-origin",
      coordinatorKind: "kilo",
      sessionId: "session-test",
    });
    assert.equal(input.context.signal, context.abort);
  }
});

test("Kilo adapter forwards recovery events and local disposal", async () => {
  resetState();
  const hooks = await createCoordinatorHooks();

  await hooks.event!({
    event: {
      type: "session.idle",
      properties: { sessionID: "session-idle" },
    } as never,
  });
  await hooks.dispose!();

  const recovery = calls.find(({ operation }) => operation === "recover")!
    .input as AdapterInput;
  assert.equal(recovery.context.origin.sessionId, "session-idle");
  assert.equal(recovery.context.projectRoot, path.resolve("/test-project"));
  assert.equal(calls.at(-1)?.operation, "dispose");
});

test("worker processes expose no adapter or service resources", async () => {
  resetState();
  const previousRole = process.env.WORKFLOW_ROLE;
  const previousRunId = process.env.WORKFLOW_RUN_ID;
  process.env.WORKFLOW_ROLE = "tests";
  process.env.WORKFLOW_RUN_ID = "run-worker";

  try {
    const hooks = await workflowPlugin.server({
      client: {},
      directory: "/test-project",
      worktree: "/test-project",
    } as never);

    assert.deepEqual(hooks, {});
    assert.equal(serviceConstructed, 0);
  } finally {
    restoreEnvironment("WORKFLOW_ROLE", previousRole);
    restoreEnvironment("WORKFLOW_RUN_ID", previousRunId);
  }
});

interface AdapterInput {
  context: {
    projectRoot: string;
    origin: Record<string, string>;
    signal: AbortSignal;
  };
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

async function createCoordinatorHooks() {
  const previousRole = process.env.WORKFLOW_ROLE;
  const previousRunId = process.env.WORKFLOW_RUN_ID;
  const previousPane = process.env.HERDR_PANE_ID;
  delete process.env.WORKFLOW_ROLE;
  delete process.env.WORKFLOW_RUN_ID;
  process.env.HERDR_PANE_ID = "pane-origin";

  try {
    return await workflowPlugin.server({
      client: {},
      directory: "/test-project",
      worktree: "/test-project",
    } as never);
  } finally {
    restoreEnvironment("WORKFLOW_ROLE", previousRole);
    restoreEnvironment("WORKFLOW_RUN_ID", previousRunId);
    restoreEnvironment("HERDR_PANE_ID", previousPane);
  }
}

function resetState(): void {
  calls.length = 0;
  serviceConstructed = 0;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
