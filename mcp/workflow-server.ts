import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

import { HerdrCoordinatorNotifier } from "../core/coordinator-notifier.ts";
import { isWorkerKind } from "../core/model.ts";
import { resolveMcpProjectContext } from "../core/mcp-project-context.ts";
import type { ProjectContext, WorkflowRetryResult } from "../core/workflow-contracts.ts";
import { WorkflowService as DefaultWorkflowService } from "../core/workflow-service.ts";
import {
  WORKFLOW_TOOL_DESCRIPTORS,
  type WorkflowToolName,
} from "../core/workflow-tool-descriptors.ts";

export interface WorkflowMcpService {
  start(input: {
    context: ProjectContext;
    task: string;
    taskCardPath?: string;
    workerAgents?: Record<string, "kilo" | "claude" | "codex">;
  }): Promise<unknown>;
  status(input: {
    context: ProjectContext;
    runId?: string;
    worker?: "tests" | "code-review" | "readability";
    includeOutput?: boolean;
  }): Promise<unknown>;
  send(input: {
    context: ProjectContext;
    runId?: string;
    worker: "tests" | "code-review" | "readability";
    message: string;
  }): Promise<unknown>;
  stop(input: {
    context: ProjectContext;
    runId?: string;
    worker: "tests" | "code-review" | "readability";
  }): Promise<unknown>;
  retry(input: {
    context: ProjectContext;
    runId?: string;
    worker: "tests" | "code-review" | "readability";
    additionalInstruction?: string;
  }): Promise<WorkflowRetryResult>;
  recover(input: { context: ProjectContext }): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface WorkflowMcpServerOptions {
  context: ProjectContext;
  service: WorkflowMcpService;
  exposeTools?: boolean;
}

export interface StartedWorkflowMcpServer {
  server: McpServer;
  service: WorkflowMcpService;
  context: ProjectContext;
  close(): Promise<void>;
}

export interface WorkflowMcpRuntimeOptions extends WorkflowMcpServerOptions {
  stdin?: Readable;
  stdout?: Writable;
}

const workerSchema = z.enum(["tests", "code-review", "readability"]);
const agentSchema = z.enum(["kilo", "claude", "codex"]);
const runIdSchema = z.string().optional();

/** Create the MCP adapter without resolving model-supplied filesystem input. */
export function createWorkflowMcpServer(
  options: WorkflowMcpServerOptions,
): StartedWorkflowMcpServer {
  const server = new McpServer(
    { name: "kilo-herdr-engineering-workflow", version: "0.1.0" },
    {
      instructions:
        "Use these tools to coordinate the project's parallel engineering verification workflow.",
    },
  );

  if (options.exposeTools !== false) {
    registerTools(server, options.service, options.context);
  }

  let serviceDisposePromise: Promise<void> | undefined;
  const disposeService = (): Promise<void> => {
    serviceDisposePromise ??= options.service.dispose();
    return serviceDisposePromise;
  };
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    void disposeService().catch((error) => logDiagnostic(error));
  };

  return {
    server,
    service: options.service,
    context: options.context,
    close: async () => {
      await server.close();
      await disposeService();
    },
  };
}

/** Recover the active origin and connect the adapter to a stdio transport. */
export async function connectWorkflowMcpServer(
  options: WorkflowMcpRuntimeOptions,
): Promise<StartedWorkflowMcpServer> {
  let started: StartedWorkflowMcpServer | undefined;
  try {
    await options.service.recover({ context: options.context });
    started = createWorkflowMcpServer(options);
    await started.server.connect(
      new StdioServerTransport(options.stdin, options.stdout),
    );
    return started;
  } catch (error) {
    try {
      if (started) {
        await started.close();
      } else {
        await options.service.dispose();
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "MCP startup failed and service cleanup also failed.",
      );
    }
    throw error;
  }
}

/** Resolve trusted host state, recover same-origin runs, and start stdio MCP. */
export async function startWorkflowMcpServer(): Promise<void> {
  if (isWorkerProcess()) {
    const server = new McpServer({
      name: "kilo-herdr-engineering-workflow",
      version: "0.1.0",
    });
    await server.connect(new StdioServerTransport());
    return;
  }

  const hostAbort = new AbortController();
  let started: StartedWorkflowMcpServer | undefined;
  const abortHost = () => {
    hostAbort.abort(new Error("MCP host closed."));
    void started?.close();
  };
  process.once("SIGINT", abortHost);
  process.once("SIGTERM", abortHost);

  try {
    const context = await resolveMcpProjectContext({ signal: hostAbort.signal });
    const service = new DefaultWorkflowService({
      notifier: new HerdrCoordinatorNotifier(),
    });
    started = await connectWorkflowMcpServer({ service, context });
  } catch (error) {
    logDiagnostic(error);
    throw error;
  } finally {
    process.removeListener("SIGINT", abortHost);
    process.removeListener("SIGTERM", abortHost);
  }
}

export function workflowToolNames(): WorkflowToolName[] {
  return Object.keys(WORKFLOW_TOOL_DESCRIPTORS) as WorkflowToolName[];
}

function registerTools(
  server: McpServer,
  service: WorkflowMcpService,
  hostContext: ProjectContext,
): void {
  server.registerTool("workflow_start", {
    description: WORKFLOW_TOOL_DESCRIPTORS.workflow_start.description,
    inputSchema: z.object({
      task: z.string().trim().min(1).max(8_000).describe(
        "Task identifier or short description being reviewed.",
      ),
      taskCardPath: z.string().max(500).optional().describe(
        "Optional project-relative path to the Task Card being implemented.",
      ),
      workerAgents: z.object({
        tests: agentSchema.optional(),
        "code-review": agentSchema.optional(),
        readability: agentSchema.optional(),
      }).strict().optional().describe(
        "Optional per-role agent selection. Omitted roles default to Kilo.",
      ),
    }).strict(),
  }, async (args, extra) => resultContent(await service.start({
    context: contextForRequest(hostContext, extra.signal),
    task: args.task,
    taskCardPath: args.taskCardPath,
    workerAgents: args.workerAgents,
  })));

  server.registerTool("workflow_status", {
    description: WORKFLOW_TOOL_DESCRIPTORS.workflow_status.description,
    inputSchema: z.object({
      runId: runIdSchema.describe("Workflow run ID. Defaults to the latest run."),
      worker: workerSchema.optional().describe(
        "Optional worker: tests, code-review, or readability.",
      ),
      includeOutput: z.boolean().optional().describe(
        "Include recent terminal output. Defaults to true for a specifically requested worker and completed/blocked workers.",
      ),
    }).strict(),
  }, async (args, extra) => resultContent(await service.status({
    context: contextForRequest(hostContext, extra.signal),
    runId: args.runId,
    worker: args.worker,
    includeOutput: args.includeOutput,
  })));

  server.registerTool("workflow_send", {
    description: WORKFLOW_TOOL_DESCRIPTORS.workflow_send.description,
    inputSchema: z.object({
      runId: runIdSchema.describe("Workflow run ID. Defaults to the latest run."),
      worker: workerSchema.describe("Worker: tests, code-review, or readability."),
      message: z.string().trim().min(1).max(8_000).describe(
        "Instruction to send to the worker.",
      ),
    }).strict(),
  }, async (args, extra) => resultContent(await service.send({
    context: contextForRequest(hostContext, extra.signal),
    runId: args.runId,
    worker: args.worker,
    message: args.message,
  })));

  server.registerTool("workflow_stop", {
    description: WORKFLOW_TOOL_DESCRIPTORS.workflow_stop.description,
    inputSchema: z.object({
      runId: runIdSchema.describe("Workflow run ID. Defaults to the latest run."),
      worker: workerSchema.describe("Worker: tests, code-review, or readability."),
    }).strict(),
  }, async (args, extra) => resultContent(await service.stop({
    context: contextForRequest(hostContext, extra.signal),
    runId: args.runId,
    worker: args.worker,
  })));

  server.registerTool("workflow_retry", {
    description: WORKFLOW_TOOL_DESCRIPTORS.workflow_retry.description,
    inputSchema: z.object({
      runId: runIdSchema.describe("Workflow run ID. Defaults to the latest run."),
      worker: workerSchema.describe("Worker: tests, code-review, or readability."),
      additionalInstruction: z.string().trim().min(1).max(8_000).optional().describe(
        "Optional extra guidance for this retry attempt.",
      ),
    }).strict(),
  }, async (args, extra) => resultContent(await service.retry({
    context: contextForRequest(hostContext, extra.signal),
    runId: args.runId,
    worker: args.worker,
    additionalInstruction: args.additionalInstruction,
  })));
}

function contextForRequest(
  hostContext: ProjectContext,
  signal: AbortSignal,
): ProjectContext {
  return { ...hostContext, signal };
}

function resultContent(value: unknown) {
  if (!isJsonSerializable(value)) {
    throw new Error("Workflow service returned a non-serializable result.");
  }

  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function isWorkerProcess(): boolean {
  return isWorkerKind(process.env.WORKFLOW_ROLE);
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

function logDiagnostic(error: unknown): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[engineering-workflow-mcp] ${message}`);
}
