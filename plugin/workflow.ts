import * as path from "node:path";

import type { Plugin } from "@kilocode/plugin";
import { tool } from "@kilocode/plugin/tool";

import { isWorkerKind, WORKER_ORDER } from "../core/model.ts";
import type { OriginMetadata } from "../core/model.ts";
import type { ProjectContext } from "../core/workflow-contracts.ts";
import { requireHerdrWorkspace } from "../core/worker-service.ts";
import { HerdrCoordinatorNotifier } from "../core/coordinator-notifier.ts";
import { WorkflowService } from "../core/workflow-service.ts";

const workflowPlugin: Plugin = async ({ directory, worktree }) => {
  const workflowRole = process.env.WORKFLOW_ROLE;

  // Review workers must not expose tools that can create more workers.
  if (isWorkerKind(workflowRole) && process.env.WORKFLOW_RUN_ID) {
    return {};
  }

  const projectRoot = path.resolve(worktree || directory);
  const paneHint = captureKiloPaneHint();
  const service = new WorkflowService({
    notifier: new HerdrCoordinatorNotifier(),
  });

  return {
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await service.recover({
          context: createProjectContext(projectRoot, paneHint, {
            sessionID: event.properties.sessionID,
            abort: new AbortController().signal,
          }),
        });
      }
    },

    dispose: () => service.dispose(),

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
          return json(
            await service.start({
              context: createProjectContext(projectRoot, paneHint, context),
              task: args.task,
              taskCardPath: args.taskCardPath,
              workerAgents: args.workerAgents,
            }),
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
          return json(
            await service.status({
              context: createProjectContext(projectRoot, paneHint, context),
              runId: args.runId,
              worker: args.worker,
              includeOutput: args.includeOutput,
            }),
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
          const result = await service.send({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
            message: args.message,
          });
          return result.message;
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
          const result = await service.stop({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
          });
          return result.message;
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
          const result = await service.retry({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
            additionalInstruction: args.additionalInstruction,
          });
          return json({
            runId: result.runId,
            worker: result.workerRecord,
            state: result.state,
          });
        },
      }),
    },
  };
};

export default {
  id: "engineering-workflow",
  server: workflowPlugin,
};

function createProjectContext(
  projectRoot: string,
  paneHint: KiloPaneHint,
  hostContext: {
    sessionID: string;
    abort: AbortSignal;
  },
): ProjectContext {
  const trustedOrigin = resolveKiloOrigin(paneHint);
  return {
    projectRoot,
    origin: {
      ...trustedOrigin,
      sessionId: hostContext.sessionID,
    },
    signal: hostContext.abort,
    hostSession: { sessionId: hostContext.sessionID },
  };
}

interface KiloPaneHint {
  // Captured when the host loads the adapter so later environment changes
  // cannot redirect an operation to another Herdr pane.
  readonly paneId?: string;
}

function captureKiloPaneHint(): KiloPaneHint {
  return {
    paneId: process.env.HERDR_PANE_ID?.trim(),
  };
}

function resolveKiloOrigin(
  paneHint: KiloPaneHint,
): Omit<OriginMetadata, "sessionId"> {
  const paneId = paneHint.paneId;
  if (!paneId) {
    throw new Error(
      "The engineering workflow requires HERDR_PANE_ID from the current Herdr pane.",
    );
  }

  return {
    workspaceId: requireHerdrWorkspace(),
    paneId,
    coordinatorKind: "kilo",
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
