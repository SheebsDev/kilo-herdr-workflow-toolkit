import { createHash } from "node:crypto";
import { spawn } from "node:child_process";

import type { SourceCheckpoint } from "./model.ts";

const GIT_TIMEOUT_MS = 120_000;

const DIFF_ARGS = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--full-index",
  "--binary",
] as const;

export class SourceCheckpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SourceCheckpointError";
  }
}

export async function captureSourceCheckpoint(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<SourceCheckpoint> {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"], projectRoot, signal);

    const headId = await captureHeadId(projectRoot, signal);
    const [stagedDiff, unstagedTrackedDiff] = await Promise.all([
      runGit([...DIFF_ARGS, "--cached", "--"], projectRoot, signal),
      runGit([...DIFF_ARGS, "--"], projectRoot, signal),
    ]);

    return {
      headId,
      stagedDiffSha256: hashBytes(stagedDiff),
      unstagedTrackedDiffSha256: hashBytes(unstagedTrackedDiff),
      capturedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Source checkpoint capture was aborted.");
    }

    throw new SourceCheckpointError(
      `Could not capture the tracked source checkpoint for ${projectRoot}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function sourceCheckpointsEqual(
  left: SourceCheckpoint,
  right: SourceCheckpoint,
): boolean {
  return (
    left.headId === right.headId &&
    left.stagedDiffSha256 === right.stagedDiffSha256 &&
    left.unstagedTrackedDiffSha256 === right.unstagedTrackedDiffSha256
  );
}

async function captureHeadId(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const output = await runGit(
      ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
      projectRoot,
      signal,
    );
    // rev-parse validates the reference syntax; cat-file confirms the commit
    // object actually exists before its identity is persisted.
    await runGit(["cat-file", "-e", "HEAD^{commit}"], projectRoot, signal);
    const headId = output.toString("utf8").trim();
    return headId || undefined;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error("Source checkpoint capture was aborted.");
    }

    if (
      isMissingHeadError(error) &&
      (await isUnbornHead(projectRoot, signal))
    ) {
      // An unborn repository has no HEAD yet. Its staged and worktree diffs are
      // still meaningful checkpoints, so only the optional identity is absent.
      return undefined;
    }

    throw error;
  }
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function runGit(
  args: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
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
        resolve(Buffer.concat(stdout));
      }
    };

    timeout = setTimeout(() => {
      child.kill();
      finish(
        new SourceCheckpointError(
          `Git did not finish within ${GIT_TIMEOUT_MS / 1000} seconds.`,
        ),
      );
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) {
        finish();
        return;
      }

      const details = Buffer.concat(stderr).toString("utf8").trim();
      finish(
        new GitCommandError(
          code,
          details,
          [
            `Git exited with code ${code ?? "unknown"} while capturing the source checkpoint.`,
            details,
          ]
            .filter(Boolean)
            .join(" "),
        ),
      );
    });
  });
}

class GitCommandError extends SourceCheckpointError {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(exitCode: number | null, stderr: string, message: string) {
    super(message);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

function isMissingHeadError(error: unknown): boolean {
  if (!(error instanceof GitCommandError)) {
    return false;
  }

  return (
    (error.exitCode === 1 || error.exitCode === 128) &&
    (error.stderr === "" ||
      /needed a single revision|unknown revision.*HEAD|bad default revision.*HEAD/i.test(
        error.stderr,
      ))
  );
}

async function isUnbornHead(
  projectRoot: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const headRef = (await runGit(
      ["symbolic-ref", "--quiet", "HEAD"],
      projectRoot,
      signal,
    ))
      .toString("utf8")
      .trim();

    if (!headRef) {
      return false;
    }

    await runGit(
      ["show-ref", "--verify", "--quiet", headRef],
      projectRoot,
      signal,
    );
    return false;
  } catch (error) {
    if (error instanceof GitCommandError && error.exitCode === 1) {
      return true;
    }

    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
