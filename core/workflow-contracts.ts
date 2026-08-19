import * as path from "node:path";

import {
  isJsonValue,
  isOriginMetadata,
} from "./model.ts";
import type {
  AgentKind,
  JsonValue,
  OriginMetadata,
  RoleId,
  RunState,
  WorkerKind,
  WorkerSummary,
  WorkflowNotification,
} from "./model.ts";

export interface HostSessionMetadata {
  sessionId?: string;
}

/** Trusted host state supplied by an adapter, never by workflow tool arguments. */
export interface ProjectContext {
  projectRoot: string;
  origin: OriginMetadata;
  signal: AbortSignal;
  hostSession?: HostSessionMetadata;
}

export interface CoordinatorNotificationBatch {
  projectRoot: string;
  origin: OriginMetadata;
  notifications: readonly Pick<WorkflowNotification, "sequence" | "message">[];
}

export interface CoordinatorNotifier {
  notify(
    batch: CoordinatorNotificationBatch,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WorkflowStartInput {
  context: ProjectContext;
  task: string;
  taskCardPath?: string;
  workerAgents?: Partial<Record<WorkerKind, AgentKind>>;
}

export interface WorkflowStatusInput {
  context: ProjectContext;
  runId?: string;
  worker?: WorkerKind;
  includeOutput?: boolean;
}

export interface WorkflowSendInput {
  context: ProjectContext;
  runId?: string;
  worker: WorkerKind;
  message: string;
}

export interface WorkflowStopInput {
  context: ProjectContext;
  runId?: string;
  worker: WorkerKind;
}

export interface WorkflowRetryInput {
  context: ProjectContext;
  runId?: string;
  worker: WorkerKind;
  additionalInstruction?: string;
}

export interface WorkflowRecoveryInput {
  context: ProjectContext;
}

export interface WorkflowStartResult {
  runId: string;
  state: RunState;
  workers: Record<RoleId, WorkerSummary>;
}

export interface WorkflowWorkerStatus extends WorkerSummary {
  kind: RoleId;
  output?: string;
}

export interface WorkflowStatusResult {
  runId: string;
  task: string;
  state: RunState;
  workers: WorkflowWorkerStatus[];
  notifications: WorkflowNotification[];
}

export interface WorkflowMutationResult {
  runId: string;
  worker: RoleId;
  state: RunState;
  message: string;
}

export interface WorkflowRetryResult extends WorkflowMutationResult {
  workerResult: WorkerSummary;
}

export interface WorkflowRecoveryResult {
  runIds: string[];
}

export type WorkflowOperation =
  | "start"
  | "status"
  | "send"
  | "stop"
  | "retry"
  | "recovery";

/**
 * Explicit status reads may inspect a known run from another origin in the
 * same project. Every mutation and recovery operation remains origin-owned.
 */
export function assertWorkflowOriginAccess(
  operation: WorkflowOperation,
  context: ProjectContext,
  runOrigin?: OriginMetadata,
  explicitRunId?: string,
): void {
  assertProjectContext(context);

  if (operation === "start") {
    return;
  }

  if (!runOrigin) {
    throw new Error("Workflow run origin is required for this operation.");
  }

  if (operation === "status" && explicitRunId?.trim()) {
    return;
  }

  if (!sameOrigin(context.origin, runOrigin)) {
    throw new Error(
      `Refusing ${operation}: the current coordinator is not the workflow origin pane.`,
    );
  }
}

export function assertProjectContext(
  context: ProjectContext,
): asserts context is ProjectContext {
  if (
    !context ||
    typeof context !== "object" ||
    !path.isAbsolute(context.projectRoot) ||
    context.projectRoot !== path.resolve(context.projectRoot) ||
    /[\u0000-\u001f\u007f]/.test(context.projectRoot)
  ) {
    throw new Error("Workflow project root must be an absolute canonical path.");
  }

  if (!isOriginMetadata(context.origin)) {
    throw new Error("Workflow context is missing a valid Herdr origin.");
  }

  if (!isAbortSignal(context.signal)) {
    throw new Error("Workflow context is missing a valid abort signal.");
  }

  if (
    context.hostSession?.sessionId !== undefined &&
    context.hostSession.sessionId !== context.origin.sessionId
  ) {
    throw new Error(
      "Workflow context host session metadata conflicts with its origin.",
    );
  }
}

export function sameOrigin(
  left: OriginMetadata,
  right: OriginMetadata,
): boolean {
  return (
    left.workspaceId === right.workspaceId &&
    left.paneId === right.paneId &&
    left.coordinatorKind === right.coordinatorKind &&
    left.sessionId === right.sessionId
  );
}

export { isJsonValue };

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    isRecord(value) &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
