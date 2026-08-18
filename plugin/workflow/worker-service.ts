import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { createAgentName } from "./model.ts";
import type {
  WorkerDefinition,
  WorkerKind,
  WorkerRecord,
  WorkerState,
  WorkflowRun,
} from "./model.ts";

const HERDR_TIMEOUT_MS = 120_000;
const MAX_HERDR_OUTPUT_LENGTH = 2 * 1024 * 1024;
const WORKFLOW_LAUNCHER_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "launcher",
);

interface WorkerSpec {
  tabLabel: string;
  instructions: string;
}

const WORKER_SPECS: Record<WorkerKind, WorkerSpec> = {
  tests: {
    tabLabel: "Tests",
    instructions: `
Independently verify the implementation.

Run the relevant tests, builds, linters, type checks, static analysis,
or other project verification appropriate to the changed code.

Evaluate whether the Task Card acceptance criteria are adequately verified.

Do not edit production or test source files to make checks pass.
Generated build/test artifacts are fine.
`,
  },
  "code-review": {
    tabLabel: "Code Review",
    instructions: `
Perform an independent engineering review of the implementation.

Focus on correctness, regressions, edge cases, maintainability,
architectural violations, lifecycle problems, error handling,
and unnecessary complexity.

Do not modify files.
`,
  },
  readability: {
    tabLabel: "Readability",
    instructions: `
Review the implementation specifically as a human code reviewer.

Focus on naming, control flow, unnecessary abstraction,
jargon-heavy code, difficult-to-follow structure, misleading comments,
and anything that makes the change harder to understand or maintain.

Do not modify files.
`,
  },
};

interface SpawnWorkerOptions {
  run: WorkflowRun;
  projectRoot: string;
  kind: WorkerKind;
  attempt: number;
  signal?: AbortSignal;
  additionalInstruction?: string;
}

export interface WorkerInspection {
  state: WorkerState;
  output?: string;
  error?: string;
  promptStarted?: boolean;
  stateChangeSeq?: number;
}

type HerdrWaitState = "idle" | "working" | "blocked" | "done" | "unknown";

export function requireHerdrWorkspace(): string {
  const workspaceId = process.env.HERDR_WORKSPACE_ID?.trim();

  if (!workspaceId) {
    throw new Error(
      [
        "The engineering workflow must currently be started from a Kilo",
        "session running inside Herdr.",
        "HERDR_WORKSPACE_ID is not available.",
      ].join(" "),
    );
  }

  return workspaceId;
}

export async function spawnWorker(
  options: SpawnWorkerOptions,
): Promise<WorkerRecord> {
  const {
    run,
    projectRoot,
    kind,
    attempt,
    signal,
    additionalInstruction,
  } = options;
  const spec = WORKER_SPECS[kind];
  const definition = run.workers[kind].definition;
  const agentName = createAgentName(run.id, kind, attempt);
  const initialPrompt = buildWorkerPrompt(run, kind, additionalInstruction);
  const windowsLaunch = process.platform === "win32";
  let agentArguments = ["--agent", "code"];
  let temporaryPromptDirectory: string | undefined;
  let tabId: string | undefined;
  let paneId: string | undefined;

  try {
    const createdRaw = await runHerdr(
      [
        "tab",
        "create",
        "--workspace",
        run.herdrWorkspaceId,
        "--cwd",
        projectRoot,
        "--label",
        `${shortTaskName(run)} - ${spec.tabLabel}`,
        "--env",
        `WORKFLOW_ROLE=${kind}`,
        "--env",
        `WORKFLOW_RUN_ID=${run.id}`,
        "--no-focus",
      ],
      projectRoot,
      signal,
    );

    const created = parseJsonRecord(createdRaw);
    tabId = nestedString(created, "result", "tab", "tab_id");
    paneId = nestedString(
      created,
      "result",
      "root_pane",
      "pane_id",
    );

    if (!tabId || !paneId) {
      throw new Error(
        "Herdr tab creation did not return a tab ID and root pane ID.",
      );
    }

    if (windowsLaunch) {
      temporaryPromptDirectory = await mkdtemp(
        path.join(tmpdir(), "kilo-workflow-"),
      );
      const promptPath = path.join(temporaryPromptDirectory, "prompt.txt");

      await writeFile(promptPath, initialPrompt, "utf8");
      agentArguments = ["--workflow-prompt-file", promptPath];
      await prependWindowsKiloShimToPanePath(paneId, projectRoot, signal);
    }

    await runHerdr(
      [
        "agent",
        "start",
        agentName,
        "--kind",
        "kilo",
        "--pane",
        paneId,
        "--",
        ...agentArguments,
      ],
      projectRoot,
      signal,
    );

    if (windowsLaunch) {
      // The pane-local shim transports the long prompt by file. Herdr sees the
      // shim as started before the delegated Kilo TUI is ready for submission.
      await runHerdr(
        [
          "pane",
          "wait-output",
          paneId,
          "--match",
          "ctrl+p commands",
          "--source",
          "visible",
          "--timeout",
          "90000",
        ],
        projectRoot,
        signal,
      );
      await runHerdr(
        ["agent", "send-keys", agentName, "enter"],
        projectRoot,
        signal,
      );
      await runHerdr(
        [
          "agent",
          "wait",
          agentName,
          "--until",
          "working",
          "--timeout",
          "10000",
        ],
        projectRoot,
        signal,
      );
    } else {
      await submitPrompt(
        agentName,
        initialPrompt,
        projectRoot,
        signal,
        true,
      );
    }

    await removeTemporaryPrompt(temporaryPromptDirectory);

    return {
      kind,
      roleId: kind,
      attempt,
      definition,
      agentName,
      tabId,
      paneId,
      state: "working",
    };
  } catch (error) {
    await removeTemporaryPrompt(temporaryPromptDirectory);

    if (tabId) {
      const cleanupError = await closeTabForCleanup(tabId, projectRoot);

      if (cleanupError) {
        throw new WorkerLaunchError({
          kind,
          attempt,
          agentName,
          tabId,
          paneId,
          state: "error",
          lastError: `${errorMessage(error)}\nCleanup also failed: ${errorMessage(cleanupError)}`,
        });
      }
    }

    throw error;
  }
}

export async function inspectWorker(options: {
  worker: WorkerRecord;
  projectRoot: string;
  includeOutput: boolean;
  signal?: AbortSignal;
}): Promise<WorkerInspection> {
  const { worker, projectRoot, includeOutput, signal } = options;

  if (worker.result) {
    return {
      state: worker.state,
      output: worker.result.output,
      stateChangeSeq: worker.stateChangeSeq,
    };
  }

  if (worker.state === "stopped") {
    return { state: "stopped" };
  }

  if (!worker.agentName) {
    return {
      state: worker.state,
      error: worker.lastError,
    };
  }

  try {
    const raw = await runHerdr(
      ["agent", "get", worker.agentName],
      projectRoot,
      signal,
    );
    const parsed = parseJsonRecord(raw);
    const result = asRecord(parsed.result);
    const agent = asRecord(result?.agent) ?? result;
    const observedState = mapHerdrAgentState(
      agent?.status ?? agent?.agent_status,
    );
    const stateChangeSeq = numberValue(agent?.state_change_seq);
    const promptStarted =
      worker.pendingPromptStartSeq !== undefined &&
      stateChangeSeq !== undefined &&
      stateChangeSeq >= worker.pendingPromptStartSeq;
    const waitingForPrompt =
      worker.pendingPromptStartSeq !== undefined && !promptStarted;
    const state = waitingForPrompt ? "working" : observedState;
    const shouldRead =
      includeOutput ||
      state === "blocked" ||
      state === "done" ||
      state === "idle";

    return {
      state,
      promptStarted,
      stateChangeSeq,
      output: shouldRead
        ? await readWorkerOutput(
            worker.agentName,
            state,
            projectRoot,
            signal,
          )
        : undefined,
    };
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    return {
      state: "unknown",
      error: errorMessage(error),
    };
  }
}

export async function waitForWorkerState(
  agentName: string,
  states: HerdrWaitState[],
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (states.length === 0) {
    throw new Error("At least one Herdr worker state is required.");
  }

  await runHerdr(
    [
      "agent",
      "wait",
      agentName,
      ...states.flatMap((state) => ["--until", state]),
    ],
    projectRoot,
    signal,
    null,
  );
}

export async function promptWorker(
  agentName: string,
  message: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<number> {
  const agent = await getAgentIdentity(agentName, projectRoot, signal);

  if (!agent) {
    throw new Error(`Herdr agent ${agentName} was not found.`);
  }

  const requiredTransitions = agent.state === "working" ? 2 : 1;
  await submitPrompt(agentName, message, projectRoot, signal);
  return agent.stateChangeSeq + requiredTransitions;
}

export function workerErrorRecord(
  kind: WorkerKind,
  attempt: number,
  error: unknown,
  definition?: WorkerDefinition,
): WorkerRecord {
  if (error instanceof WorkerLaunchError) {
    return {
      ...error.worker,
      roleId: kind,
      definition,
    };
  }

  return {
    kind,
    roleId: kind,
    attempt,
    definition,
    state: "error",
    lastError: errorMessage(error),
  };
}

async function prependWindowsKiloShimToPanePath(
  paneId: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (process.platform !== "win32") {
    return;
  }

  const escapedShimDirectory = WORKFLOW_LAUNCHER_DIRECTORY.replaceAll(
    "'",
    "''",
  );

  await runHerdr(
    [
      "pane",
      "run",
      paneId,
      `$env:PATH = '${escapedShimDirectory}${path.delimiter}' + $env:PATH`,
    ],
    projectRoot,
    signal,
  );
}

async function submitPrompt(
  agentName: string,
  message: string,
  projectRoot: string,
  signal: AbortSignal | undefined,
  waitForWorking = false,
): Promise<void> {
  await runHerdr(
    [
      "agent",
      "prompt",
      agentName,
      message,
      ...(waitForWorking
        ? [
            "--wait",
            "--until",
            "working",
            "--timeout",
            "10000",
          ]
        : []),
    ],
    projectRoot,
    signal,
  );
}

async function removeTemporaryPrompt(directory?: string): Promise<void> {
  if (!directory) {
    return;
  }

  try {
    await rm(directory, { force: true, recursive: true });
  } catch {
    // The OS temp directory can clean up a prompt file if deletion is denied.
  }
}

export async function closeWorker(
  run: WorkflowRun,
  worker: WorkerRecord,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!worker.tabId) {
    return;
  }

  const tab = await getTabIdentity(worker.tabId, projectRoot, signal);
  if (!tab) {
    return;
  }

  if (
    tab.tabId !== worker.tabId ||
    tab.workspaceId !== run.herdrWorkspaceId ||
    tab.label !== `${shortTaskName(run)} - ${WORKER_SPECS[worker.kind].tabLabel}`
  ) {
    throw new Error(
      `Refusing to close tab ${worker.tabId}: it does not belong to workflow ${run.id}.`,
    );
  }

  if (worker.agentName && worker.paneId) {
    const agent = await getAgentIdentity(
      worker.agentName,
      projectRoot,
      signal,
    );

    if (!agent && worker.state !== "error") {
      throw new Error(
        `Refusing to close tab ${worker.tabId}: its worker identity no longer matches workflow ${run.id}.`,
      );
    }

    if (
      agent &&
      (agent.tabId !== worker.tabId ||
        agent.paneId !== worker.paneId ||
        agent.workspaceId !== run.herdrWorkspaceId ||
        !samePath(agent.cwd, projectRoot))
    ) {
      throw new Error(
        `Refusing to close tab ${worker.tabId}: its worker identity no longer matches workflow ${run.id}.`,
      );
    }
  }

  try {
    await runHerdr(["tab", "close", worker.tabId], projectRoot, signal);
  } catch (error) {
    if (!isMissingResourceError(error)) {
      throw error;
    }
  }

  await confirmTabAbsent(worker.tabId, projectRoot, signal);
}

async function confirmTabAbsent(
  tabId: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (!(await getTabIdentity(tabId, projectRoot, signal))) {
      return;
    }

    await abortableDelay(200, signal);
  }

  throw new Error(`Herdr tab ${tabId} still exists after close.`);
}

async function getTabIdentity(
  tabId: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<
  | { label: string; tabId: string; workspaceId: string }
  | undefined
> {
  let parsed: Record<string, unknown>;

  try {
    parsed = parseJsonRecord(
      await runHerdr(["tab", "get", tabId], projectRoot, signal),
    );
  } catch (error) {
    if (isMissingResourceError(error)) {
      return undefined;
    }

    throw error;
  }

  const actualTabId = nestedString(parsed, "result", "tab", "tab_id");
  const label = nestedString(parsed, "result", "tab", "label");
  const workspaceId = nestedString(
    parsed,
    "result",
    "tab",
    "workspace_id",
  );

  if (!actualTabId || !label || !workspaceId) {
    throw new Error("Herdr tab lookup returned an invalid response.");
  }

  return { label, tabId: actualTabId, workspaceId };
}

async function getAgentIdentity(
  agentName: string,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<
  | {
      cwd: string;
      paneId: string;
      state: WorkerState;
      stateChangeSeq: number;
      tabId: string;
      workspaceId: string;
    }
  | undefined
> {
  let parsed: Record<string, unknown>;

  try {
    parsed = parseJsonRecord(
      await runHerdr(["agent", "get", agentName], projectRoot, signal),
    );
  } catch (error) {
    if (isMissingResourceError(error)) {
      return undefined;
    }

    throw error;
  }

  const cwd = nestedString(parsed, "result", "agent", "cwd");
  const paneId = nestedString(parsed, "result", "agent", "pane_id");
  const state = mapHerdrAgentState(
    nestedString(parsed, "result", "agent", "agent_status"),
  );
  const stateChangeSeq = nestedNumber(
    parsed,
    "result",
    "agent",
    "state_change_seq",
  );
  const tabId = nestedString(parsed, "result", "agent", "tab_id");
  const workspaceId = nestedString(
    parsed,
    "result",
    "agent",
    "workspace_id",
  );

  if (
    !cwd ||
    !paneId ||
    state === "unknown" ||
    stateChangeSeq === undefined ||
    !tabId ||
    !workspaceId
  ) {
    throw new Error("Herdr agent lookup returned an invalid response.");
  }

  return { cwd, paneId, state, stateChangeSeq, tabId, workspaceId };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildWorkerPrompt(
  run: WorkflowRun,
  kind: WorkerKind,
  additionalInstruction?: string,
): string {
  const spec = WORKER_SPECS[kind];
  const taskCard = run.taskCardPath
    ? run.taskCardPath
    : "No explicit Task Card path was supplied. Use the task description and current implementation diff.";

  return `
You are a parallel verification worker for engineering workflow ${run.id}.

ROLE
${kind}

TASK
${run.task}

TASK CARD
${taskCard}

The implementation has reached a stable review checkpoint.

Inspect the current working tree, git status, git diff, relevant surrounding
code, and the Task Card when one is available.

${spec.instructions}

Do not expand the scope of the implementation.

When finished, make your FINAL response concise and structured as:

VERDICT: PASS | FAIL

BLOCKING
- findings, or "None"

NON-BLOCKING
- findings, or "None"

EVIDENCE / VERIFICATION
- relevant files, commands, tests, or reasoning

Do not manufacture findings merely to produce output.

${
  additionalInstruction
    ? `ADDITIONAL INSTRUCTION FOR THIS ATTEMPT\n${additionalInstruction}`
    : ""
}
`.trim();
}

async function readWorkerOutput(
  agentName: string,
  state: WorkerState,
  projectRoot: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const finished = state === "done" || state === "idle";

    return await runHerdr(
      finished
        ? [
            "agent",
            "read",
            agentName,
            "--source",
            "recent-unwrapped",
            "--lines",
            "200",
          ]
        : [
            "agent",
            "read",
            agentName,
            "--source",
            "visible",
            "--lines",
            "60",
          ],
      projectRoot,
      signal,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }

    return undefined;
  }
}

async function closeTabForCleanup(
  tabId: string,
  projectRoot: string,
): Promise<unknown | undefined> {
  try {
    await runHerdr(["tab", "close", tabId], projectRoot);
    return undefined;
  } catch (error) {
    return isMissingResourceError(error) ? undefined : error;
  }
}

async function runHerdr(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number | null = HERDR_TIMEOUT_MS,
): Promise<string> {
  const executable = process.env.HERDR_BIN_PATH || "herdr";

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }

      if (error) {
        reject(error);
      } else {
        resolve(stdout.trim());
      }
    };

    const appendOutput = (
      current: string,
      chunk: string,
    ): string | undefined => {
      const combined = current + chunk;

      if (combined.length > MAX_HERDR_OUTPUT_LENGTH) {
        child.kill();
        finish(new Error("Herdr returned more output than the workflow accepts."));
        return undefined;
      }

      return combined;
    };

    if (timeoutMs !== null) {
      timeout = setTimeout(() => {
        child.kill();
        finish(
          new Error(
            `Herdr did not finish within ${timeoutMs / 1000} seconds.`,
          ),
        );
      }, timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout = appendOutput(stdout, chunk) ?? stdout;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk) ?? stderr;
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      finish(
        new Error(
          [
            `Herdr exited with code ${code}.`,
            stderr.trim(),
            stdout.trim(),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

async function abortableDelay(
  durationMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    return;
  }

  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Workflow operation was aborted.");
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
          : new Error("Workflow operation was aborted."),
      );
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function shortTaskName(run: WorkflowRun): string {
  if (run.taskCardPath) {
    return path.basename(
      run.taskCardPath,
      path.extname(run.taskCardPath),
    );
  }

  const cleaned = run.task
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned.length <= 28 ? cleaned : `${cleaned.slice(0, 25)}...`;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Expected JSON from Herdr but received:\n${value}`);
  }

  const record = asRecord(parsed);
  if (!record) {
    throw new Error("Expected a JSON object from Herdr.");
  }

  return record;
}

function nestedString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  let current: unknown = value;

  for (const key of keys) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }

    current = record[key];
  }

  return typeof current === "string" ? current : undefined;
}

function nestedNumber(
  value: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  let current: unknown = value;

  for (const key of keys) {
    const record = asRecord(current);
    if (!record) {
      return undefined;
    }

    current = record[key];
  }

  return numberValue(current);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissingResourceError(error: unknown): boolean {
  return /not found|does not exist|unknown tab/i.test(errorMessage(error));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);

  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function mapHerdrAgentState(value: unknown): WorkerState {
  switch (value) {
    case "working":
    case "blocked":
    case "done":
    case "idle":
      return value;
    default:
      return "unknown";
  }
}

class WorkerLaunchError extends Error {
  readonly worker: WorkerRecord;

  constructor(worker: WorkerRecord) {
    super(worker.lastError);
    this.name = "WorkerLaunchError";
    this.worker = worker;
  }
}
