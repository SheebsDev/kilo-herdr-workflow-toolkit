import {
  archiveWorkerAttempt,
  createReplacementWorker,
  refreshRunState,
  summarizeWorkers,
  WORKER_ORDER,
} from "./model.ts";
import type {
  WorkerKind,
  WorkerRecord,
  WorkflowRun,
} from "./model.ts";
import {
  assertWorkflowOriginAccess,
  assertProjectContext,
} from "./workflow-contracts.ts";
import type {
  ProjectContext,
  WorkflowRetryInput,
  WorkflowRetryResult,
  WorkflowSendInput,
  WorkflowStartInput,
  WorkflowStartResult,
  WorkflowStatusInput,
  WorkflowStatusResult,
  WorkflowStopInput,
  WorkflowMutationResult,
  WorkflowWorkerStatus,
} from "./workflow-contracts.ts";
import {
  createRun,
  normalizeTaskCardPath,
  saveNewRun,
  saveRun,
  withLockedRun,
  withRunLock,
} from "./run-store.ts";
import { captureSourceCheckpoint } from "./source-checkpoint.ts";
import * as workerService from "./worker-service.ts";
import {
  closeWorker,
  inspectWorker,
  promptWorker,
  spawnWorker,
  type SpawnWorkerOptions,
  workerErrorRecord,
} from "./worker-service.ts";
import type { WorkerInspection } from "./worker-service.ts";
import {
  preflightWorkerSelections,
  resolveWorkerAgents,
} from "./worker-profile.ts";
import { WorkflowSupervisor } from "./supervisor.ts";
import type {
  CoordinatorNotifier,
  SupervisorWorkerOperations,
} from "./workflow-contracts.ts";

export interface WorkflowServiceWorkerOperations
  extends SupervisorWorkerOperations {
  spawnWorker(options: SpawnWorkerOptions): Promise<WorkerRecord>;
  promptWorker(
    agentName: string,
    message: string,
    projectRoot: string,
    signal?: AbortSignal,
    expected?: { run: WorkflowRun; worker: WorkerRecord },
  ): Promise<number>;
  workerErrorRecord: typeof workerErrorRecord;
}

export interface WorkflowServiceOptions {
  notifier: CoordinatorNotifier;
  workerOperations?: WorkflowServiceWorkerOperations;
  supervisorFactory?: (options: {
    notifier: CoordinatorNotifier;
    projectRoot: string;
    workerOperations?: SupervisorWorkerOperations;
  }) => WorkflowSupervisor;
}

export class WorkflowService {
  private readonly notifier: CoordinatorNotifier;
  private readonly workerOperations: WorkflowServiceWorkerOperations;
  private readonly supervisorFactory: NonNullable<
    WorkflowServiceOptions["supervisorFactory"]
  >;
  private readonly supervisors = new Map<string, WorkflowSupervisor>();

  constructor(options: WorkflowServiceOptions) {
    this.notifier = options.notifier;
    this.workerOperations = options.workerOperations ?? DEFAULT_WORKER_OPERATIONS;
    this.supervisorFactory =
      options.supervisorFactory ?? ((supervisorOptions) => new WorkflowSupervisor(supervisorOptions));
  }

  async start(input: WorkflowStartInput): Promise<WorkflowStartResult> {
    assertContext(input.context);
    throwIfAborted(input.context.signal);

    const workerAgents = resolveWorkerAgents(input.workerAgents);
    await preflightWorkerSelections(workerAgents, input.context.signal);
    throwIfAborted(input.context.signal);

    const sourceCheckpoint = await this.workerOperations.captureSourceCheckpoint(
      input.context.projectRoot,
      input.context.signal,
    );
    throwIfAborted(input.context.signal);

    const run = createRun({
      task: input.task,
      context: input.context,
      taskCardPath: await normalizeTaskCardPath(
        input.context.projectRoot,
        input.taskCardPath,
      ),
      workerAgents,
    });

    for (const kind of WORKER_ORDER) {
      run.workers[kind].sourceCheckpoint = sourceCheckpoint;
    }

    await saveNewRun(input.context.projectRoot, run);
    try {
      await withRunLock(
        input.context.projectRoot,
        run.id,
        input.context.signal,
        () => this.launchWorkers(run, input.context),
      );
    } catch (error) {
      if (input.context.signal.aborted) {
        try {
          await this.cleanupCancelledWorkers(run, input.context);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Workflow launch was cancelled and worker cleanup failed.",
          );
        }
      }
      throw error;
    }

    if (input.context.signal.aborted) {
      await this.cleanupCancelledWorkers(run, input.context);
      throw abortError(input.context.signal);
    }

    this.supervisorFor(input.context.projectRoot).supervise(run.id);

    return {
      runId: run.id,
      state: run.state,
      workers: summarizeWorkers(run),
    };
  }

  async status(input: WorkflowStatusInput): Promise<WorkflowStatusResult> {
    assertContext(input.context);
    throwIfAborted(input.context.signal);

    // Read through the lock so latest-run resolution and origin authorization
    // observe one durable run. Status never starts or resumes supervision.
    const initial = await withLockedRun(
      input.context.projectRoot,
      input.runId,
      input.context.signal,
      async (run) => {
        assertWorkflowOriginAccess(
          "status",
          input.context,
          run.origin,
          input.runId,
        );
        return { id: run.id };
      },
    );

    const supervisor = this.supervisorFor(input.context.projectRoot);
    let inspections = new Map<WorkerKind, WorkerInspection>();
    if (typeof supervisor.reconcileOnce === "function") {
      inspections = await supervisor.reconcileOnce({
        runId: initial.id,
        worker: input.worker,
        includeOutput: input.includeOutput ?? Boolean(input.worker),
        signal: input.context.signal,
      });
    }

    const run = await withLockedRun(
      input.context.projectRoot,
      initial.id,
      input.context.signal,
      async (current) => current,
    );
    const kinds = input.worker ? [input.worker] : WORKER_ORDER;
    const workers: WorkflowWorkerStatus[] = kinds.map((kind) => {
      const inspection = inspections.get(kind);
      return {
        ...summarizeWorkers(run)[kind],
        kind,
        output: inspection?.output ?? run.workers[kind].result?.output,
      };
    });

    return {
      runId: run.id,
      task: run.task,
      state: run.state,
      workers,
      notifications: [...(run.notifications ?? [])],
    };
  }

  async send(input: WorkflowSendInput): Promise<WorkflowMutationResult> {
    assertContext(input.context);
    throwIfAborted(input.context.signal);

    const result = await withLockedRun(
      input.context.projectRoot,
      input.runId,
      input.context.signal,
      async (run) => {
        assertWorkflowOriginAccess(
          "send",
          input.context,
          run.origin,
          input.runId,
        );
        const worker = requireWorker(run, input.worker);

        if (worker.result) {
          throw new Error(`${input.worker} has already completed.`);
        }
        if (worker.state === "stopped") {
          throw new Error(
            `${input.worker} is stopped. Use workflow_retry to start it again.`,
          );
        }
        if (!worker.agentName) {
          throw new Error(`${input.worker} has no active agent.`);
        }
        if (worker.attempt < 1 || !worker.tabId || !worker.paneId) {
          throw new Error(
            `Refusing to prompt ${input.worker}: its current attempt has incomplete Herdr resource identity.`,
          );
        }

        if (input.context.signal.aborted) {
          throwIfAborted(input.context.signal);
        }
        worker.pendingPromptStartSeq = await this.workerOperations.promptWorker(
          worker.agentName,
          input.message,
          input.context.projectRoot,
          input.context.signal,
          {
            run,
            worker,
          },
        );
        throwIfAborted(input.context.signal);
        worker.state = "working";
        worker.lastError = undefined;
        refreshRunState(run);
        await saveRun(input.context.projectRoot, run);

        return {
          runId: run.id,
          worker: input.worker,
          state: run.state,
          message: `Instruction sent to ${input.worker} (${worker.agentName}).`,
        };
      },
    );

    this.supervisorFor(input.context.projectRoot).supervise(result.runId);
    return result;
  }

  async stop(input: WorkflowStopInput): Promise<WorkflowMutationResult> {
    assertContext(input.context);
    throwIfAborted(input.context.signal);

    return withLockedRun(
      input.context.projectRoot,
      input.runId,
      input.context.signal,
      async (run) => {
        assertWorkflowOriginAccess(
          "stop",
          input.context,
          run.origin,
          input.runId,
        );
        const worker = requireWorker(run, input.worker);
        const supervisor = this.supervisorFor(input.context.projectRoot);

        if (worker.tabId) {
          await this.workerOperations.closeWorker(
            run,
            worker,
            input.context.projectRoot,
            input.context.signal,
          );
        }
        supervisor.cancelWorker(run.id, input.worker);
        if (input.context.signal.aborted) {
          worker.state = "stopped";
          worker.agentName = undefined;
          worker.tabId = undefined;
          worker.paneId = undefined;
          worker.pendingPromptStartSeq = undefined;
          refreshRunState(run);
          await saveRun(input.context.projectRoot, run);
          throw abortError(input.context.signal);
        }

        worker.state = "stopped";
        worker.agentName = undefined;
        worker.tabId = undefined;
        worker.paneId = undefined;
        worker.pendingPromptStartSeq = undefined;
        worker.lastError = undefined;
        refreshRunState(run);
        await saveRun(input.context.projectRoot, run);

        return {
          runId: run.id,
          worker: input.worker,
          state: run.state,
          message: `${input.worker} stopped.`,
        };
      },
    );
  }

  async retry(input: WorkflowRetryInput): Promise<WorkflowRetryResult> {
    assertContext(input.context);
    throwIfAborted(input.context.signal);

    const result = await withLockedRun(
      input.context.projectRoot,
      input.runId,
      input.context.signal,
      async (run) => {
        assertWorkflowOriginAccess(
          "retry",
          input.context,
          run.origin,
          input.runId,
        );
        const existing = requireWorker(run, input.worker);
        const sourceCheckpoint = await this.workerOperations.captureSourceCheckpoint(
          input.context.projectRoot,
          input.context.signal,
        );
        if (input.context.signal.aborted) {
          throwIfAborted(input.context.signal);
        }

        const supervisor = this.supervisorFor(input.context.projectRoot);
        if (existing.tabId) {
          await this.workerOperations.closeWorker(
            run,
            existing,
            input.context.projectRoot,
            input.context.signal,
          );
        }
        supervisor.cancelWorker(run.id, input.worker);
        if (input.context.signal.aborted) {
          existing.attemptHistory = archiveWorkerAttempt(existing);
          existing.result = undefined;
          existing.staleDetails = undefined;
          existing.cleanupError = undefined;
          existing.state = "error";
          existing.lastError =
            "Retry was cancelled after the previous attempt was closed; no replacement report was collected.";
          existing.agentName = undefined;
          existing.tabId = undefined;
          existing.paneId = undefined;
          existing.pendingPromptStartSeq = undefined;
          refreshRunState(run);
          await saveRun(input.context.projectRoot, run);
          throw abortError(input.context.signal);
        }

        const nextAttempt = existing.attempt + 1;
        const replacement = createReplacementWorker(
          existing,
          nextAttempt,
          sourceCheckpoint,
        );
        run.workers[input.worker] = replacement;

        try {
          run.workers[input.worker] = await this.workerOperations.spawnWorker({
            run,
            projectRoot: input.context.projectRoot,
            kind: input.worker,
            attempt: nextAttempt,
            sourceCheckpoint,
            signal: input.context.signal,
            additionalInstruction: input.additionalInstruction,
          });
        } catch (error) {
          run.workers[input.worker] = this.workerOperations.workerErrorRecord(
            input.worker,
            nextAttempt,
            error,
            {
              definition: replacement.definition,
              sourceCheckpoint: replacement.sourceCheckpoint,
              attemptHistory: replacement.attemptHistory,
            },
          );
        }

        if (input.context.signal.aborted) {
          await this.cleanupCancelledWorkerAttempt(run, input.worker, input.context);
          throw abortError(input.context.signal);
        }

        try {
          refreshRunState(run);
          await saveRun(input.context.projectRoot, run);
        } catch (saveError) {
          try {
            await this.workerOperations.closeWorker(
              run,
              run.workers[input.worker],
              input.context.projectRoot,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [saveError, cleanupError],
              "The replacement worker could not be saved or cleaned up.",
            );
          }
          throw saveError;
        }
        if (input.context.signal.aborted) {
          await this.cleanupCancelledWorkerAttempt(run, input.worker, input.context);
          throw abortError(input.context.signal);
        }

        return {
          runId: run.id,
          worker: input.worker,
          state: run.state,
          message: `${input.worker} retry started.`,
          workerResult: summarizeWorkers(run)[input.worker],
        };
      },
    );

    this.supervisorFor(input.context.projectRoot).supervise(result.runId);
    return result;
  }

  async resumeForSession(projectRoot: string, sessionId: string): Promise<void> {
    await this.supervisorFor(projectRoot).resumeForSession(sessionId);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.supervisors.values()].map((supervisor) => supervisor.dispose()));
    this.supervisors.clear();
  }

  private supervisorFor(projectRoot: string): WorkflowSupervisor {
    const existing = this.supervisors.get(projectRoot);
    if (existing) {
      return existing;
    }

    const supervisor = this.supervisorFactory({
      notifier: this.notifier,
      projectRoot,
      workerOperations: this.workerOperations,
    });
    this.supervisors.set(projectRoot, supervisor);
    return supervisor;
  }

  private async launchWorkers(
    run: WorkflowRun,
    context: ProjectContext,
  ): Promise<void> {
    let saveQueue = Promise.resolve();
    const queueSave = () => {
      saveQueue = saveQueue.then(() => saveRun(context.projectRoot, run));
      return saveQueue;
    };

    const launches = await Promise.allSettled(
      WORKER_ORDER.map(async (kind) => {
        try {
          run.workers[kind] = await this.workerOperations.spawnWorker({
            run,
            projectRoot: context.projectRoot,
            kind,
            attempt: 1,
            sourceCheckpoint: run.workers[kind].sourceCheckpoint,
            signal: context.signal,
          });
        } catch (error) {
          run.workers[kind] = this.workerOperations.workerErrorRecord(
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

    if (context.signal.aborted) {
      await this.cleanupCancelledWorkers(run, context);
      throw abortError(context.signal);
    }

    const saveFailure = launches.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (saveFailure) {
      const cleanup = await Promise.allSettled(
        WORKER_ORDER.map((kind) =>
          this.workerOperations.closeWorker(
            run,
            run.workers[kind],
            context.projectRoot,
            context.signal,
          ),
        ),
      );
      const cleanupFailure = cleanup.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
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
          await this.workerOperations.closeWorker(
            run,
            worker,
            context.projectRoot,
            context.signal,
          );
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
      await saveRun(context.projectRoot, run);
      if (context.signal.aborted) {
        throw abortError(context.signal);
      }
    }
  }

  private async cleanupCancelledWorkerAttempt(
    run: WorkflowRun,
    kind: WorkerKind,
    context: ProjectContext,
  ): Promise<void> {
    const worker = run.workers[kind];
    if (worker.tabId) {
      await this.workerOperations.closeWorker(
        run,
        worker,
        context.projectRoot,
      );
    }
    worker.tabId = undefined;
    worker.paneId = undefined;
    worker.state = "error";
    worker.lastError =
      "Retry was cancelled before a replacement report was collected.";
    refreshRunState(run);
    await saveRun(context.projectRoot, run);
  }

  private async cleanupCancelledWorkers(
    run: WorkflowRun,
    context: ProjectContext,
  ): Promise<void> {
    const cleanup = await Promise.allSettled(
      WORKER_ORDER.filter((kind) => run.workers[kind].tabId).map(async (kind) => {
        const worker = run.workers[kind];
        await this.workerOperations.closeWorker(run, worker, context.projectRoot);
        worker.tabId = undefined;
        worker.paneId = undefined;
        worker.state = "stopped";
      }),
    );
    const cleanupFailure = cleanup.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cleanupFailure) {
      throw cleanupFailure.reason;
    }

    for (const kind of WORKER_ORDER) {
      const worker = run.workers[kind];
      if (!worker.tabId) {
        worker.agentName = undefined;
        worker.paneId = undefined;
        worker.state = "stopped";
      }
    }

    refreshRunState(run);
    await saveRun(context.projectRoot, run);
  }
}

const DEFAULT_WORKER_OPERATIONS: WorkflowServiceWorkerOperations = {
  captureSourceCheckpoint,
  closeWorker,
  inspectWorker,
  waitForWorkerState: async (agentName, states, projectRoot, signal) => {
    if (typeof workerService.waitForWorkerState !== "function") {
      throw new Error("Worker wait operations are unavailable.");
    }
    return workerService.waitForWorkerState(
      agentName,
      states,
      projectRoot,
      signal,
    );
  },
  spawnWorker,
  promptWorker,
  workerErrorRecord,
};

function assertContext(context: ProjectContext): void {
  assertProjectContext(context);
}

function requireWorker(run: WorkflowRun, kind: WorkerKind): WorkerRecord {
  const worker = run.workers[kind];
  if (!worker) {
    throw new Error(`Workflow worker ${kind} was not found.`);
  }
  return worker;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow operation was aborted.");
}
