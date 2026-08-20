import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  InstallPreflightError,
  buildInstallPlan,
  normalizeInstallHarnesses,
} from "./install-plan.ts";
import { createOwnershipManifest } from "./ownership-manifest.ts";

test("selection defaults to Kilo, deduplicates, and expands all deterministically", () => {
  assert.deepEqual(normalizeInstallHarnesses(), ["kilo"]);
  assert.deepEqual(normalizeInstallHarnesses(["claude", "kilo", "claude"]), ["kilo", "claude"]);
  assert.deepEqual(normalizeInstallHarnesses(["all", "kilo", "all"]), ["kilo", "claude", "codex"]);
  assert.throws(() => normalizeInstallHarnesses(["kilo", "invalid"]), /Unsupported install harness/);
});

test("Kilo-only project plans do not include Claude or Codex destinations", async () => {
  const fixture = await createCheckoutFixture();
  try {
    const plan = await buildInstallPlan({
      scope: "project",
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      backend: passingBackend(),
    });

    assert.deepEqual(plan.harnesses, ["kilo"]);
    assert.equal(plan.sourceInventory.some((entry) => entry.destinationRelativePath?.startsWith(".claude/")), false);
    assert.equal(plan.sourceInventory.some((entry) => entry.destinationRelativePath?.startsWith(".agents/skills/")), false);
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.sourceInventory), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("all selection plans each harness exactly once and performs no writes", async () => {
  const fixture = await createCheckoutFixture();
  const calls: string[] = [];
  const integrationCalls: string[] = [];
  try {
    const plan = await buildInstallPlan({
      scope: "user",
      selections: ["claude", "all", "codex"],
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      configTargets: [
        {
          harness: "claude",
          path: ".claude.json",
          key: "mcpServers.engineering-workflow",
          format: "json",
          installedValue: { command: "node", args: ["server.ts"] },
        },
      ],
      backend: {
        ...passingBackend(),
        checkHarness: async (harness) => { calls.push(harness); return true; },
        checkIntegration: async (harness) => { integrationCalls.push(harness); return true; },
      },
    });

    assert.deepEqual(plan.harnesses, ["kilo", "claude", "codex"]);
    assert.deepEqual(calls, ["kilo", "claude", "codex"]);
    assert.deepEqual(integrationCalls, ["claude", "codex"]);
    assert.equal(plan.ownedChanges.some((change) => change.destinationRelativePath.startsWith(".claude/")), true);
    assert.equal(plan.ownedChanges.some((change) => change.destinationRelativePath.startsWith(".agents/")), true);
    assert.equal(await readFile(fixture.destination, "utf8").catch(() => "missing"), "missing");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("config planning reads the selected registration instead of conflicting on unrelated JSON", async () => {
  const fixture = await createCheckoutFixture();
  const configPath = path.join(fixture.destination, "claude.json");
  await writeFile(configPath, '{"unrelated":true}\n');
  try {
    const plan = await buildInstallPlan({
      scope: "user",
      selections: ["claude"],
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      configTargets: [{
        harness: "claude",
        path: "claude.json",
        key: "mcpServers.engineering-workflow",
        format: "json",
        installedValue: { command: "node" },
      }],
      backend: passingBackend(),
    });
    assert.equal(
      plan.ownedChanges.find((change) => change.artifactType === "config-registration")?.action,
      "create",
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("invalid TOML and missing default dependencies fail before planning", async () => {
  const fixture = await createCheckoutFixture();
  const configPath = path.join(fixture.destination, "codex.toml");
  await writeFile(configPath, "mcp_servers = [\n");
  try {
    await assert.rejects(
      buildInstallPlan({
        scope: "project",
        selections: ["codex"],
        checkoutRoot: fixture.checkout,
        destinationRoot: fixture.destination,
        configTargets: [{
          harness: "codex",
          path: "codex.toml",
          key: "mcp_servers",
          format: "toml",
          installedValue: { command: "node" },
        }],
        backend: {
          checkHarness: async () => true,
          checkNode: async () => true,
          checkNpm: async () => true,
          checkHerdr: async () => true,
          checkIntegration: async () => true,
        },
      }),
      /configuration.*not valid TOML|checkout dependencies preflight failed/i,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("every selected harness is checked before a multi-harness failure is returned", async () => {
  const fixture = await createCheckoutFixture();
  const calls: string[] = [];
  try {
    await assert.rejects(
      buildInstallPlan({
        scope: "project",
        selections: ["kilo", "claude", "codex"],
        checkoutRoot: fixture.checkout,
        destinationRoot: fixture.destination,
        backend: {
          ...passingBackend(),
          checkHarness: async (harness) => {
            calls.push(harness);
            return harness !== "claude";
          },
        },
      }),
      (error: unknown) => error instanceof InstallPreflightError && /claude CLI/.test(error.message),
    );
    assert.deepEqual(calls, ["kilo", "claude", "codex"]);
    assert.equal((await readFile(path.join(fixture.destination, "sentinel"), "utf8").catch(() => "")), "");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("modified owned files are preserved with warnings and exact rollback inputs", async () => {
  const fixture = await createCheckoutFixture();
  const destinationRelativePath = ".agents/toolkits/kilo-herdr-engineering-workflow/core/model.ts";
  const destinationPath = path.join(fixture.destination, ...destinationRelativePath.split("/"));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, "user edit\n");
  const manifest = createOwnershipManifest({
    scope: "project",
    harnesses: ["kilo"],
    files: [{
      id: "owned-model",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      path: destinationRelativePath,
      sha256: "a".repeat(64),
    }],
  });
  try {
    const plan = await buildInstallPlan({
      operation: "update",
      scope: "project",
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      existingManifest: manifest,
      backend: passingBackend(),
    });
    const change = plan.ownedChanges.find((candidate) => candidate.destinationRelativePath === destinationRelativePath);
    assert.equal(change?.action, "preserve");
    assert.match(change?.warning ?? "", /modified/);
    assert.equal(plan.rollbackInputs.some((input) => input.path === destinationPath), false);
    assert.equal(plan.destinationPreconditions.find((candidate) => candidate.relativePath === destinationRelativePath)?.priorContent, "user edit\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("malformed config, trust failure, and invalid dependency checks prevent planning", async () => {
  const fixture = await createCheckoutFixture();
  try {
    await assert.rejects(
      buildInstallPlan({
        scope: "project",
        selections: ["claude"],
        checkoutRoot: fixture.checkout,
        destinationRoot: fixture.destination,
        configTargets: [{
          harness: "claude",
          path: "config.json",
          key: "mcpServers.engineering-workflow",
          format: "json",
          installedValue: { command: "node" },
        }],
        trustTargets: [{ harness: "claude", path: ".", trusted: false }],
        backend: {
          ...passingBackend(),
          readConfig: async () => ({ exists: true, parseable: false }),
        },
      }),
      (error: unknown) => error instanceof InstallPreflightError &&
        /configuration|trust/.test(error.message),
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall removes only unchanged selected ownership and retains modified or shared content", async () => {
  const fixture = await createCheckoutFixture();
  const unchangedPath = "payload/unchanged.ts";
  const modifiedPath = "payload/modified.ts";
  await mkdir(path.join(fixture.destination, "payload"), { recursive: true });
  await writeFile(path.join(fixture.destination, unchangedPath), "unchanged\n");
  await writeFile(path.join(fixture.destination, modifiedPath), "modified by user\n");
  const manifest = createOwnershipManifest({
    scope: "project",
    harnesses: ["kilo", "claude"],
    files: [
      { id: "unchanged", artifactType: "shared-runtime", harnesses: ["kilo"], path: unchangedPath, sha256: fileHash("unchanged\n") },
      { id: "modified", artifactType: "shared-runtime", harnesses: ["kilo"], path: modifiedPath, sha256: fileHash("original\n") },
      { id: "shared", artifactType: "shared-runtime", harnesses: ["kilo", "claude"], path: "payload/shared.ts", sha256: fileHash("shared\n") },
    ],
  });
  try {
    const plan = await buildInstallPlan({
      operation: "uninstall",
      scope: "project",
      selections: ["kilo"],
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      existingManifest: manifest,
      backend: passingBackend(),
    });
    assert.equal(plan.ownedChanges.find((change) => change.id === "unchanged")?.action, "remove");
    assert.equal(plan.ownedChanges.find((change) => change.id === "modified")?.action, "preserve");
    assert.equal(plan.ownedChanges.find((change) => change.id === "shared")?.action, "preserve");
    assert.equal(
      plan.rollbackInputs.some((input) => input.path === path.join(fixture.destination, ...unchangedPath.split("/"))),
      true,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("uninstall plans dependency ownership and records typed rollback inputs", async () => {
  const fixture = await createCheckoutFixture();
  const dependencyPath = path.join(fixture.destination, "payload", "node_modules");
  await mkdir(path.join(dependencyPath, "fixture"), { recursive: true });
  await writeFile(path.join(dependencyPath, "fixture", "package.js"), "package\n");
  const treeHash = createHash("sha256")
    .update("D:fixture", "utf8")
    .update("F:fixture/package.js", "utf8")
    .update(Buffer.from("package\n"))
    .digest("hex");
  const manifest = createOwnershipManifest({
    scope: "project",
    harnesses: ["kilo"],
    dependencies: [{
      id: "owned-dependencies",
      harnesses: ["kilo"],
      path: "payload/node_modules",
      packageManager: "npm",
      packageNames: ["fixture"],
      treeSha256: treeHash,
    }],
  });
  try {
    const plan = await buildInstallPlan({
      operation: "uninstall",
      scope: "project",
      selections: ["kilo"],
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      existingManifest: manifest,
      backend: passingBackend(),
    });
    assert.equal(plan.ownedChanges.find((change) => change.id === "owned-dependencies")?.action, "remove");
    assert.equal(plan.rollbackInputs.find((input) => input.type === "dependency")?.path, dependencyPath);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

function passingBackend() {
  return {
    checkHarness: async () => true,
    checkNode: async () => true,
    checkNpm: async () => true,
    checkDependencies: async () => true,
    checkHerdr: async () => true,
    checkIntegration: async () => true,
  };
}

function fileHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function createCheckoutFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "install-plan-"));
  const checkout = path.join(root, "checkout");
  const destination = path.join(root, "destination");
  await mkdir(path.join(checkout, "core"), { recursive: true });
  await mkdir(path.join(checkout, "mcp"), { recursive: true });
  await mkdir(path.join(checkout, "plugin"), { recursive: true });
  await mkdir(path.join(checkout, "command"), { recursive: true });
  await mkdir(path.join(checkout, "launcher"), { recursive: true });
  await mkdir(path.join(checkout, "skills", "implement-task"), { recursive: true });
  await mkdir(path.join(checkout, "skills", "test-verification"), { recursive: true });
  await mkdir(path.join(checkout, "skills", "code-review"), { recursive: true });
  await mkdir(path.join(checkout, "skills", "readability-review"), { recursive: true });
  for (const file of [
    "core/model.ts",
    "mcp/server.ts",
    "mcp/workflow-server.ts",
    "plugin/workflow.ts",
    "plugin/herdr-agent-state.js",
    "command/implement-task.md",
    "launcher/kilo.cmd",
    "skills/implement-task/SKILL.md",
    "skills/test-verification/SKILL.md",
    "skills/code-review/SKILL.md",
    "skills/readability-review/SKILL.md",
  ]) {
    await writeFile(path.join(checkout, ...file.split("/")), `${file}\n`);
  }
  await writeFile(path.join(checkout, "package.json"), "{}\n");
  await writeFile(path.join(checkout, "package-lock.json"), "{}\n");
  await mkdir(destination, { recursive: true });
  return { root, checkout, destination };
}
