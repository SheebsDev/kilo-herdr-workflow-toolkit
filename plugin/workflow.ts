import * as path from "node:path";

import type { Plugin } from "@kilocode/plugin";
import { tool } from "@kilocode/plugin/tool";

import { isWorkerKind, WORKER_ORDER } from "../core/model.ts";
import type { OriginMetadata } from "../core/model.ts";
import type { ProjectContext } from "../core/workflow-contracts.ts";
import { requireHerdrWorkspace } from "../core/worker-service.ts";
import { HerdrCoordinatorNotifier } from "../core/coordinator-notifier.ts";
import { WorkflowService } from "../core/workflow-service.ts";
import { WORKFLOW_TOOL_DESCRIPTORS } from "../core/workflow-tool-descriptors.ts";

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
        description: WORKFLOW_TOOL_DESCRIPTORS.workflow_start.description,
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
        description: WORKFLOW_TOOL_DESCRIPTORS.workflow_status.description,
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
        description: WORKFLOW_TOOL_DESCRIPTORS.workflow_send.description,
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
          return json(await service.send({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
            message: args.message,
          }));
        },
      }),

      workflow_stop: tool({
        description: WORKFLOW_TOOL_DESCRIPTORS.workflow_stop.description,
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
          return json(await service.stop({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
          }));
        },
      }),

      workflow_retry: tool({
        description: WORKFLOW_TOOL_DESCRIPTORS.workflow_retry.description,
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
          return json(await service.retry({
            context: createProjectContext(projectRoot, paneHint, context),
            runId: args.runId,
            worker: args.worker,
            additionalInstruction: args.additionalInstruction,
          }));
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
