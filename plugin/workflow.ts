import type { Plugin } from "@kilocode/plugin";
import { tool } from "@kilocode/plugin/tool";

import {
  createReplacementWorker,
  isWorkerKind,
  refreshRunState,
  summarizeWorkers,
  WORKER_ORDER,
} from "../core/model.ts";
import type { WorkflowRun } from "../core/model.ts";
import type { ProjectContext } from "../core/workflow-contracts.ts";
import {
  createRun,
  normalizeTaskCardPath,
  saveNewRun,
  saveRun,
  withLockedRun,
  withRunLock,
} from "../core/run-store.ts";
import {
  closeWorker,
  inspectWorker,
  promptWorker,
  requireHerdrWorkspace,
  spawnWorker,
  workerErrorRecord,
} from "../core/worker-service.ts";
import { captureSourceCheckpoint } from "../core/source-checkpoint.ts";
import { HerdrCoordinatorNotifier } from "../core/coordinator-notifier.ts";
import { WorkflowSupervisor } from "../core/supervisor.ts";
import {
  preflightWorkerSelections,
  resolveWorkerAgents,
} from "../core/worker-profile.ts";

const workflowPlugin: Plugin = async ({ directory, worktree }) => {
  const workflowRole = process.env.WORKFLOW_ROLE;

  // Review workers should not expose tools that can create more workers.
  if (isWorkerKind(workflowRole) && process.env.WORKFLOW_RUN_ID) {
    return {};
  }

  const supervisor = new WorkflowSupervisor({
    notifier: new HerdrCoordinatorNotifier(),
    projectRoot: worktree || directory,
  });

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

This launches three independent worker sessions in new Herdr tabs. Kilo
remains the Phase 1 coordinator, and the trusted worker profiles cover Kilo,
Claude Code, and Codex. The optional workerAgents map selects an agent per
role; omitted roles default to Kilo:

- test verification
- code review
- human readability review

The plugin supervises them asynchronously and wakes the originating Kilo
session when coordinator action is required. Completed reports are persisted
before completed worker tabs are closed.

Review-only worker profiles use harness-native no-write modes for Claude Code
and Codex. Kilo review workers use prompt and source-checkpoint enforcement,
which is weaker and does not guarantee that files cannot be changed. Missing
worker executables or required Herdr integrations are installation
prerequisites and are never installed automatically.

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
          workerAgents: tool.schema
            .object({
              tests: tool.schema.enum(["kilo", "claude", "codex"]).optional(),
              "code-review": tool.schema
                .enum(["kilo", "claude", "codex"])
                .optional(),
              readability: tool.schema
                .enum(["kilo", "claude", "codex"])
                .optional(),
            })
            .strict()
            .optional()
            .describe(
              "Optional per-role agent selection. Omitted roles default to Kilo.",
            ),
        },
        async execute(args, context) {
          const projectRoot = context.worktree || context.directory;
          const workerAgents = resolveWorkerAgents(args.workerAgents);
          await preflightWorkerSelections(workerAgents, context.abort);
          const workspaceId = requireHerdrWorkspace();
          const paneId = process.env.HERDR_PANE_ID?.trim();
          if (!paneId) {
            throw new Error(
              "The engineering workflow requires HERDR_PANE_ID from the current Herdr pane.",
            );
          }
          const projectContext: ProjectContext = {
            projectRoot,
            origin: {
              workspaceId,
              paneId,
              coordinatorKind: "kilo",
              sessionId: context.sessionID,
            },
            signal: context.abort,
            hostSession: { sessionId: context.sessionID },
          };
          const sourceCheckpoint = await captureSourceCheckpoint(
            projectRoot,
            context.abort,
          );
          const run = createRun({
            task: args.task,
            context: projectContext,
            taskCardPath: await normalizeTaskCardPath(
              projectRoot,
              args.taskCardPath,
            ),
            workerAgents,
          });
          for (const kind of WORKER_ORDER) {
            run.workers[kind].sourceCheckpoint = sourceCheckpoint;
          }

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
                  if (status.error !== undefined) {
                    worker.lastError = status.error;
                  } else if (!worker.result) {
                    worker.lastError = undefined;
                  }
                  if (status.stateChangeSeq !== undefined) {
                    worker.stateChangeSeq = status.stateChangeSeq;
                  }

                  if (status.promptStarted) {
                    worker.pendingPromptStartSeq = undefined;
                  }

                  return {
                    ...summarizeWorkers(run)[kind],
                    kind,
                    error: status.error ?? worker.lastError,
                    output: status.output,
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
                  notifications: run.notifications ?? [],
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

This sends a prompt to the existing worker session, regardless of its harness;
it does not create a new one.
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
The worker's Herdr tab is closed, terminating its harness session.

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
and session for the worker's persisted agent kind are created with the
original objective and methodology snapshot.

A stale report is diagnostic evidence and never satisfies review completion.
Use workflow_retry to capture a fresh source checkpoint and rerun the affected
worker.
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
              const sourceCheckpoint = await captureSourceCheckpoint(
                projectRoot,
                context.abort,
              );
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
              const replacement = createReplacementWorker(
                existing,
                nextAttempt,
                sourceCheckpoint,
              );
              run.workers[args.worker] = replacement;

              try {
                run.workers[args.worker] = await spawnWorker({
                  run,
                  projectRoot,
                  kind: args.worker,
                  attempt: nextAttempt,
                  sourceCheckpoint,
                  signal: context.abort,
                  additionalInstruction: args.additionalInstruction,
                });
              } catch (error) {
                run.workers[args.worker] = workerErrorRecord(
                  args.worker,
                  nextAttempt,
                  error,
                  {
                    definition: replacement.definition,
                    sourceCheckpoint: replacement.sourceCheckpoint,
                    attemptHistory: replacement.attemptHistory,
                  },
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
          sourceCheckpoint: run.workers[kind].sourceCheckpoint,
          signal,
        });
      } catch (error) {
        run.workers[kind] = workerErrorRecord(
          kind,
          1,
          error,
          {
            definition: run.workers[kind].definition,
            sourceCheckpoint: run.workers[kind].sourceCheckpoint,
          },
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

  if (WORKER_ORDER.some((kind) => run.workers[kind].state === "error")) {
    const cleanup = await Promise.allSettled(
      WORKER_ORDER.filter((kind) => run.workers[kind].tabId).map(async (kind) => {
        const worker = run.workers[kind];
        await closeWorker(run, worker, projectRoot);
        worker.tabId = undefined;
        worker.paneId = undefined;
        worker.state = "stopped";
      }),
    );
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    if (cleanupFailure) {
      throw new AggregateError(
        [cleanupFailure.reason],
        "A worker launch failed, and cleanup also failed.",
      );
    }

    await saveRun(projectRoot, run);

    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Workflow operation was aborted.");
    }
  }
}

async function updateRun(
  projectRoot: string,
  run: WorkflowRun,
): Promise<void> {
  refreshRunState(run);
  await saveRun(projectRoot, run);
}
