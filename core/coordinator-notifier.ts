import { realpath } from "node:fs/promises";
import * as path from "node:path";

import { runHerdrCommand } from "./herdr-command.ts";
import type { HerdrCommandRunner } from "./herdr-command.ts";
import { isAgentKind } from "./model.ts";
import type { AgentKind } from "./model.ts";
import type {
  CoordinatorNotificationBatch,
  CoordinatorNotifier,
} from "./workflow-contracts.ts";

const MAX_DIAGNOSTIC_OUTPUT_LENGTH = 4 * 1024;

interface PaneIdentity {
  paneId: string;
  workspaceId: string;
  projectPath: string;
  coordinatorKind: AgentKind;
}

export class HerdrCoordinatorNotifier implements CoordinatorNotifier {
  private readonly runCommand: HerdrCommandRunner;

  constructor(runCommand: HerdrCommandRunner = runHerdrCommand) {
    this.runCommand = runCommand;
  }

  async notify(
    batch: CoordinatorNotificationBatch,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);

    const pane = await this.inspectOriginPane(batch, signal);
    throwIfAborted(signal);

    const message = batch.notifications
      .map((notification) => notification.message)
      .join("\n\n");

    if (!message) {
      throw new Error("Cannot deliver an empty coordinator notification batch.");
    }

    try {
      await this.runCommand(
        ["agent", "prompt", pane.paneId, message],
        batch.projectRoot,
        signal,
      );
    } catch (error) {
      throw new Error(
        `Could not deliver the coordinator wake to pane "${boundDiagnostic(pane.paneId)}": ${boundDiagnostic(errorMessage(error))}`,
        { cause: error },
      );
    }
  }

  private async inspectOriginPane(
    batch: CoordinatorNotificationBatch,
    signal?: AbortSignal,
  ): Promise<PaneIdentity> {
    let raw: string;

    try {
      raw = await this.runCommand(
        ["pane", "get", batch.origin.paneId],
        batch.projectRoot,
        signal,
      );
    } catch (error) {
      const detail = errorMessage(error);
      if (/not found|does not exist|unknown pane/i.test(detail)) {
        throw new Error(
          `Coordinator pane "${boundDiagnostic(batch.origin.paneId)}" was not found; the wake was not delivered.`,
          { cause: error },
        );
      }

      throw new Error(
        `Could not inspect coordinator pane "${boundDiagnostic(batch.origin.paneId)}": ${boundDiagnostic(detail)}`,
        { cause: error },
      );
    }

    const pane = parsePaneIdentity(raw, batch.origin.paneId);
    await validatePaneIdentity(pane, batch);
    return pane;
  }
}

function parsePaneIdentity(raw: string, expectedPaneId: string): PaneIdentity {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Herdr pane inspection returned malformed JSON: ${boundDiagnostic(raw)}`,
      { cause: error },
    );
  }

  const pane = nestedRecord(parsed, "result", "pane");
  if (!pane) {
    throw new Error("Herdr pane inspection did not include result.pane.");
  }

  const paneId = requiredString(pane.pane_id, "pane_id");
  const workspaceId = requiredString(pane.workspace_id, "workspace_id");
  const projectPath = requiredString(
    pane.foreground_cwd ?? pane.cwd,
    "foreground_cwd or cwd",
  );
  const coordinatorKind = requiredString(pane.agent, "agent");

  if (!isAgentKind(coordinatorKind)) {
    throw new Error(
      `Herdr pane "${boundDiagnostic(expectedPaneId)}" reported unsupported coordinator kind "${boundDiagnostic(coordinatorKind)}".`,
    );
  }

  return { paneId, workspaceId, projectPath, coordinatorKind };
}

async function validatePaneIdentity(
  pane: PaneIdentity,
  batch: CoordinatorNotificationBatch,
): Promise<void> {
  const expected = batch.origin;

  if (pane.paneId !== expected.paneId) {
    throw new Error(
      `Coordinator pane identity mismatch: expected pane "${boundDiagnostic(expected.paneId)}", Herdr returned "${boundDiagnostic(pane.paneId)}".`,
    );
  }

  if (pane.workspaceId !== expected.workspaceId) {
    throw new Error(
      `Coordinator pane "${boundDiagnostic(expected.paneId)}" has workspace mismatch: expected "${boundDiagnostic(expected.workspaceId)}", got "${boundDiagnostic(pane.workspaceId)}".`,
    );
  }

  if (pane.coordinatorKind !== expected.coordinatorKind) {
    throw new Error(
      `Coordinator pane "${boundDiagnostic(expected.paneId)}" has kind mismatch: expected "${boundDiagnostic(expected.coordinatorKind)}", got "${boundDiagnostic(pane.coordinatorKind)}".`,
    );
  }

  let expectedPath: string;
  let actualPath: string;
  try {
    [expectedPath, actualPath] = await Promise.all([
      realpath(batch.projectRoot),
      realpath(pane.projectPath),
    ]);
  } catch (error) {
    throw new Error(
      `Could not resolve the real project path for coordinator pane "${boundDiagnostic(expected.paneId)}": ${boundDiagnostic(errorMessage(error))}`,
      { cause: error },
    );
  }

  if (!samePath(expectedPath, actualPath)) {
    throw new Error(
      `Coordinator pane "${boundDiagnostic(expected.paneId)}" has project path mismatch: expected "${boundDiagnostic(expectedPath)}", got "${boundDiagnostic(actualPath)}".`,
    );
  }
}

function nestedRecord(
  value: unknown,
  ...keys: string[]
): Record<string, unknown> | undefined {
  let current = value;

  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }

  return isRecord(current) ? current : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Herdr pane inspection is missing a valid ${field}.`);
  }

  return value;
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);

  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function boundDiagnostic(value: string): string {
  if (value.length <= MAX_DIAGNOSTIC_OUTPUT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_DIAGNOSTIC_OUTPUT_LENGTH)}\n[Herdr output truncated.]`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Workflow operation was aborted.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
