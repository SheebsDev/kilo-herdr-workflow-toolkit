import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { HerdrCoordinatorNotifier } from "./coordinator-notifier.ts";
import type { HerdrCommandRunner } from "./herdr-command.ts";
import type {
  CoordinatorNotificationBatch,
} from "./workflow-contracts.ts";

test("delivers through the exact pane for every supported coordinator kind", async () => {
  for (const coordinatorKind of ["kilo", "claude", "codex"] as const) {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
    const calls: string[][] = [];

    try {
      const notifier = new HerdrCoordinatorNotifier(
        createRunner(projectRoot, coordinatorKind, calls),
      );

      await notifier.notify(createBatch(projectRoot, coordinatorKind));

      assert.deepEqual(calls, [
        ["pane", "get", "pane-origin"],
        ["agent", "prompt", "pane-origin", "Wake one\n\nWake two"],
      ]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  }
});

test("canonicalizes pane paths through symlinks before delivery", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
  const otherRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-other-"));
  const linkedPath = path.join(projectRoot, "linked-root");
  const calls: string[][] = [];

  try {
    await symlink(
      otherRoot,
      linkedPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    const notifier = new HerdrCoordinatorNotifier(
      createRunner(projectRoot, "kilo", calls, {
        foreground_cwd: linkedPath,
      }),
    );

    await assert.rejects(
      notifier.notify(createBatch(projectRoot, "kilo")),
      /project path mismatch/,
    );
    assert.deepEqual(calls, [["pane", "get", "pane-origin"]]);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
    await rm(otherRoot, { force: true, recursive: true });
  }
});

test("refuses missing panes without issuing a prompt", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
  const calls: string[][] = [];

  try {
    const notifier = new HerdrCoordinatorNotifier(async (args) => {
      calls.push(args);
      throw new Error("pane pane-origin not found");
    });

    await assert.rejects(
      notifier.notify(createBatch(projectRoot, "kilo")),
      /was not found.*not delivered/,
    );
    assert.deepEqual(calls, [["pane", "get", "pane-origin"]]);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

for (const [label, paneChange, expectedError] of [
  ["workspace", { workspace_id: "other-workspace" }, /workspace mismatch/],
  ["kind", { agent: "codex" }, /kind mismatch/],
  ["cwd", { foreground_cwd: path.resolve(tmpdir()) }, /project path mismatch/],
] as const) {
  test(`refuses a ${label} identity mismatch without prompting`, async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
    const calls: string[][] = [];

    try {
      const notifier = new HerdrCoordinatorNotifier(
        createRunner(projectRoot, "kilo", calls, paneChange),
      );

      await assert.rejects(
        notifier.notify(createBatch(projectRoot, "kilo")),
        expectedError,
      );
      assert.deepEqual(calls, [["pane", "get", "pane-origin"]]);
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
}

test("refuses malformed Herdr output with bounded diagnostics", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
  const raw = "x".repeat(100_000);

  try {
    const notifier = new HerdrCoordinatorNotifier(async () => raw);
    await assert.rejects(
      notifier.notify(createBatch(projectRoot, "kilo")),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("malformed JSON") &&
        error.message.includes("Herdr output truncated.") &&
        error.message.length < 10_000,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("bounds Herdr identity values included in mismatch diagnostics", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
  const oversizedWorkspace = "w".repeat(100_000);

  try {
    const notifier = new HerdrCoordinatorNotifier(
      createRunner(projectRoot, "kilo", [], {
        workspace_id: oversizedWorkspace,
      }),
    );

    await assert.rejects(
      notifier.notify(createBatch(projectRoot, "kilo")),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes("workspace mismatch") &&
        error.message.includes("Herdr output truncated.") &&
        error.message.length < 10_000,
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("retains prompt failures and passes cancellation to Herdr inspection", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-notifier-"));
  const calls: string[][] = [];

  try {
    const promptFailure = new HerdrCoordinatorNotifier(
      createRunner(projectRoot, "kilo", calls, {}, new Error("prompt failed")),
    );
    await assert.rejects(
      promptFailure.notify(createBatch(projectRoot, "kilo")),
      /Could not deliver.*prompt failed/,
    );
    assert.deepEqual(calls, [
      ["pane", "get", "pane-origin"],
      ["agent", "prompt", "pane-origin", "Wake one\n\nWake two"],
    ]);

    const controller = new AbortController();
    const cancellationCalls: string[][] = [];
    const cancellation = new HerdrCoordinatorNotifier(
      async (args, _cwd, signal) => {
        cancellationCalls.push(args);
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("cancelled")),
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    );
    const pending = cancellation.notify(
      createBatch(projectRoot, "kilo"),
      controller.signal,
    );
    controller.abort(new Error("cancelled"));

    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(cancellationCalls, [["pane", "get", "pane-origin"]]);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

function createBatch(
  projectRoot: string,
  coordinatorKind: "kilo" | "claude" | "codex",
): CoordinatorNotificationBatch {
  return {
    projectRoot,
    origin: {
      workspaceId: "workspace-origin",
      paneId: "pane-origin",
      coordinatorKind,
    },
    notifications: [
      { sequence: 1, message: "Wake one" },
      { sequence: 2, message: "Wake two" },
    ],
  };
}

function createRunner(
  projectRoot: string,
  coordinatorKind: "kilo" | "claude" | "codex",
  calls: string[][],
  paneChange: Record<string, unknown> = {},
  promptError?: Error,
): HerdrCommandRunner {
  return async (args, cwd) => {
    calls.push(args);
    assert.equal(cwd, projectRoot);

    if (args[0] === "pane") {
      return JSON.stringify({
        result: {
          pane: {
            pane_id: "pane-origin",
            workspace_id: "workspace-origin",
            foreground_cwd: projectRoot,
            agent: coordinatorKind,
            ...paneChange,
          },
        },
      });
    }

    if (promptError) {
      throw promptError;
    }

    return JSON.stringify({ result: { accepted: true } });
  };
}
