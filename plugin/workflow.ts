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
        await service.resumeForSession(projectRoot, event.properties.sessionID);
      }
    },

    dispose: () => service.dispose(),

    tool: {
      workflow_start: tool({
        description:
          "Start the parallel engineering verification workflow after reaching a stable implementation checkpoint.",
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
            .describe("Optional project-relative Task Card path."),
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
            .describe("Optional per-role worker harness selection."),
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
        description:
          "Inspect and reconcile a workflow run once without claiming supervision or delivering wakes.",
        args: {
          runId: tool.schema.string().optional(),
          worker: tool.schema.enum(WORKER_ORDER).optional(),
          includeOutput: tool.schema.boolean().optional(),
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
        description: "Send an instruction to a validated current workflow worker attempt.",
        args: {
          runId: tool.schema.string().optional(),
          worker: tool.schema.enum(WORKER_ORDER),
          message: tool.schema.string().trim().min(1).max(8_000),
        },
        async execute(args, context) {
          return json(
            await service.send({
              context: createProjectContext(projectRoot, paneHint, context),
              runId: args.runId,
              worker: args.worker,
              message: args.message,
            }),
          );
        },
      }),

      workflow_stop: tool({
        description: "Stop a validated current workflow worker attempt and persist its state.",
        args: {
          runId: tool.schema.string().optional(),
          worker: tool.schema.enum(WORKER_ORDER),
        },
        async execute(args, context) {
          return json(
            await service.stop({
              context: createProjectContext(projectRoot, paneHint, context),
              runId: args.runId,
              worker: args.worker,
            }),
          );
        },
      }),

      workflow_retry: tool({
        description:
          "Restart a failed, stuck, stopped, or unsatisfactory workflow worker with a fresh checkpoint.",
        args: {
          runId: tool.schema.string().optional(),
          worker: tool.schema.enum(WORKER_ORDER),
          additionalInstruction: tool.schema
            .string()
            .trim()
            .min(1)
            .max(8_000)
            .optional(),
        },
        async execute(args, context) {
          return json(
            await service.retry({
              context: createProjectContext(projectRoot, paneHint, context),
              runId: args.runId,
              worker: args.worker,
              additionalInstruction: args.additionalInstruction,
            }),
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
