import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";

import {
  BUILT_IN_ROLE_DEFINITIONS,
  createAgentName,
  isWorkflowRun,
  isLegacyAgentName,
  WORKER_ORDER,
} from "./model.ts";
import type {
  RoleId,
  WorkerDefinition,
  WorkerRecord,
  WorkflowRun,
  WorkflowRunV2,
} from "./model.ts";

const CURRENT_RUN_ID_PATTERN =
  /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LEGACY_RUN_ID_PATTERN = /^run-[0-9a-f]{8}$/;
const LOCK_RETRY_MS = 100;
const LOCK_WAIT_MS = 10 * 60_000;
const STALE_LOCK_MS = 15 * 60_000;
const STALE_RECOVERY_LOCK_MS = 30_000;

interface CreateRunOptions {
  task: string;
  taskCardPath?: string;
  originSessionId: string;
  workspaceId: string;
  paneId?: string;
}

export function createRun(options: CreateRunOptions): WorkflowRunV2 {
  const now = new Date().toISOString();
  const paneId =
    options.paneId?.trim() ||
    process.env.HERDR_PANE_ID?.trim() ||
    options.originSessionId.trim();
  const workers = Object.fromEntries(
    WORKER_ORDER.map((roleId) => [roleId, initialWorker(roleId)]),
  );

  return {
    version: 2,
    id: `run-${randomUUID()}`,
    task: options.task.trim(),
    taskCardPath: options.taskCardPath,
    originSessionId: options.originSessionId,
    herdrWorkspaceId: options.workspaceId,
    createdAt: now,
    updatedAt: now,
    state: "launching",
    workerOrder: [...WORKER_ORDER],
    origin: {
      workspaceId: options.workspaceId,
      paneId,
      coordinatorKind: "kilo",
      sessionId: options.originSessionId,
    },
    workers,
    nextNotificationSequence: 1,
    notifications: [],
  };
}

export async function saveNewRun(
  projectRoot: string,
  run: WorkflowRun,
): Promise<void> {
  assertValidRun(run, run.id);
  await mkdir(runsRoot(projectRoot), { recursive: true });

  try {
    await mkdir(runDirectory(projectRoot, run.id));
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      throw new Error(`Workflow run ${run.id} already exists.`);
    }

    throw error;
  }

  await atomicWrite(
    runFile(projectRoot, run.id),
    serializeRun(run),
  );
  await atomicWrite(latestFile(projectRoot), `${run.id}\n`);
}

export async function saveRun(
  projectRoot: string,
  run: WorkflowRun,
): Promise<void> {
  assertValidRun(run, run.id);
  await atomicWrite(
    runFile(projectRoot, run.id),
    serializeRun(run),
  );
}

export async function loadRun(
  projectRoot: string,
  requestedRunId?: string,
): Promise<WorkflowRunV2> {
  const runId = await resolveRunId(projectRoot, requestedRunId);
  return loadRunById(projectRoot, runId);
}

export async function listRuns(projectRoot: string): Promise<WorkflowRunV2[]> {
  let entries;

  try {
    entries = await readdir(runsRoot(projectRoot), { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return [];
    }

    throw error;
  }

  const runs = await Promise.allSettled(
    entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          (CURRENT_RUN_ID_PATTERN.test(entry.name) ||
            LEGACY_RUN_ID_PATTERN.test(entry.name)),
      )
      .map((entry) => loadRunById(projectRoot, entry.name)),
  );

  return runs.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
}

export async function withLockedRun<T>(
  projectRoot: string,
  requestedRunId: string | undefined,
  signal: AbortSignal | undefined,
  operation: (run: WorkflowRun) => Promise<T>,
): Promise<T> {
  const runId = await resolveRunId(projectRoot, requestedRunId);

  return withRunLock(projectRoot, runId, signal, async () => {
    const run = await loadRunById(projectRoot, runId);
    return operation(run);
  });
}

export async function withRunLock<T>(
  projectRoot: string,
  runId: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  assertRunId(runId);
  const release = await acquireRunLock(projectRoot, runId, signal);

  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function normalizeTaskCardPath(
  projectRoot: string,
  taskCardPath: string | undefined,
): Promise<string | undefined> {
  const input = taskCardPath?.trim();

  if (!input) {
    return undefined;
  }

  if (path.isAbsolute(input) || /[\u0000-\u001f]/.test(input)) {
    throw new Error("Task Card path must be a project-relative path.");
  }

  const resolved = path.resolve(projectRoot, input);
  assertPathInsideProject(projectRoot, resolved);

  let projectRealPath: string;
  let taskCardRealPath: string;

  try {
    [projectRealPath, taskCardRealPath] = await Promise.all([
      realpath(projectRoot),
      realpath(resolved),
    ]);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Task Card "${input}" was not found.`);
    }

    throw error;
  }

  assertPathInsideProject(projectRealPath, taskCardRealPath);

  if (!(await stat(taskCardRealPath)).isFile()) {
    throw new Error(`Task Card "${input}" is not a file.`);
  }

  return path.relative(projectRoot, resolved).split(path.sep).join("/");
}

async function resolveRunId(
  projectRoot: string,
  requestedRunId?: string,
): Promise<string> {
  let runId = requestedRunId?.trim();

  if (!runId) {
    try {
      runId = (await readFile(latestFile(projectRoot), "utf8")).trim();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        throw new Error("No workflow run was found.");
      }

      throw error;
    }
  }

  assertRunId(runId);
  return runId;
}

async function loadRunById(
  projectRoot: string,
  runId: string,
): Promise<WorkflowRunV2> {
  assertRunId(runId);

  let contents: string;
  try {
    contents = await readFile(runFile(projectRoot, runId), "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      throw new Error(`Workflow run ${runId} was not found.`);
    }

    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error(`Workflow run ${runId} contains invalid JSON.`);
  }

  return assertValidRun(parsed, runId);
}

function initialWorker(roleId: string): WorkerRecord {
  const definition = workerDefinition(roleId);

  return {
    kind: roleId,
    roleId,
    attempt: 0,
    definition,
    state: "launching",
  };
}

function workerDefinition(roleId: string): WorkerDefinition {
  const builtIn = BUILT_IN_ROLE_DEFINITIONS.find(
    (definition) => definition.roleId === roleId,
  );

  if (!builtIn) {
    throw new Error(`Unknown built-in workflow role "${roleId}".`);
  }

  const body = `Bundled ${builtIn.skillId} reviewer methodology.`;

  return {
    roleId: builtIn.roleId,
    label: builtIn.label,
    agentKind: "kilo",
    skill: {
      id: builtIn.skillId,
      hash: createHash("sha256").update(body, "utf8").digest("hex"),
      body,
    },
    capabilityProfile: "kilo-default",
    enforcement: {
      profile: "kilo-default",
      strength: "moderate",
      allowsWrites: true,
    },
  };
}

function runsRoot(projectRoot: string): string {
  return path.join(projectRoot, ".workflow", "runs");
}

function runDirectory(projectRoot: string, runId: string): string {
  assertRunId(runId);
  return path.join(runsRoot(projectRoot), runId);
}

function runFile(projectRoot: string, runId: string): string {
  return path.join(runDirectory(projectRoot, runId), "run.json");
}

function latestFile(projectRoot: string): string {
  return path.join(runsRoot(projectRoot), "latest");
}

function lockFile(projectRoot: string, runId: string): string {
  return path.join(runDirectory(projectRoot, runId), "run.lock");
}

function assertRunId(runId: unknown): asserts runId is string {
  if (
    typeof runId !== "string" ||
    (!CURRENT_RUN_ID_PATTERN.test(runId) &&
      !LEGACY_RUN_ID_PATTERN.test(runId))
  ) {
    throw new Error(`Invalid workflow run ID "${runId}".`);
  }
}

function assertValidRun(
  value: unknown,
  expectedRunId: string,
): WorkflowRunV2 {
  assertRunId(expectedRunId);

  if (!isRecord(value) || value.version !== 2) {
    if (isRecord(value) && value.version === 1) {
      throw new Error(
        [
          `Workflow run ${expectedRunId} uses unsupported version 1 data.`,
          `The obsolete .workflow/runs/${expectedRunId} data was not migrated or deleted.`,
        ].join(" "),
      );
    }

    throw new Error(
      `Workflow run ${expectedRunId} has an unsupported format; expected version 2.`,
    );
  }

  if (value.id !== expectedRunId || !isWorkflowRun(value)) {
    throw new Error(`Workflow run ${expectedRunId} is invalid.`);
  }

  for (const roleId of value.workerOrder) {
    const worker = value.workers[roleId];

    if (!isExpectedAgentName(worker.agentName, expectedRunId, roleId, worker.attempt)) {
      throw new Error(
        `Workflow run ${expectedRunId} has an invalid ${roleId} worker agent name.`,
      );
    }
  }

  return value;
}

function serializeRun(run: WorkflowRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

async function atomicWrite(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, contents, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function acquireRunLock(
  projectRoot: string,
  runId: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  const filePath = lockFile(projectRoot, runId);
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    throwIfAborted(signal);

    try {
      const handle = await open(filePath, "wx");

      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(filePath).catch(() => undefined);
        throw error;
      }

      return async () => {
        await handle.close();
        await unlink(filePath).catch((error) => {
          if (!isNodeError(error, "ENOENT")) {
            throw error;
          }
        });
      };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) {
        throw error;
      }
    }

    if (
      (await isStaleLock(filePath)) &&
      (await recoverStaleLock(filePath))
    ) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting to update workflow run ${runId}.`);
    }

    await abortableDelay(LOCK_RETRY_MS, signal);
  }
}

async function recoverStaleLock(filePath: string): Promise<boolean> {
  const recoveryPath = `${filePath}.recovery`;
  let recoveryHandle: FileHandle;

  try {
    recoveryHandle = await open(recoveryPath, "wx");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      if (await isStaleLock(recoveryPath, STALE_RECOVERY_LOCK_MS)) {
        await unlink(recoveryPath).catch((unlinkError) => {
          if (!isNodeError(unlinkError, "ENOENT")) {
            throw unlinkError;
          }
        });
      }

      return false;
    }

    throw error;
  }

  try {
    if (!(await isStaleLock(filePath, STALE_LOCK_MS))) {
      return false;
    }

    await unlink(filePath).catch((error) => {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
    });
    return true;
  } finally {
    await recoveryHandle.close().catch(() => undefined);
    await unlink(recoveryPath).catch(() => undefined);
  }
}

async function isStaleLock(
  filePath: string,
  staleAfterMs = STALE_LOCK_MS,
): Promise<boolean> {
  try {
    const lockStat = await stat(filePath);
    return Date.now() - lockStat.mtimeMs > staleAfterMs;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return false;
    }

    throw error;
  }
}

async function abortableDelay(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return;
  }

  throwIfAborted(signal);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError(signal));
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Workflow operation was aborted.");
}

function assertPathInsideProject(
  projectRoot: string,
  candidatePath: string,
): void {
  const relative = path.relative(projectRoot, candidatePath);

  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Task Card path must stay inside the project.");
  }
}

function isExpectedAgentName(
  agentName: unknown,
  runId: string,
  roleId: RoleId,
  attempt: number,
): boolean {
  return (
    agentName === undefined ||
    agentName === "" ||
    agentName === createAgentName(runId, roleId, attempt) ||
    isLegacyAgentName(agentName, runId, roleId, attempt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: unknown }).code === code
  );
}
