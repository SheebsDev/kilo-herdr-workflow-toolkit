import assert from "node:assert/strict";
import test from "node:test";

import {
  getWorkerLaunchConfiguration,
  getWorkerCapability,
  getTrustedWorkerProfile,
  isWorkerExecutableAvailable,
  parseIntegrationStatus,
  preflightWorkerSelections,
  resolveWorkerAgents,
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

test("worker selections default to Kilo and reject unknown roles or agents", () => {
  assert.deepEqual(resolveWorkerAgents(undefined), {
    tests: "kilo",
    "code-review": "kilo",
    readability: "kilo",
  });
  assert.deepEqual(
    resolveWorkerAgents({ tests: "codex", readability: "claude" }),
    {
      tests: "codex",
      "code-review": "kilo",
      readability: "claude",
    },
  );
  assert.throws(
    () => resolveWorkerAgents({ unknown: "kilo" }),
    /Unsupported workflow worker role "unknown"/,
  );
  assert.throws(
    () => resolveWorkerAgents({ tests: "shell" }),
    /Unsupported workflow worker agent kind for tests/,
  );
});

test("integration status parsing is defensive and recognizes current entries", () => {
  const statuses = parseIntegrationStatus(
    [
      "unexpected output",
      "claude: not installed (C:\\Users\\test)",
      "codex: current (v7)",
      "kilo: current (v4)",
      "broken: maybe",
    ].join("\n"),
  );

  assert.equal(statuses.get("claude"), "not-installed");
  assert.equal(statuses.get("codex"), "current");
  assert.equal(statuses.get("kilo"), "current");
  assert.equal(statuses.has("broken"), false);
});

test("preflight checks each selected agent once and requires current integrations", async () => {
  const executableChecks: string[] = [];
  let integrationChecks = 0;

  await preflightWorkerSelections(
    { tests: "codex", "code-review": "codex", readability: "claude" },
    undefined,
    {
      isExecutableAvailable: async (agentKind) => {
        executableChecks.push(agentKind);
        return true;
      },
      readIntegrationStatus: async () => {
        integrationChecks += 1;
        return "claude: current\ncodex: current";
      },
    },
  );

  assert.deepEqual(executableChecks.sort(), ["claude", "codex"]);
  assert.equal(integrationChecks, 1);
});

test("preflight failures include the safe recovery command", async () => {
  await assert.rejects(
    preflightWorkerSelections(
      { tests: "codex", "code-review": "kilo", readability: "kilo" },
      undefined,
      {
        isExecutableAvailable: async () => true,
        readIntegrationStatus: async () => "codex: not installed",
      },
    ),
    /herdr integration install codex/,
  );
});

test("aborted executable probes propagate cancellation", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  await assert.rejects(
    isWorkerExecutableAvailable("kilo", controller.signal),
    /cancelled|aborted/i,
  );
});
