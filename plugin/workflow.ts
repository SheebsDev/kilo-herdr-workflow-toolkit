import type { Plugin } from "@kilocode/plugin";
import { tool } from "@kilocode/plugin/tool";

import {
  isWorkerKind,
  refreshRunState,
  summarizeWorkers,
  WORKER_ORDER,
} from "./workflow/model.ts";
import type { WorkflowRun } from "./workflow/model.ts";
import {
  createRun,
  normalizeTaskCardPath,
  saveNewRun,
  saveRun,
  withLockedRun,
  withRunLock,
} from "./workflow/run-store.ts";
import {
  closeWorker,
  inspectWorker,
  promptWorker,
  requireHerdrWorkspace,
  spawnWorker,
  workerErrorRecord,
} from "./workflow/worker-service.ts";
import { WorkflowSupervisor } from "./workflow/supervisor.ts";

const workflowPlugin: Plugin = async ({ client, directory, worktree }) => {
  const workflowRole = process.env.WORKFLOW_ROLE;

  // Review workers should not expose tools that can create more workers.
  if (isWorkerKind(workflowRole) && process.env.WORKFLOW_RUN_ID) {
    return {};
  }

  const supervisor = new WorkflowSupervisor(
    client,
    worktree || directory,
  );

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await supervisor.resumeForSession(event.properties.sessionID);
      }
    },

    dispose: () => supervisor.dispose(),

    tool: {
      workflow_start: tool({
        description: `
Start the project's parallel engineering verification workflow.

Use this AFTER implementing a Task Card, feature, bug fix, or other code
change and reaching a stable implementation checkpoint.

This launches three independent Kilo Code sessions in new Herdr tabs:

- test verification
- code review
- human readability review

The plugin supervises them asynchronously and wakes the originating Kilo
session when coordinator action is required. Completed reports are persisted
before completed worker tabs are closed.

Do not call this while implementation files are still actively changing.
`,
        args: {
          task: tool.schema
            .string()
            .trim()
            .min(1)
            .max(8_000)
            .describe("Task identifier or short description being reviewed."),
          taskCardPath: tool.schema
            .string()
            .max(500)
            .optional()
            .describe(
              "Optional project-relative path to the Task Card being implemented.",
            ),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          const run = createRun({
            task: args.task,
            originSessionId: context.sessionID,
            paneId: process.env.HERDR_PANE_ID,
            taskCardPath: await normalizeTaskCardPath(
              projectRoot,
              args.taskCardPath,
            ),
            workspaceId: requireHerdrWorkspace(),
          });

          await saveNewRun(projectRoot, run);
          await withRunLock(
            projectRoot,
            run.id,
            context.abort,
            () => launchWorkers(run, projectRoot, context.abort),
          );
          supervisor.supervise(run.id);

          return JSON.stringify(
            {
              runId: run.id,
              state: run.state,
              workers: summarizeWorkers(run),
            },
            null,
            2,
          );
        },
      }),

      workflow_status: tool({
        description: `
Inspect the live or durably captured state of the current engineering workflow.

Use this when the user asks for status, asks what a worker is doing,
or when you need to collect completed review results.

Normal completion is pushed to the originating session automatically; manual
polling is not required.

If no run ID is supplied, the most recently created workflow run is used.
`,
        args: {
          runId: tool.schema
            .string()
            .optional()
            .describe("Workflow run ID. Defaults to the latest run."),
          worker: tool.schema
            .enum(WORKER_ORDER)
            .optional()
            .describe(
              "Optional worker: tests, code-review, or readability.",
            ),
          includeOutput: tool.schema
            .boolean()
            .optional()
            .describe(
              "Include recent terminal output. Defaults to true for a specifically requested worker and completed/blocked workers.",
            ),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          return withLockedRun(
            projectRoot,
            args.runId,
            context.abort,
            async (run) => {
              const kinds = args.worker ? [args.worker] : WORKER_ORDER;
              const statuses = await Promise.all(
                kinds.map(async (kind) => {
                  const worker = run.workers[kind];
                  const status = await inspectWorker({
                    worker,
                    projectRoot,
                    includeOutput:
                      args.includeOutput ?? Boolean(args.worker),
                    signal: context.abort,
                  });

                  worker.state = status.state;
                  worker.lastError = status.error;
                  if (status.stateChangeSeq !== undefined) {
                    worker.stateChangeSeq = status.stateChangeSeq;
                  }

                  if (status.promptStarted) {
                    worker.pendingPromptStartSeq = undefined;
                  }

                  return {
                    kind,
                    state: status.state,
                    tabId: worker.tabId,
                    paneId: worker.paneId,
                    agentName: worker.agentName,
                    attempt: worker.attempt,
                    error: status.error,
                    output: status.output,
                    cleanupError: worker.cleanupError,
                  };
                }),
              );

              await updateRun(projectRoot, run);
              supervisor.supervise(run.id);

              return JSON.stringify(
                {
                  runId: run.id,
                  task: run.task,
                  state: run.state,
                  workers: statuses,
                },
                null,
                2,
              );
            },
          );
        },
      }),

      workflow_send: tool({
        description: `
Send a targeted instruction to an existing workflow worker.

Use this to redirect a worker, narrow its investigation, answer a question,
or tell it to stop further investigation and report its current findings.

This sends a prompt to the existing Kilo session; it does not create a new one.
`,
        args: {
          runId: tool.schema
            .string()
            .optional()
            .describe("Workflow run ID. Defaults to the latest run."),
          worker: tool.schema
            .enum(WORKER_ORDER)
            .describe("Worker: tests, code-review, or readability."),
          message: tool.schema
            .string()
            .trim()
            .min(1)
            .max(8_000)
            .describe("Instruction to send to the worker."),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          return withLockedRun(
            projectRoot,
            args.runId,
            context.abort,
            async (run) => {
              const worker = run.workers[args.worker];

              if (!worker.agentName) {
                throw new Error(`${args.worker} has no active agent.`);
              }

              if (worker.result) {
                throw new Error(
                  `${args.worker} has already completed. Use workflow_retry to start a new attempt.`,
                );
              }

              if (worker.state === "stopped") {
                throw new Error(
                  `${args.worker} is stopped. Use workflow_retry to start it again.`,
                );
              }

              worker.pendingPromptStartSeq = await promptWorker(
                worker.agentName,
                args.message,
                projectRoot,
                context.abort,
              );

              worker.state = "working";
              worker.lastError = undefined;
              await updateRun(projectRoot, run);
              supervisor.supervise(run.id);

              return `Instruction sent to ${args.worker} (${worker.agentName}).`;
            },
          );
        },
      }),

      workflow_stop: tool({
        description: `
Terminate one workflow worker.

Use this when the user explicitly wants a worker stopped or killed.
The worker's Herdr tab is closed, terminating its Kilo session.

Use workflow_send instead when you want the worker to stop investigating
but still return its current findings.
`,
        args: {
          runId: tool.schema
            .string()
            .optional()
            .describe("Workflow run ID. Defaults to the latest run."),
          worker: tool.schema
            .enum(WORKER_ORDER)
            .describe("Worker: tests, code-review, or readability."),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          return withLockedRun(
            projectRoot,
            args.runId,
            context.abort,
            async (run) => {
              const worker = run.workers[args.worker];
              supervisor.cancelWorker(run.id, args.worker);

              if (worker.tabId) {
                await closeWorker(
                  run,
                  worker,
                  projectRoot,
                  context.abort,
                );
              }

              worker.state = "stopped";
              worker.tabId = undefined;
              worker.paneId = undefined;
              worker.pendingPromptStartSeq = undefined;
              worker.lastError = undefined;
              await updateRun(projectRoot, run);

              return `${args.worker} stopped.`;
            },
          );
        },
      }),

      workflow_retry: tool({
        description: `
Restart a failed, stuck, stopped, or unsatisfactory workflow worker.

The existing worker tab is closed if it still exists, then a fresh Herdr tab
and fresh Kilo Code session are created with the worker's original objective.
`,
        args: {
          runId: tool.schema
            .string()
            .optional()
            .describe("Workflow run ID. Defaults to the latest run."),
          worker: tool.schema
            .enum(WORKER_ORDER)
            .describe("Worker: tests, code-review, or readability."),
          additionalInstruction: tool.schema
            .string()
            .trim()
            .min(1)
            .max(8_000)
            .optional()
            .describe("Optional extra guidance for this retry attempt."),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          return withLockedRun(
            projectRoot,
            args.runId,
            context.abort,
            async (run) => {
              const existing = run.workers[args.worker];
              supervisor.cancelWorker(run.id, args.worker);

              if (existing.tabId) {
                await closeWorker(
                  run,
                  existing,
                  projectRoot,
                  context.abort,
                );
              }

              const nextAttempt = existing.attempt + 1;

              try {
                run.workers[args.worker] = await spawnWorker({
                  run,
                  projectRoot,
                  kind: args.worker,
                  attempt: nextAttempt,
                  signal: context.abort,
                  additionalInstruction: args.additionalInstruction,
                });
              } catch (error) {
                   run.workers[args.worker] = workerErrorRecord(
                     args.worker,
                     nextAttempt,
                     error,
                     existing.definition,
                   );
              }

              try {
                await updateRun(projectRoot, run);
              } catch (saveError) {
                try {
                  await closeWorker(
                    run,
                    run.workers[args.worker],
                    projectRoot,
                  );
                } catch (cleanupError) {
                  throw new AggregateError(
                    [saveError, cleanupError],
                    "The replacement worker could not be saved or cleaned up.",
                  );
                }

                throw saveError;
              }

              supervisor.supervise(run.id);

              return JSON.stringify(
                {
                  runId: run.id,
                  worker: run.workers[args.worker],
                  state: run.state,
                },
                null,
                2,
              );
            },
          );
        },
      }),
    },
  };
};

export default {
  id: "engineering-workflow",
  server: workflowPlugin,
};

async function launchWorkers(
  run: WorkflowRun,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  // Worker launches run concurrently, but their state updates write in order.
  let saveQueue = Promise.resolve();
  const queueSave = () => {
    saveQueue = saveQueue.then(() => saveRun(projectRoot, run));
    return saveQueue;
  };

  const launches = await Promise.allSettled(
    WORKER_ORDER.map(async (kind) => {
      try {
        run.workers[kind] = await spawnWorker({
          run,
          projectRoot,
          kind,
          attempt: 1,
          signal,
        });
      } catch (error) {
        run.workers[kind] = workerErrorRecord(
          kind,
          1,
          error,
          run.workers[kind].definition,
        );
      }

      refreshRunState(run);
      await queueSave();
    }),
  );

  const saveFailure = launches.find(
    (result): result is PromiseRejectedResult =>
      result.status === "rejected",
  );

  if (saveFailure) {
    const cleanup = await Promise.allSettled(
      WORKER_ORDER.map((kind) =>
        closeWorker(run, run.workers[kind], projectRoot),
      ),
    );
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected",
    );

    if (cleanupFailure) {
      throw new AggregateError(
        [saveFailure.reason, cleanupFailure.reason],
        "Workflow state could not be saved, and worker cleanup also failed.",
      );
    }

    throw saveFailure.reason;
  }
}

async function updateRun(
  projectRoot: string,
  run: WorkflowRun,
): Promise<void> {
  refreshRunState(run);
  await saveRun(projectRoot, run);
}
