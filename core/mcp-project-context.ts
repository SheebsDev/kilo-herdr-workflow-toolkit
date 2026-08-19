import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

import { isAgentKind } from "./model.ts";
import type { AgentKind } from "./model.ts";
import type { ProjectContext } from "./workflow-contracts.ts";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

/** Environment variable used by an MCP entrypoint to identify its coordinator. */
export const MCP_COORDINATOR_KIND_ENV = "WORKFLOW_COORDINATOR_KIND";

export interface McpProjectContextOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

/**
 * Resolve trusted host state for an MCP coordinator.
 *
 * The tool caller cannot supply any of these values. The MCP process inherits
 * them from its host, while the project root is derived from a host variable
 * or the process working directory.
 */
export async function resolveMcpProjectContext(
  options: McpProjectContextOptions = {},
): Promise<ProjectContext> {
  const env = options.env ?? process.env;
  const signal = options.signal ?? new AbortController().signal;
  throwIfAborted(signal);

  const cwd = await canonicalDirectory(options.cwd ?? process.cwd(), "MCP cwd");
  const configuredProject = nonEmptyEnvironmentValue(
    env.CLAUDE_PROJECT_DIR,
    "CLAUDE_PROJECT_DIR",
  );
  const configuredRoot = configuredProject
    ? await resolveGitProjectRoot(configuredProject, "CLAUDE_PROJECT_DIR", signal)
    : undefined;
  const cwdRoot = await resolveGitProjectRoot(cwd, "MCP cwd", signal);

  if (configuredRoot && !samePath(configuredRoot, cwdRoot)) {
    throw new Error(
      [
        "CLAUDE_PROJECT_DIR and the MCP working directory resolve to different Git repositories.",
        `CLAUDE_PROJECT_DIR resolves to ${configuredRoot}; MCP cwd resolves to ${cwdRoot}.`,
        "Start the MCP server from the intended repository or unset CLAUDE_PROJECT_DIR.",
      ].join(" "),
    );
  }

  const origin = resolveHerdrOrigin(env);
  return {
    projectRoot: configuredRoot ?? cwdRoot,
    origin,
    signal,
  };
}

export async function resolveGitProjectRoot(
  startPath: string,
  source: string = "project path",
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const directory = await canonicalDirectory(startPath, source);

  let output: { stdout: string };
  try {
    output = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--show-toplevel"],
      {
        cwd: directory,
        env: process.env,
        shell: false,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        signal,
      },
    );
  } catch (error) {
    if (signal?.aborted) {
      throwIfAborted(signal);
    }
    throw new Error(
      [
        `${source} is not inside a usable Git repository.`,
        `Git could not resolve a repository root from ${directory}.`,
        `Run this MCP server from a Git repository or set CLAUDE_PROJECT_DIR to one.`,
        `Details: ${errorMessage(error)}`,
      ].join(" "),
      { cause: error },
    );
  }

  throwIfAborted(signal);
  const reportedRoot = output.stdout.trim();
  if (!reportedRoot) {
    throw new Error(
      `${source} did not produce a Git repository root. Check the repository and Git installation before starting the MCP server.`,
    );
  }

  const root = await canonicalDirectory(reportedRoot, "Git repository root");
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `Git returned a repository root outside ${source}. Refusing to use an untrusted project path. Check Git worktree configuration.`,
    );
  }

  return root;
}

function resolveHerdrOrigin(env: NodeJS.ProcessEnv): ProjectContext["origin"] {
  if (env.HERDR_ENV !== "1") {
    throw new Error(
      "The MCP workflow requires a coordinator running inside Herdr (HERDR_ENV=1). Launch the MCP client from a Herdr pane.",
    );
  }

  const socketPath = requiredEnvironmentValue(
    env.HERDR_SOCKET_PATH,
    "HERDR_SOCKET_PATH",
    "Ensure the Herdr socket is inherited by the MCP server.",
  );
  validateEnvironmentValue(socketPath, "HERDR_SOCKET_PATH");

  const paneId = requiredEnvironmentValue(
    env.HERDR_PANE_ID,
    "HERDR_PANE_ID",
    "Start the MCP server from the intended Herdr pane.",
  );
  validateEnvironmentValue(paneId, "HERDR_PANE_ID");

  const workspaceId = requiredEnvironmentValue(
    env.HERDR_WORKSPACE_ID,
    "HERDR_WORKSPACE_ID",
    "Start the MCP server from a Herdr workspace.",
  );
  validateEnvironmentValue(workspaceId, "HERDR_WORKSPACE_ID");

  const coordinatorKind = requiredEnvironmentValue(
    env[MCP_COORDINATOR_KIND_ENV],
    MCP_COORDINATOR_KIND_ENV,
    "Configure the MCP entrypoint with kilo, claude, or codex as its coordinator kind.",
  );
  if (!isAgentKind(coordinatorKind)) {
    throw new Error(
      `${MCP_COORDINATOR_KIND_ENV} must be one of kilo, claude, or codex; received "${coordinatorKind}". Correct the MCP server environment before starting it.`,
    );
  }

  return {
    workspaceId,
    paneId,
    coordinatorKind,
  };
}

async function canonicalDirectory(value: string, source: string): Promise<string> {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !path.isAbsolute(value) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `${source} must be an existing absolute directory path. Check the MCP host project configuration.`,
    );
  }

  const resolved = path.resolve(value);
  try {
    const details = await stat(resolved);
    if (!details.isDirectory()) {
      throw new Error(`${source} is not a directory.`);
    }
    return await realpath(resolved);
  } catch (error) {
    if (error instanceof Error && error.message === `${source} is not a directory.`) {
      throw error;
    }
    throw new Error(
      `${source} must be an existing absolute directory path. Check the MCP host project configuration. Details: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

function nonEmptyEnvironmentValue(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim().length === 0) {
    throw new Error(
      `${name} is set but empty. Unset it or point it to the intended Git repository before starting the MCP server.`,
    );
  }
  return value.trim();
}

function requiredEnvironmentValue(
  value: string | undefined,
  name: string,
  action: string,
): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is missing. ${action}`);
  }
  return normalized;
}

function validateEnvironmentValue(value: string, name: string): void {
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(
      `${name} contains control characters and is malformed. Correct the inherited Herdr environment before starting the MCP server.`,
    );
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("MCP project context resolution was aborted.");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
