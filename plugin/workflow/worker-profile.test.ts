import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkerLaunchConfiguration,
  getWorkerCapability,
  getTrustedWorkerProfile,
  TRUSTED_WORKER_PROFILES,
} from "./worker-profile.ts";

test("trusted profiles define fixed launch arguments for every agent capability", () => {
  assert.deepEqual(
    getWorkerLaunchConfiguration("kilo", "tests").launchArguments,
    ["--agent", "code"],
  );
  assert.deepEqual(
    getWorkerLaunchConfiguration("kilo", "code-review").launchArguments,
    ["--agent", "code"],
  );
  assert.deepEqual(
    getWorkerLaunchConfiguration("claude", "code-review").launchArguments,
    ["--permission-mode", "plan"],
  );
  assert.deepEqual(
    getWorkerLaunchConfiguration("claude", "tests").launchArguments,
    [],
  );
  assert.deepEqual(
    getWorkerLaunchConfiguration("codex", "readability").launchArguments,
    ["--sandbox", "read-only", "--ask-for-approval", "never"],
  );
  assert.deepEqual(
    getWorkerLaunchConfiguration("codex", "tests").launchArguments,
    ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
  );
});

test("review profiles accurately expose no-write enforcement", () => {
  for (const agentKind of ["claude", "codex"] as const) {
    const configuration = getWorkerLaunchConfiguration(agentKind, "code-review");
    assert.equal(configuration.enforcement.allowsWrites, false);
    assert.equal(configuration.enforcement.strength, "strong");
  }

  const kilo = getWorkerLaunchConfiguration("kilo", "code-review");
  assert.equal(kilo.enforcement.allowsWrites, true);
  assert.equal(kilo.enforcement.strength, "weak");
});

test("Windows prompt-file transport is Kilo-only", () => {
  assert.equal(
    getWorkerLaunchConfiguration("kilo", "tests", "win32").promptTransport,
    "kilo-windows-prompt-file",
  );
  assert.equal(
    getWorkerLaunchConfiguration("claude", "tests", "win32").promptTransport,
    "herdr-prompt",
  );
  assert.equal(
    getWorkerLaunchConfiguration("codex", "tests", "win32").promptTransport,
    "herdr-prompt",
  );
  assert.equal(
    getWorkerLaunchConfiguration("kilo", "tests", "linux").promptTransport,
    "herdr-prompt",
  );
});

test("profiles are closed and reject project-provided role or agent values", () => {
  assert.deepEqual(Object.keys(TRUSTED_WORKER_PROFILES), [
    "kilo",
    "claude",
    "codex",
  ]);
  assert.equal(getTrustedWorkerProfile("codex").herdrKind, "codex");
  assert.equal(getWorkerCapability("readability"), "review-only");
  assert.throws(
    () => getTrustedWorkerProfile("gemini" as never),
    /Unsupported workflow worker agent kind/,
  );
  assert.throws(
    () => getWorkerLaunchConfiguration("kilo", "security-audit" as never),
    /Unsupported workflow worker role/,
  );
});

test("profiles expose actionable executable installation guidance", () => {
  assert.equal(
    getTrustedWorkerProfile("claude").installCommand,
    "npm install -g @anthropic-ai/claude-code",
  );
  assert.equal(getTrustedWorkerProfile("codex").executable, "codex");
});
