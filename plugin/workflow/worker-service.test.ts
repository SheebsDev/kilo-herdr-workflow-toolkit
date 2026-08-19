import assert from "node:assert/strict";
import test from "node:test";

import { buildAgentStartArguments } from "./worker-service.ts";
import { getWorkerLaunchConfiguration } from "./worker-profile.ts";

test("Herdr agent start arguments preserve trusted harness and capability flags", () => {
  assert.deepEqual(
    buildAgentStartArguments(
      "wf-run-tests-1",
      getWorkerLaunchConfiguration("codex", "code-review"),
      "pane-codex",
    ),
    [
      "agent",
      "start",
      "wf-run-tests-1",
      "--kind",
      "codex",
      "--pane",
      "pane-codex",
      "--",
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "never",
    ],
  );
  assert.deepEqual(
    buildAgentStartArguments(
      "wf-run-tests-1",
      getWorkerLaunchConfiguration("claude", "tests"),
      "pane-claude",
    ),
    [
      "agent",
      "start",
      "wf-run-tests-1",
      "--kind",
      "claude",
      "--pane",
      "pane-claude",
      "--",
    ],
  );
});
