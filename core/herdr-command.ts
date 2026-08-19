import { spawn } from "node:child_process";

const HERDR_TIMEOUT_MS = 120_000;
const MAX_HERDR_OUTPUT_LENGTH = 2 * 1024 * 1024;
const MAX_ERROR_OUTPUT_LENGTH = 4 * 1024;

export type HerdrCommandRunner = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number | null,
) => Promise<string>;

export async function runHerdrCommand(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number | null = HERDR_TIMEOUT_MS,
): Promise<string> {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.HERDR_BIN_PATH || "herdr", args, {
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

    const appendOutput = (current: string, chunk: string): string => {
      const combined = current + chunk;

      if (combined.length > MAX_HERDR_OUTPUT_LENGTH) {
        child.kill();
        finish(new Error("Herdr returned more output than the workflow accepts."));
        return current;
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
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = appendOutput(stderr, chunk);
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
            boundErrorOutput(stderr),
            boundErrorOutput(stdout),
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

function boundErrorOutput(output: string): string {
  if (output.length <= MAX_ERROR_OUTPUT_LENGTH) {
    return output.trim();
  }

  return `${output.slice(0, MAX_ERROR_OUTPUT_LENGTH)}\n[Herdr output truncated.]`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Workflow operation was aborted.");
  }
}
