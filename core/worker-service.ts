import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import { createAgentName } from "./model.ts";
import { runHerdrCommand } from "./herdr-command.ts";
import type {
  SourceCheckpoint,
  WorkerDefinition,
  WorkerAttemptEvidence,
  WorkerKind,
  WorkerRecord,
  WorkerState,
  WorkflowRun,
} from "./model.ts";
import {
  getWorkerLaunchConfiguration,
} from "./worker-profile.ts";
import type { WorkerLaunchConfiguration } from "./worker-profile.ts";

const WORKFLOW_LAUNCHER_DIRECTORY = resolveWorkflowLauncherDirectory();

interface WorkerSpec {
  tabLabel: string;
}

const WORKER_SPECS: Record<WorkerKind, WorkerSpec> = {
  tests: {
    tabLabel: "Tests",
  },
  "code-review": {
    tabLabel: "Code Review",
  },
  readability: {
    tabLabel: "Readability",
  },
};

export interface SpawnWorkerOptions {
  run: WorkflowRun;
  projectRoot: string;
  kind: WorkerKind;
  attempt: number;
  sourceCheckpoint?: SourceCheckpoint;
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

export function resolveWorkflowLauncherDirectory(
  moduleUrl: string | URL = import.meta.url,
): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "launcher");
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
  if (!definition) {
    throw new Error(`Workflow worker ${kind} has no persisted definition.`);
  }
  const sourceCheckpoint =
    options.sourceCheckpoint ?? run.workers[kind].sourceCheckpoint;
  if (!sourceCheckpoint) {
    throw new Error(
      `Workflow worker ${kind} attempt ${attempt} has no source checkpoint.`,
    );
  }

  const launchConfiguration = getWorkerLaunchConfiguration(
    definition.agentKind,
    kind,
  );
  const agentName = createAgentName(run.id, kind, attempt);
  const initialPrompt = buildWorkerPrompt(run, kind, additionalInstruction);
  const windowsLaunch =
    launchConfiguration.promptTransport === "kilo-windows-prompt-file";
  let agentArguments = [...launchConfiguration.launchArguments];
  let temporaryPromptDirectory: string | undefined;
  let tabId: string | undefined;
  let paneId: string | undefined;

  try {
    const createdRaw = await runHerdrCommand(
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

    await runHerdrCommand(
      buildAgentStartArguments(agentName, launchConfiguration, paneId, agentArguments),
      projectRoot,
      signal,
    );

    if (windowsLaunch) {
      // The pane-local shim transports the long prompt by file. Herdr sees the
      // shim as started before the delegated Kilo TUI is ready for submission.
      await runHerdrCommand(
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
      await runHerdrCommand(
        ["agent", "send-keys", agentName, "enter"],
        projectRoot,
        signal,
      );
      await runHerdrCommand(
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
      attemptHistory: run.workers[kind].attemptHistory,
      sourceCheckpoint,
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
    const raw = await runHerdrCommand(
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

  await runHerdrCommand(
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
  expected?: WorkerResourceExpectation,
): Promise<number> {
  const agent = await getAgentIdentity(agentName, projectRoot, signal);

  if (!agent) {
    throw new Error(`Herdr agent ${agentName} was not found.`);
  }

  if (expected) {
    const { run, worker } = expected;
    if (
      worker.agentName !== agentName ||
      worker.attempt < 1 ||
      !worker.tabId ||
      !worker.paneId ||
      agent.tabId !== worker.tabId ||
      agent.paneId !== worker.paneId ||
      agent.workspaceId !== run.herdrWorkspaceId ||
      !samePath(agent.cwd, projectRoot)
    ) {
      throw new Error(
        `Refusing to prompt ${agentName}: its current Herdr identity does not match workflow ${run.id} attempt ${worker.attempt}.`,
      );
    }
  }

  const requiredTransitions = agent.state === "working" ? 2 : 1;
  await submitPrompt(agentName, message, projectRoot, signal);
  return agent.stateChangeSeq + requiredTransitions;
}

export interface WorkerResourceExpectation {
  run: WorkflowRun;
  worker: WorkerRecord;
}

export interface WorkerErrorRecordOptions {
  definition?: WorkerDefinition;
  sourceCheckpoint?: SourceCheckpoint;
  attemptHistory?: WorkerAttemptEvidence[];
}

export function workerErrorRecord(
  kind: WorkerKind,
  attempt: number,
  error: unknown,
  options: WorkerErrorRecordOptions = {},
): WorkerRecord {
  if (error instanceof WorkerLaunchError) {
    return {
      ...error.worker,
      roleId: kind,
      definition: options.definition,
      attemptHistory: options.attemptHistory,
      sourceCheckpoint: options.sourceCheckpoint,
    };
  }

  return {
    kind,
    roleId: kind,
    attempt,
    definition: options.definition,
    attemptHistory: options.attemptHistory,
    sourceCheckpoint: options.sourceCheckpoint,
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

  await runHerdrCommand(
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
  await runHerdrCommand(
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

  if (worker.attempt < 1) {
    throw new Error(
      `Refusing to close tab ${worker.tabId}: workflow attempt ${worker.attempt} is not an active attempt.`,
    );
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
  } else {
    throw new Error(
      `Refusing to close tab ${worker.tabId}: the workflow worker identity is incomplete.`,
    );
  }

  try {
    await runHerdrCommand(["tab", "close", worker.tabId], projectRoot, signal);
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
      await runHerdrCommand(["tab", "get", tabId], projectRoot, signal),
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
      await runHerdrCommand(["agent", "get", agentName], projectRoot, signal),
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

export function buildAgentStartArguments(
  agentName: string,
  launchConfiguration: WorkerLaunchConfiguration,
  paneId: string,
  launchArguments = launchConfiguration.launchArguments,
): string[] {
  return [
    "agent",
    "start",
    agentName,
    "--kind",
    launchConfiguration.herdrKind,
    "--pane",
    paneId,
    "--",
    ...launchArguments,
  ];
}

export function buildWorkerPrompt(
  run: WorkflowRun,
  kind: WorkerKind,
  additionalInstruction?: string,
): string {
  const definition = run.workers[kind].definition;
  if (!definition) {
    throw new Error(`Workflow worker ${kind} has no persisted definition.`);
  }

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

METHODOLOGY
${definition.skill.body}

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

    return await runHerdrCommand(
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
    await runHerdrCommand(["tab", "close", tabId], projectRoot);
    return undefined;
  } catch (error) {
    return isMissingResourceError(error) ? undefined : error;
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
    const taskCardName = path.basename(
      run.taskCardPath,
      path.extname(run.taskCardPath),
    );

    const taskId = taskCardName.match(/^TASK-\d+/i);

    if (taskId) {
      return taskId[0].toUpperCase();  
    }
  }

  const cleaned = run.task
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const charLimit = 10;
  return cleaned.length <= charLimit ? cleaned : `${cleaned.slice(0, charLimit)}...`;
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
