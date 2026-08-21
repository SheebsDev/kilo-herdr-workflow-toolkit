import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  WORKFLOW_TOOL_DESCRIPTORS,
} from "../core/workflow-tool-descriptors.ts";
import type { ProjectContext } from "../core/workflow-contracts.ts";
import {
  createWorkflowMcpServer,
  connectWorkflowMcpServer,
  workflowToolNames,
  type WorkflowMcpService,
} from "./workflow-server.ts";

test("MCP advertises the same five canonical tools and trusted-context-free schemas", async () => {
  const service = createService();
  const started = createWorkflowMcpServer({
    service,
    context: createContext(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await Promise.all([
      client.connect(clientTransport),
      started.server.connect(serverTransport),
    ]);
    const result = await client.listTools();
    assert.deepEqual(
      result.tools.map((tool) => tool.name),
      workflowToolNames(),
    );

    for (const name of workflowToolNames()) {
      const tool = result.tools.find((candidate) => candidate.name === name)!;
      const descriptor = WORKFLOW_TOOL_DESCRIPTORS[name];
      assert.equal(tool.description, descriptor.description);
      assert.deepEqual(stripSchemaMarker(tool.inputSchema), descriptor.inputSchema);
      assert.doesNotMatch(JSON.stringify(tool.inputSchema), /projectRoot|paneId|workspaceId|socket/i);
    }
  } finally {
    await started.close();
    await client.close();
  }
});

test("MCP calls share the service data and request cancellation signal", async () => {
  const calls: Array<{ operation: string; signal: AbortSignal }> = [];
  const service = createService(calls);
  const started = createWorkflowMcpServer({
    service,
    context: createContext(),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });

  try {
    await Promise.all([
      client.connect(clientTransport),
      started.server.connect(serverTransport),
    ]);

    const result = await client.callTool({
      name: "workflow_status",
      arguments: { runId: "run-status", worker: "tests", includeOutput: true },
    });
    assert.deepEqual(result.structuredContent, {
      runId: "run-status",
      state: "reviewing",
    });
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    assert.equal(calls.at(-1)?.operation, "status");
    assert.equal(calls.at(-1)?.signal.aborted, false);

    for (const [name, args, operation] of [
      ["workflow_send", { worker: "tests", message: "Report now." }, "send"],
      ["workflow_stop", { worker: "tests" }, "stop"],
      ["workflow_retry", { worker: "tests" }, "retry"],
    ] as const) {
      const operationResult = await client.callTool({ name, arguments: args });
      assert.equal(operationResult.isError, undefined);
      assert.equal(calls.at(-1)?.operation, operation);
    }

    const abort = new AbortController();
    const pending = client.callTool(
      { name: "workflow_start", arguments: { task: "wait for cancellation" } },
      undefined,
      { signal: abort.signal },
    );
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort(new Error("cancelled by test"));
    await assert.rejects(pending, /cancelled|aborted|closed/i);
    assert.equal(calls.at(-1)?.operation, "start");
    assert.equal(calls.at(-1)?.signal.aborted, true);
  } finally {
    await started.close();
    await client.close();
  }
});

test("stdio transport covers every operation, cancellation, and startup recovery", async () => {
  const calls: Array<{ operation: string; signal: AbortSignal }> = [];
  let recovered = false;
  const service = createService(calls, () => {
    recovered = true;
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const outputLines: string[] = [];
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => outputLines.push(chunk));
  const lineIterator = createInterface({ input: output })[Symbol.asyncIterator]();
  const started = await connectWorkflowMcpServer({
    service,
    context: createContext(),
    stdin: input,
    stdout: output,
  });

  try {
    writeRequest(input, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    });
    const initialize = await nextJson(lineIterator);
    assert.equal(initialize.id, 1);
    assert.equal(initialize.error, undefined);
    writeRequest(input, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    writeRequest(input, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const listed = await nextJson(lineIterator);
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      workflowToolNames(),
    );

    const operations = [
      ["workflow_status", { runId: "run-status" }],
      ["workflow_send", { worker: "tests", message: "Report now." }],
      ["workflow_stop", { worker: "tests" }],
      ["workflow_retry", { worker: "tests" }],
    ] as const;
    for (const [index, [name, args]] of operations.entries()) {
      writeRequest(input, {
        jsonrpc: "2.0",
        id: index + 3,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const response = await nextJson(lineIterator);
      assert.equal(response.id, index + 3);
      assert.equal(response.error, undefined);
      assert.equal(response.result.structuredContent.runId, `run-${name.slice(9)}`);
    }

    writeRequest(input, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "workflow_start", arguments: { task: "cancel me" } },
    });
    await waitFor(() => calls.at(-1)?.operation === "start");
    writeRequest(input, {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7, reason: "cancelled by test" },
    });
    await waitFor(() => calls.at(-1)?.signal.aborted === true);
    assert.equal(recovered, true);
    assert.deepEqual(
      calls.map(({ operation }) => operation),
      ["status", "send", "stop", "retry", "start"],
    );
  } finally {
    await started.close();
    await lineIterator.return?.();
  }

  assert.ok(outputLines.every((chunk) => chunk.split("\n").filter(Boolean).every((line) => {
    JSON.parse(line);
    return true;
  })));
});

test("MCP transport close and failed recovery await service disposal", async () => {
  let disposed = 0;
  const service = createService([], undefined, () => {
    disposed += 1;
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const started = await connectWorkflowMcpServer({
    service,
    context: createContext(),
    stdin: input,
    stdout: output,
  });

  await started.server.close();
  await waitFor(() => disposed === 1);
  await started.close();
  assert.equal(disposed, 1);

  let failedRecoveryDisposals = 0;
  const failedService = createService([], undefined, () => {
    failedRecoveryDisposals += 1;
  });
  failedService.recover = async () => {
    throw new Error("recovery failed");
  };
  await assert.rejects(
    connectWorkflowMcpServer({
      service: failedService,
      context: createContext(),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    }),
    /recovery failed/,
  );
  assert.equal(failedRecoveryDisposals, 1);
});

function createService(
  calls: Array<{ operation: string; signal: AbortSignal }> = [],
  onRecover?: () => void,
  onDispose?: () => void,
): WorkflowMcpService {
  return {
    start: async ({ context }) => {
      calls.push({ operation: "start", signal: context.signal });
      if (context.signal.aborted) {
        throw context.signal.reason;
      }
      await new Promise<void>((resolve, reject) => {
        context.signal.addEventListener("abort", () => reject(context.signal.reason), { once: true });
      });
      return { runId: "run-start", state: "reviewing", workers: {} };
    },
    status: async ({ context }) => {
      calls.push({ operation: "status", signal: context.signal });
      return { runId: "run-status", state: "reviewing" };
    },
    send: async ({ context }) => {
      calls.push({ operation: "send", signal: context.signal });
      return { runId: "run-send", worker: "tests", state: "reviewing" };
    },
    stop: async ({ context }) => {
      calls.push({ operation: "stop", signal: context.signal });
      return { runId: "run-stop", worker: "tests", state: "stopped" };
    },
    retry: async ({ context }) => {
      calls.push({ operation: "retry", signal: context.signal });
      return {
        runId: "run-retry",
        worker: "tests",
        state: "reviewing",
        message: "retry",
        workerRecord: {} as never,
        workerResult: {} as never,
      };
    },
    recover: async () => {
      onRecover?.();
      return { runIds: [] };
    },
    dispose: async () => {
      onDispose?.();
    },
  };
}

function writeRequest(input: PassThrough, value: Record<string, unknown>): void {
  input.write(`${JSON.stringify(value)}\n`);
}

async function nextJson(
  iterator: AsyncIterator<string>,
): Promise<Record<string, any>> {
  const next = await iterator.next();
  assert.equal(next.done, false);
  return JSON.parse(next.value!);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the MCP request state.");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function createContext(): ProjectContext {
  return {
    projectRoot: "C:\\workflow-project",
    origin: {
      workspaceId: "workspace-test",
      paneId: "pane-test",
      coordinatorKind: "claude",
    },
    signal: new AbortController().signal,
  };
}

function stripSchemaMarker(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...withoutMarker } = schema;
  return withoutMarker;
}
