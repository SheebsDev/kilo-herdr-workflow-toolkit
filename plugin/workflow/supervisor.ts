import type { PluginInput } from "@kilocode/plugin";

import {
  enqueueWorkflowNotification,
  refreshRunState,
  WORKER_ORDER,
} from "./model.ts";
import type {
  SourceCheckpoint,
  WorkerKind,
  WorkerRecord,
  WorkflowRun,
} from "./model.ts";
import {
  captureSourceCheckpoint,
  sourceCheckpointsEqual,
} from "./source-checkpoint.ts";
import {
  listRuns,
  loadRun,
  saveRun,
  withLockedRun,
} from "./run-store.ts";
import {
  closeWorker,
  errorMessage,
  inspectWorker,
  waitForWorkerState,
} from "./worker-service.ts";

const MAX_CAPTURED_OUTPUT_LENGTH = 256 * 1024;
const BLOCKED_CONFIRMATION_MS = 30_000;
const DELIVERY_RETRY_LIMIT = 5;
const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;

type KiloClient = PluginInput["client"];

interface WorkerWatch {
  controller: AbortController;
  promise: Promise<void>;
}

type ReconciledState =
  | "blocked"
  | "complete"
  | "error"
  | "stopped"
  | "working";

export class WorkflowSupervisor {
  private readonly client: KiloClient;
  private readonly projectRoot: string;
  private readonly watches = new Map<string, WorkerWatch>();
  private readonly preparations = new Map<string, Promise<void>>();
  private readonly deliveries = new Map<string, Promise<void>>();
  private readonly deliveryRetryCounts = new Map<string, number>();
  private readonly deliveryRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private disposed = false;

  constructor(client: KiloClient, projectRoot: string) {
    this.client = client;
    this.projectRoot = projectRoot;
  }

  supervise(runId: string): void {
    if (this.disposed || this.preparations.has(runId)) {
      return;
    }

    const preparation = this.prepareRun(runId).finally(() => {
      if (this.preparations.get(runId) === preparation) {
        this.preparations.delete(runId);
      }
    });

    this.preparations.set(runId, preparation);
    void preparation.catch(() => undefined);
  }

  async resumeForSession(sessionId: string): Promise<void> {
    if (this.disposed) {
      return;
    }

    const runs = await listRuns(this.projectRoot);

    for (const run of runs) {
      if (run.originSessionId !== sessionId) {
        continue;
      }

      this.supervise(run.id);
      void this.deliverPending(run.id).catch(() => undefined);
    }
  }

  cancelWorker(runId: string, kind: WorkerKind): void {
    const prefix = `${runId}:${kind}:`;

    for (const [key, watch] of this.watches) {
      if (key.startsWith(prefix)) {
        watch.controller.abort(new Error(`${kind} supervision was cancelled.`));
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    for (const watch of this.watches.values()) {
      watch.controller.abort(new Error("Workflow supervision is shutting down."));
    }

    for (const timer of this.deliveryRetryTimers.values()) {
      clearTimeout(timer);
    }

    this.deliveryRetryTimers.clear();

    await Promise.allSettled(
      [...this.watches.values()].map((watch) => watch.promise),
    );
  }

  private async prepareRun(runId: string): Promise<void> {
    const run = await loadRun(this.projectRoot, runId);

    for (const kind of WORKER_ORDER) {
      const worker = run.workers[kind];

      if (worker.result || worker.state === "stopped") {
        continue;
      }

      if (worker.state === "error" || !worker.agentName) {
        await this.queueWorkerError(runId, worker);
        continue;
      }

      this.scheduleWorker(runId, worker);
    }

    await this.queueReviewsComplete(runId);
    await this.deliverPending(runId);
  }

  private scheduleWorker(runId: string, worker: WorkerRecord): void {
    if (this.disposed || !worker.agentName) {
      return;
    }

    const key = watchKey(runId, worker.kind, worker.attempt);

    if (this.watches.has(key)) {
      return;
    }

    const controller = new AbortController();
    const promise = this.watchWorker(
      runId,
      worker.kind,
      worker.attempt,
      controller.signal,
    ).finally(() => {
      if (this.watches.get(key)?.promise === promise) {
        this.watches.delete(key);
      }
    });

    this.watches.set(key, {
      controller,
      promise,
    });
    void promise.catch(() => undefined);
  }

  private async watchWorker(
    runId: string,
    kind: WorkerKind,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !this.disposed) {
      const run = await loadRun(this.projectRoot, runId);
      const worker = run.workers[kind];

      if (
        worker.attempt !== attempt ||
        worker.result ||
        worker.state === "stopped" ||
        !worker.agentName
      ) {
        return;
      }

      const inspection = await inspectWorker({
        worker,
        projectRoot: this.projectRoot,
        includeOutput: false,
        signal,
      });
      const state = await this.applyInspection(
        runId,
        kind,
        attempt,
        inspection,
        signal,
      );

      if (state === "error") {
        await this.deliverPending(runId).catch(() => undefined);
        return;
      }

      if (state === "complete" || state === "stopped") {
        return;
      }

      try {
        if (state === "blocked") {
          await this.waitThroughBlockedState(
            runId,
            kind,
            attempt,
            worker.agentName,
            signal,
          );
        } else {
          const stateWait = waitForWorkerState(
            worker.agentName,
            ["blocked", "done", "idle", "unknown"],
            this.projectRoot,
            signal,
          );

          await this.deliverPending(runId).catch(() => undefined);
          await stateWait;
        }
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }

        await this.recordWaitFailure(runId, kind, attempt, error);
        await this.deliverPending(runId).catch(() => undefined);
        return;
      }
    }
  }

  private async applyInspection(
    runId: string,
    kind: WorkerKind,
    attempt: number,
    inspection: Awaited<ReturnType<typeof inspectWorker>>,
    signal: AbortSignal,
  ): Promise<ReconciledState> {
    const state = await withLockedRun(
      this.projectRoot,
      runId,
      signal,
      async (run) => {
        const worker = run.workers[kind];

        if (worker.attempt !== attempt || worker.state === "stopped") {
          return "stopped" as const;
        }

        if (worker.result) {
          return "complete" as const;
        }

        if (isWorkerInspectionStale(worker, inspection)) {
          return reconciledWorkerState(worker);
        }

        worker.state = inspection.state;
        worker.stateChangeSeq = inspection.stateChangeSeq;

        if (inspection.promptStarted) {
          worker.pendingPromptStartSeq = undefined;
        }

        if (inspection.state === "blocked") {
          worker.lastError = undefined;
          refreshRunState(run);
          await saveRun(this.projectRoot, run);
          return "blocked" as const;
        }

        if (inspection.state === "unknown" || inspection.state === "error") {
          worker.state = "error";
          worker.lastError =
            inspection.error ?? `${kind} entered an unknown Herdr state.`;
          enqueueWorkflowNotification(run, {
            key: workerNotificationKey(worker, "error"),
            kind: "worker-error",
            message: `${kind} attempt ${attempt} needs inspection: ${worker.lastError}`,
          });
          refreshRunState(run);
          await saveRun(this.projectRoot, run);
          return "error" as const;
        }

        if (inspection.state === "done" || inspection.state === "idle") {
          if (inspection.output === undefined || inspection.output.trim() === "") {
            worker.state = "error";
            worker.lastError = `Could not capture the completed ${kind} report.`;
            enqueueWorkflowNotification(run, {
              key: workerNotificationKey(worker, "error"),
              kind: "worker-error",
              message: `${kind} attempt ${attempt} completed, but its final report could not be captured. Its tab was left open.`,
            });
            refreshRunState(run);
            await saveRun(this.projectRoot, run);
            return "error" as const;
          }

          const baseline = worker.sourceCheckpoint;

          if (!baseline) {
            worker.state = "error";
            worker.lastError = `Could not validate the completed ${kind} report because its source checkpoint is missing.`;
            enqueueWorkflowNotification(run, {
              key: workerNotificationKey(worker, "error"),
              kind: "worker-error",
              message: `${kind} attempt ${attempt} completed, but its source checkpoint was missing. Its tab was left open.`,
            });
            refreshRunState(run);
            await saveRun(this.projectRoot, run);
            return "error" as const;
          }

          let current: SourceCheckpoint;

          try {
            current = await captureSourceCheckpoint(this.projectRoot, signal);
          } catch (error) {
            if (signal.aborted) {
              throw error;
            }

            worker.state = "error";
            worker.lastError = `Could not capture the current source checkpoint for the completed ${kind} report: ${errorMessage(error)}`;
            enqueueWorkflowNotification(run, {
              key: workerNotificationKey(worker, "error"),
              kind: "worker-error",
              message: `${kind} attempt ${attempt} completed, but its current source checkpoint could not be captured. Its tab was left open: ${worker.lastError}`,
            });
            refreshRunState(run);
            await saveRun(this.projectRoot, run);
            return "error" as const;
          }

          const output = boundCapturedOutput(inspection.output);

          if (!sourceCheckpointsEqual(baseline, current)) {
            const reason = describeCheckpointMismatch(kind, baseline, current);

            worker.state = "stale";
            worker.result = {
              output,
              capturedAt: new Date().toISOString(),
            };
            worker.staleDetails = {
              baseline,
              current,
              reason,
            };
            worker.lastError = reason;
            worker.cleanupError = undefined;
            enqueueWorkflowNotification(run, {
              key: workerNotificationKey(worker, "stale"),
              kind: "worker-stale",
              message: `${kind} attempt ${attempt} produced a stale report: ${reason}`,
            });
            refreshRunState(run);
            await saveRun(this.projectRoot, run);
            return "complete" as const;
          }

          worker.result = {
            output,
            capturedAt: new Date().toISOString(),
          };
          worker.lastError = undefined;
          worker.staleDetails = undefined;
          worker.cleanupError = undefined;
          refreshRunState(run);
          await saveRun(this.projectRoot, run);
          return "complete" as const;
        }

        worker.lastError = undefined;
        refreshRunState(run);
        await saveRun(this.projectRoot, run);
        return "working" as const;
      },
    );

    if (state !== "complete") {
      return state;
    }

    await this.cleanupCompletedWorker(runId, kind, attempt, signal);
    await this.queueReviewsComplete(runId);
    await this.deliverPending(runId);
    return "complete";
  }

  private async cleanupCompletedWorker(
    runId: string,
    kind: WorkerKind,
    attempt: number,
    signal: AbortSignal,
  ): Promise<void> {
    const run = await loadRun(this.projectRoot, runId);
    const worker = run.workers[kind];

    if (worker.attempt !== attempt || !worker.result || !worker.tabId) {
      return;
    }

    const tabId = worker.tabId;

    try {
      await closeWorker(run, worker, this.projectRoot, signal);
    } catch (error) {
      await withLockedRun(
        this.projectRoot,
        runId,
        signal,
        async (current) => {
          const currentWorker = current.workers[kind];

          if (currentWorker.attempt !== attempt || !currentWorker.result) {
            return;
          }

          currentWorker.cleanupError = errorMessage(error);
          enqueueWorkflowNotification(current, {
            key: workerNotificationKey(currentWorker, "cleanup-error"),
            kind: "worker-error",
            message: `${kind} attempt ${attempt} reported successfully, but its Herdr tab could not be closed: ${currentWorker.cleanupError}`,
          });
          refreshRunState(current);
          await saveRun(this.projectRoot, current);
        },
      );
      return;
    }

    await withLockedRun(
      this.projectRoot,
      runId,
      signal,
      async (current) => {
        const currentWorker = current.workers[kind];

        if (
          currentWorker.attempt !== attempt ||
          currentWorker.tabId !== tabId ||
          !currentWorker.result
        ) {
          return;
        }

        currentWorker.tabId = undefined;
        currentWorker.paneId = undefined;
        currentWorker.closedAt = new Date().toISOString();
        currentWorker.cleanupError = undefined;
        refreshRunState(current);
        await saveRun(this.projectRoot, current);
      },
    );
  }

  private async queueWorkerError(
    runId: string,
    snapshot: WorkerRecord,
  ): Promise<void> {
    await withLockedRun(
      this.projectRoot,
      runId,
      undefined,
      async (run) => {
        const worker = run.workers[snapshot.kind];

        if (worker.attempt !== snapshot.attempt || worker.state !== "error") {
          return;
        }

        enqueueWorkflowNotification(run, {
          key: workerNotificationKey(worker, "error"),
          kind: "worker-error",
          message: `${worker.kind} attempt ${worker.attempt} failed: ${worker.lastError ?? "unknown error"}`,
        });
        refreshRunState(run);
        await saveRun(this.projectRoot, run);
      },
    );
  }

  private async waitThroughBlockedState(
    runId: string,
    kind: WorkerKind,
    attempt: number,
    agentName: string,
    signal: AbortSignal,
  ): Promise<void> {
    const stateWait = waitForWorkerState(
      agentName,
      ["working", "done", "idle", "unknown"],
      this.projectRoot,
      signal,
    );
    const transitioned = await Promise.race([
      stateWait.then(() => true),
      abortableDelay(BLOCKED_CONFIRMATION_MS, signal).then(() => false),
    ]);

    if (transitioned) {
      return;
    }

    const run = await loadRun(this.projectRoot, runId);
    const worker = run.workers[kind];

    if (worker.attempt !== attempt || worker.result || !worker.agentName) {
      return;
    }

    const inspection = await inspectWorker({
      worker,
      projectRoot: this.projectRoot,
      includeOutput: false,
      signal,
    });

    if (inspection.state === "blocked") {
      await withLockedRun(
        this.projectRoot,
        runId,
        signal,
        async (current) => {
          const currentWorker = current.workers[kind];

          if (currentWorker.attempt !== attempt || currentWorker.result) {
            return;
          }

          if (isWorkerInspectionStale(currentWorker, inspection)) {
            return;
          }

          currentWorker.state = "blocked";
          currentWorker.stateChangeSeq = inspection.stateChangeSeq;
          enqueueWorkflowNotification(current, {
            key: workerNotificationKey(currentWorker, "blocked"),
            kind: "worker-blocked",
            message: `${kind} attempt ${attempt} remains blocked and requires coordinator attention.`,
          });
          refreshRunState(current);
          await saveRun(this.projectRoot, current);
        },
      );
      await this.deliverPending(runId).catch(() => undefined);
    }

    await stateWait;
  }

  private async recordWaitFailure(
    runId: string,
    kind: WorkerKind,
    attempt: number,
    error: unknown,
  ): Promise<void> {
    await withLockedRun(
      this.projectRoot,
      runId,
      undefined,
      async (run) => {
        const worker = run.workers[kind];

        if (worker.attempt !== attempt || worker.result) {
          return;
        }

        worker.state = "error";
        worker.lastError = `Herdr could not continue supervising ${kind}: ${errorMessage(error)}`;
        enqueueWorkflowNotification(run, {
          key: workerNotificationKey(worker, "error"),
          kind: "worker-error",
          message: `${kind} attempt ${attempt} supervision failed: ${worker.lastError}`,
        });
        refreshRunState(run);
        await saveRun(this.projectRoot, run);
      },
    );
  }

  private async queueReviewsComplete(runId: string): Promise<void> {
    await withLockedRun(
      this.projectRoot,
      runId,
      undefined,
      async (run) => {
        refreshRunState(run);

        const reportsCollected = WORKER_ORDER.every((kind) => {
          const worker = run.workers[kind];
          return (
            (Boolean(worker.result) &&
              worker.state !== "stale" &&
              worker.state !== "invalid-report") ||
            worker.state === "stopped"
          );
        });

        if (run.state === "reviews-complete" && reportsCollected) {
          enqueueWorkflowNotification(run, {
            key: `reviews-complete:${WORKER_ORDER.map(
              (kind) => run.workers[kind].attempt,
            ).join(":")}`,
            kind: "reviews-complete",
            message:
              "All active review workers have finished and their reports are ready.",
          });
        }

        await saveRun(this.projectRoot, run);
      },
    );
  }

  private deliverPending(runId: string): Promise<void> {
    const existing = this.deliveries.get(runId);

    if (existing) {
      return existing;
    }

    const delivery = this.performDeliveries(runId)
      .then(() => {
        this.deliveryRetryCounts.delete(runId);
        const timer = this.deliveryRetryTimers.get(runId);

        if (timer) {
          clearTimeout(timer);
          this.deliveryRetryTimers.delete(runId);
        }
      })
      .catch((error) => {
        this.scheduleDeliveryRetry(runId);
        throw error;
      })
      .finally(() => {
        if (this.deliveries.get(runId) === delivery) {
          this.deliveries.delete(runId);
        }
      });

    this.deliveries.set(runId, delivery);
    return delivery;
  }

  private async performDeliveries(runId: string): Promise<void> {
    while (!this.disposed) {
      const run = await loadRun(this.projectRoot, runId);
      const pending = (run.notifications ?? []).filter(
        (notification) => !notification.deliveredAt,
      );

      if (!run.originSessionId || pending.length === 0) {
        return;
      }

      await this.client.session.promptAsync({
        path: { id: run.originSessionId },
        query: { directory: this.projectRoot },
        body: {
          parts: [
            {
              type: "text",
              text: buildWakePrompt(run, pending.map(({ message }) => message)),
            },
          ],
        },
        throwOnError: true,
      });

      const deliveredSequences = new Set(
        pending.map((notification) => notification.sequence),
      );
      await withLockedRun(
        this.projectRoot,
        runId,
        undefined,
        async (current) => {
          const deliveredAt = new Date().toISOString();

          for (const notification of current.notifications ?? []) {
            if (
              deliveredSequences.has(notification.sequence) &&
              !notification.deliveredAt
            ) {
              notification.deliveredAt = deliveredAt;
            }
          }

          refreshRunState(current);
          await saveRun(this.projectRoot, current);
        },
      );
    }
  }

  private scheduleDeliveryRetry(runId: string): void {
    if (this.disposed || this.deliveryRetryTimers.has(runId)) {
      return;
    }

    const retryCount = (this.deliveryRetryCounts.get(runId) ?? 0) + 1;

    if (retryCount > DELIVERY_RETRY_LIMIT) {
      return;
    }

    this.deliveryRetryCounts.set(runId, retryCount);
    const delay = Math.min(
      DELIVERY_RETRY_MAX_MS,
      DELIVERY_RETRY_BASE_MS * 2 ** (retryCount - 1),
    );
    const timer = setTimeout(() => {
      if (this.deliveryRetryTimers.get(runId) === timer) {
        this.deliveryRetryTimers.delete(runId);
      }

      void this.deliverPending(runId).catch(() => undefined);
    }, delay);

    timer.unref();
    this.deliveryRetryTimers.set(runId, timer);
  }
}

function watchKey(runId: string, kind: WorkerKind, attempt: number): string {
  return `${runId}:${kind}:${attempt}`;
}

export function isWorkerInspectionStale(
  worker: WorkerRecord,
  inspection: { stateChangeSeq?: number },
): boolean {
  const observedSequence = inspection.stateChangeSeq;

  if (
    worker.pendingPromptStartSeq !== undefined &&
    (observedSequence === undefined ||
      observedSequence < worker.pendingPromptStartSeq)
  ) {
    return true;
  }

  return (
    observedSequence !== undefined &&
    worker.stateChangeSeq !== undefined &&
    observedSequence < worker.stateChangeSeq
  );
}

function reconciledWorkerState(worker: WorkerRecord): ReconciledState {
  if (worker.result) {
    return "complete";
  }

  if (worker.state === "stopped") {
    return "stopped";
  }

  if (worker.state === "error" || worker.state === "unknown") {
    return "error";
  }

  return worker.state === "blocked" ? "blocked" : "working";
}

function workerNotificationKey(worker: WorkerRecord, event: string): string {
  return [
    worker.kind,
    worker.attempt,
    event,
    worker.stateChangeSeq ?? "no-sequence",
  ].join(":");
}

function boundCapturedOutput(output: string): string {
  if (output.length <= MAX_CAPTURED_OUTPUT_LENGTH) {
    return output;
  }

  const marker = "[Earlier terminal output was truncated before persistence.]\n";
  return marker + output.slice(-(MAX_CAPTURED_OUTPUT_LENGTH - marker.length));
}

function describeCheckpointMismatch(
  kind: WorkerKind,
  baseline: SourceCheckpoint,
  current: SourceCheckpoint,
): string {
  const changed: string[] = [];

  if (baseline.headId !== current.headId) {
    changed.push("HEAD");
  }
  if (baseline.stagedDiffSha256 !== current.stagedDiffSha256) {
    changed.push("staged tracked diff");
  }
  if (
    baseline.unstagedTrackedDiffSha256 !== current.unstagedTrackedDiffSha256
  ) {
    changed.push("unstaged tracked diff");
  }

  return `Tracked source changed during ${kind} attempt; changed checkpoint fields: ${changed.join(", ") || "unknown"}.`;
}

function buildWakePrompt(run: WorkflowRun, messages: string[]): string {
  return [
    `ENGINEERING WORKFLOW WAKE: ${run.id}`,
    "",
    ...messages.map((message) => `- ${message}`),
    "",
    `Call workflow_status with runId \"${run.id}\" to collect the durable reports and current state.`,
    "Continue coordinating automatically: evaluate findings, fix accepted blocking issues, retry only affected workers, and report the final result to the user.",
  ].join("\n");
}

async function abortableDelay(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Workflow supervision was aborted.");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Workflow supervision was aborted."),
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
