import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";

test("stdio MCP framing stays on stdout and worker processes advertise no tools", async () => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", path.resolve("mcp/server.ts")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_ROLE: "tests",
        WORKFLOW_RUN_ID: "run-worker",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const stdout = collectLines(child.stdout);
  const stderr = collectText(child.stderr);

  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    })}\n`);
    const initialize = await stdout.next();
    assert.equal(initialize.value.id, 1);
    assert.equal(initialize.value.error, undefined);

    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
    const tools = await stdout.next();
    assert.equal(tools.value.id, 2);
    assert.equal(tools.value.error.code, -32601);
    assert.equal(stderr.value.includes("stdout"), false);
  } finally {
    child.stdin.end();
    child.kill();
    await onceExit(child);
  }

  for (const line of stdout.lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
});

test("startup failures are diagnostic-only and never corrupt MCP stdout", async () => {
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", path.resolve("mcp/server.ts")],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        WORKFLOW_ROLE: undefined,
        WORKFLOW_RUN_ID: undefined,
        HERDR_ENV: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = collectText(child.stdout);
  const stderr = collectText(child.stderr);
  await onceExit(child);

  assert.equal(stdout.value, "");
  assert.match(stderr.value, /requires a coordinator running inside Herdr/);
});

function collectLines(stream: NodeJS.ReadableStream) {
  let buffer = "";
  const lines: string[] = [];
  const pending: string[] = [];
  let resolveNext: ((result: IteratorResult<Record<string, any>>) => void) | undefined;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      lines.push(line);
      if (resolveNext) {
        resolveNext({ done: false, value: JSON.parse(line) });
        resolveNext = undefined;
      } else {
        pending.push(line);
      }
    }
  });

  return {
    lines,
    next: () => {
      if (pending.length > 0) {
        return Promise.resolve({
          done: false,
          value: JSON.parse(pending.shift()!),
        });
      }
      return new Promise<IteratorResult<Record<string, any>>>((resolve) => {
        resolveNext = resolve;
      });
    },
  };
}

function collectText(stream: NodeJS.ReadableStream) {
  const chunks: string[] = [];
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => chunks.push(chunk));
  return {
    get value() {
      return chunks.join("");
    },
  };
}

async function onceExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
