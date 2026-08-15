export const WORKER_ORDER = [
  "tests",
  "code-review",
  "readability",
] as const;

export type WorkerKind = (typeof WORKER_ORDER)[number];

export const WORKER_STATES = [
  "launching",
  "working",
  "blocked",
  "done",
  "idle",
  "unknown",
  "stopped",
  "error",
] as const;

export type WorkerState = (typeof WORKER_STATES)[number];

export const RUN_STATES = [
  "launching",
  "reviewing",
  "blocked",
  "reviews-complete",
  "error",
  "stopped",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export const WORKFLOW_NOTIFICATION_KINDS = [
  "worker-blocked",
  "worker-error",
  "reviews-complete",
] as const;

export type WorkflowNotificationKind =
  (typeof WORKFLOW_NOTIFICATION_KINDS)[number];

export interface WorkerResult {
  output: string;
  capturedAt: string;
}

export interface WorkflowNotification {
  sequence: number;
  key: string;
  kind: WorkflowNotificationKind;
  message: string;
  createdAt: string;
  deliveredAt?: string;
}

export interface WorkerRecord {
  kind: WorkerKind;
  attempt: number;
  agentName?: string;
  tabId?: string;
  paneId?: string;
  pendingPromptStartSeq?: number;
  stateChangeSeq?: number;
  state: WorkerState;
  lastError?: string;
  result?: WorkerResult;
  closedAt?: string;
  cleanupError?: string;
}

export interface WorkflowRun {
  version: 1;
  id: string;
  task: string;
  taskCardPath?: string;
  originSessionId?: string;
  herdrWorkspaceId: string;
  createdAt: string;
  updatedAt: string;
  state: RunState;
  workers: Record<WorkerKind, WorkerRecord>;
  nextNotificationSequence?: number;
  notifications?: WorkflowNotification[];
}

const WORKER_AGENT_SUFFIX: Record<WorkerKind, string> = {
  tests: "tests",
  "code-review": "review",
  readability: "readable",
};

export interface WorkerSummary {
  state: WorkerState;
  attempt: number;
  agentName?: string;
  tabId?: string;
  paneId?: string;
  error?: string;
  capturedAt?: string;
  closedAt?: string;
  cleanupError?: string;
}

export function isWorkerKind(value: unknown): value is WorkerKind {
  return WORKER_ORDER.some((kind) => kind === value);
}

export function isWorkerState(value: unknown): value is WorkerState {
  return WORKER_STATES.some((state) => state === value);
}

export function isRunState(value: unknown): value is RunState {
  return RUN_STATES.some((state) => state === value);
}

export function isWorkflowNotificationKind(
  value: unknown,
): value is WorkflowNotificationKind {
  return WORKFLOW_NOTIFICATION_KINDS.some((kind) => kind === value);
}

export function deriveRunState(run: WorkflowRun): RunState {
  const states = WORKER_ORDER.map((kind) => run.workers[kind].state);

  if (states.every((state) => state === "stopped")) {
    return "stopped";
  }

  if (states.some((state) => state === "error" || state === "unknown")) {
    return "error";
  }

  if (states.some((state) => state === "blocked")) {
    return "blocked";
  }

  if (
    states.every(
      (state) =>
        state === "done" ||
        state === "idle" ||
        state === "stopped",
    )
  ) {
    return "reviews-complete";
  }

  if (states.some((state) => state === "launching")) {
    return "launching";
  }

  return "reviewing";
}

export function refreshRunState(run: WorkflowRun): void {
  run.state = deriveRunState(run);
  run.updatedAt = new Date().toISOString();
}

export function enqueueWorkflowNotification(
  run: WorkflowRun,
  notification: {
    key: string;
    kind: WorkflowNotificationKind;
    message: string;
  },
): WorkflowNotification {
  const notifications = (run.notifications ??= []);
  const existing = notifications.find(
    (candidate) => candidate.key === notification.key,
  );

  if (existing) {
    return existing;
  }

  const sequence = Math.max(
    run.nextNotificationSequence ?? 1,
    (notifications.at(-1)?.sequence ?? 0) + 1,
  );
  const created: WorkflowNotification = {
    sequence,
    key: notification.key,
    kind: notification.kind,
    message: notification.message,
    createdAt: new Date().toISOString(),
  };

  notifications.push(created);
  run.nextNotificationSequence = sequence + 1;
  return created;
}

export function createAgentName(
  runId: string,
  kind: WorkerKind,
  attempt: number,
): string {
  const runPrefix = runId
    .replace(/^run-/, "")
    .replaceAll("-", "")
    .slice(0, runId.length === 12 ? 8 : 12);

  return `wf-${runPrefix}-${WORKER_AGENT_SUFFIX[kind]}-${attempt}`;
}

export function summarizeWorkers(
  run: WorkflowRun,
): Record<WorkerKind, WorkerSummary> {
  return Object.fromEntries(
    WORKER_ORDER.map((kind) => {
      const worker = run.workers[kind];

      return [
        kind,
        {
          state: worker.state,
          attempt: worker.attempt,
          agentName: worker.agentName,
          tabId: worker.tabId,
          paneId: worker.paneId,
          error: worker.lastError,
          capturedAt: worker.result?.capturedAt,
          closedAt: worker.closedAt,
          cleanupError: worker.cleanupError,
        },
      ];
    }),
  ) as Record<WorkerKind, WorkerSummary>;
}
