import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";

import { createRun } from "./run-store.ts";
import {
  assertProjectContext,
  assertWorkflowOriginAccess,
  isJsonValue,
} from "./workflow-contracts.ts";
import type { ProjectContext } from "./workflow-contracts.ts";
import { isWorkflowRun } from "./model.ts";

test("trusted contexts create canonical v2 origins for every coordinator kind", () => {
  for (const coordinatorKind of ["kilo", "claude", "codex"] as const) {
    const context = createContext(coordinatorKind);
    const run = createRun({
      task: `Create a ${coordinatorKind} run`,
      context,
    });

    assert.deepEqual(run.origin, context.origin);
    assert.equal(run.herdrWorkspaceId, context.origin.workspaceId);
    assert.equal(run.originSessionId, context.origin.sessionId);
    assert.equal(isWorkflowRun(run), true);
  }
});

test("run creation requires a real pane and never falls back to session identity", () => {
  const context = createContext("kilo");
  const withoutPane = {
    ...context,
    origin: { ...context.origin, paneId: "" },
  } as ProjectContext;

  assert.throws(
    () => createRun({ task: "Reject missing origin", context: withoutPane }),
    /valid Herdr origin/,
  );
});

test("conflicting v2 origin aliases are invalid while matching aliases remain readable", () => {
  const run = createRun({
    task: "Validate origin aliases",
    context: createContext("kilo"),
  });

  assert.equal(isWorkflowRun(run), true);

  const conflictingWorkspace = {
    ...run,
    herdrWorkspaceId: "different-workspace",
  };
  const conflictingSession = {
    ...run,
    originSessionId: "different-session",
  };

  assert.equal(isWorkflowRun(conflictingWorkspace), false);
  assert.equal(isWorkflowRun(conflictingSession), false);
  assert.equal(
    isWorkflowRun({
      ...run,
      origin: { ...run.origin, sessionId: "" },
    }),
    false,
  );
});

test("only explicit run-id status permits cross-origin inspection", () => {
  const origin = createContext("kilo");
  const other = createContext("claude");
  const runOrigin = origin.origin;

  assert.doesNotThrow(() =>
    assertWorkflowOriginAccess("status", other, runOrigin, "run-id"),
  );
  assert.throws(
    () => assertWorkflowOriginAccess("status", other, runOrigin),
    /not the workflow origin pane/,
  );

  for (const operation of ["send", "stop", "retry", "recovery"] as const) {
    assert.throws(
      () => assertWorkflowOriginAccess(operation, other, runOrigin, "run-id"),
      /not the workflow origin pane/,
    );
  }

  assert.doesNotThrow(() =>
    assertWorkflowOriginAccess("send", origin, runOrigin, "run-id"),
  );
});

test("contract results are plain JSON data and reject executable values", () => {
  const result = {
    runId: "run-example",
    state: "reviewing",
    workers: {},
  };

  assert.equal(isJsonValue(result), true);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(isJsonValue({ bad: () => undefined }), false);
  assert.equal(isJsonValue({ bad: new AbortController().signal }), false);
});

test("project context validates absolute canonical roots and trusted session metadata", () => {
  const context = createContext("kilo");
  assert.doesNotThrow(() => assertProjectContext(context));

  assert.throws(
    () =>
      assertProjectContext({
        ...context,
        projectRoot: `${context.projectRoot}${path.sep}.`,
      }),
    /absolute canonical path/,
  );
  assert.throws(
    () =>
      assertProjectContext({
        ...context,
        hostSession: { sessionId: "other-session" },
      }),
    /conflicts with its origin/,
  );
});

function createContext(coordinatorKind: ProjectContext["origin"]["coordinatorKind"]): ProjectContext {
  const sessionId = `${coordinatorKind}-session`;
  return {
    projectRoot: path.resolve(process.cwd()),
    origin: {
      workspaceId: `${coordinatorKind}-workspace`,
      paneId: `${coordinatorKind}-pane`,
      coordinatorKind,
      sessionId,
    },
    signal: new AbortController().signal,
    hostSession: { sessionId },
  };
}
