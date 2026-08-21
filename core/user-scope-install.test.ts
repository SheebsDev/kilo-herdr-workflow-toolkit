import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "toml";

import type {
  ExternalRegistrationBackend,
  ExternalRegistrationReplaceRequest,
} from "./external-registration-install-adapter.ts";
import type { InstallPreflightBackend } from "./install-plan.ts";
import {
  readOwnershipManifest,
  resolveOwnershipPaths,
  writeOwnershipManifest,
} from "./ownership-manifest.ts";
import {
  buildUserMcpRegistration,
  executeUserScopeInstallOperation,
} from "./user-scope-install.ts";

const CHECKOUT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROJECTED_AT = "2026-08-20T12:00:00.000Z";

test("Kilo-only default uses the injected external registration and creates no other harness content", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-kilo-"));
  const external = new MemoryExternalRegistrationBackend();
  try {
    await mkdir(path.join(home, ".workflow"));
    await writeFile(path.join(home, ".workflow", "sentinel"), "keep\n");

    const installed = await executeUserScopeInstallOperation({
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: PROJECTED_AT,
    });

    assert.deepEqual(installed.preflightPlan.harnesses, ["kilo"]);
    assert.ok(installed.executablePlan.transitions.some((entry) => entry.kind === "external-registration"));
    assert.equal(external.values.get("KILO_CONFIG_DIR"), CHECKOUT_ROOT);
    assert.equal(await exists(path.join(home, ".claude")), false);
    assert.equal(await exists(path.join(home, ".agents")), false);
    assert.equal(await exists(path.join(home, ".claude.json")), false);
    assert.equal(await exists(path.join(home, ".codex")), false);
    assert.equal(await readFile(path.join(home, ".workflow", "sentinel"), "utf8"), "keep\n");

    const manifest = readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home });
    assert.deepEqual(manifest.harnesses, ["kilo"]);
    assert.equal(manifest.externalRegistrations[0].key, "KILO_CONFIG_DIR");
    assert.equal(manifest.configRegistrations.length, 0);
    assert.equal(manifest.files.length, 0);

    let uninstallHarnessChecks = 0;
    await executeUserScopeInstallOperation({
      operation: "uninstall",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: {
        ...passingPreflight(),
        checkHarness: () => {
          uninstallHarnessChecks += 1;
          throw new Error("uninstall must not require a harness CLI");
        },
      },
      externalRegistrationBackend: external,
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(uninstallHarnessChecks, 0);
    assert.equal(external.values.has("KILO_CONFIG_DIR"), false);
    assert.equal(await exists(resolveOwnershipPaths("user", home).manifestPath), false);
    assert.equal(await readFile(path.join(home, ".workflow", "sentinel"), "utf8"), "keep\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("user installs can stage in an OS temp directory inside the home root", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-home-temp-"));
  const temporaryRoot = path.join(home, "AppData", "Local", "Temp");
  const external = new MemoryExternalRegistrationBackend();
  try {
    await mkdir(temporaryRoot, { recursive: true });
    await executeUserScopeInstallOperation({
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      filesystemOptions: { temporaryRoot },
      projectedAt: PROJECTED_AT,
    });

    assert.equal(external.values.get("KILO_CONFIG_DIR"), CHECKOUT_ROOT);
    assert.deepEqual(await readdir(temporaryRoot), []);
    assert.equal(
      readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home }).scope,
      "user",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("each config harness installs and uninstalls its own shared authored skill set", async () => {
  for (const harness of ["claude", "codex"] as const) {
    const home = await mkdtemp(path.join(tmpdir(), `user-install-${harness}-`));
    try {
      await executeUserScopeInstallOperation({
        selections: harness,
        checkoutRoot: CHECKOUT_ROOT,
        homeRoot: home,
        skipDependencies: true,
        preflightBackend: passingPreflight(),
        projectedAt: PROJECTED_AT,
      });
      const skillRoot = harness === "claude" ? ".claude" : ".agents";
      const authored = await readFile(
        path.join(home, skillRoot, "skills", "implement-task", "SKILL.md"),
        "utf8",
      );
      assert.equal(authored, await readFile(path.join(CHECKOUT_ROOT, "skills", "implement-task", "SKILL.md"), "utf8"));
      for (const reviewer of ["test-verification", "code-review", "readability-review"]) {
        assert.equal(await exists(path.join(home, skillRoot, "skills", reviewer, "SKILL.md")), true);
      }
      const manifest = readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home });
      assert.deepEqual(manifest.harnesses, [harness]);
      assert.equal(manifest.files.length, 4);
      assert.equal(manifest.configRegistrations.length, 1);
      assert.equal(manifest.externalRegistrations.length, 0);

      await executeUserScopeInstallOperation({
        operation: "uninstall",
        selections: harness,
        checkoutRoot: CHECKOUT_ROOT,
        homeRoot: home,
        skipDependencies: true,
        preflightBackend: passingPreflight(),
        projectedAt: "2026-08-20T12:01:00.000Z",
      });
      assert.equal(await exists(path.join(home, skillRoot, "skills", "implement-task", "SKILL.md")), false);
      assert.equal(await exists(resolveOwnershipPaths("user", home).manifestPath), false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
});

test("all installs exactly three integrations with one shared checkout server", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-all-"));
  const external = new MemoryExternalRegistrationBackend();
  try {
    await writeFile(path.join(home, ".claude.json"), '{"theme":"dark"}\n');
    await mkdir(path.join(home, ".codex"));
    await writeFile(path.join(home, ".codex", "config.toml"), "# retain me\nmodel = \"gpt\"\n");
    const result = await executeUserScopeInstallOperation({
      selections: ["all", "kilo", "claude"],
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: PROJECTED_AT,
    });

    assert.deepEqual(result.preflightPlan.harnesses, ["kilo", "claude", "codex"]);
    const manifest = readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home });
    assert.deepEqual(manifest.harnesses, ["kilo", "claude", "codex"]);
    assert.equal(manifest.externalRegistrations.length, 1);
    assert.equal(manifest.configRegistrations.length, 2);
    assert.equal(manifest.files.length, 8);
    const claude = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.equal(claude.theme, "dark");
    assert.equal(claude.mcpServers["engineering-workflow"].command, process.execPath);
    assert.equal(claude.mcpServers["engineering-workflow"].env.WORKFLOW_COORDINATOR_KIND, "claude");
    const codexSource = await readFile(path.join(home, ".codex", "config.toml"), "utf8");
    const codex = parseToml(codexSource) as Record<string, any>;
    assert.match(codexSource, /# retain me/);
    assert.equal(codex.model, "gpt");
    assert.equal(codex.mcp_servers["engineering-workflow"].command, process.execPath);
    assert.equal(codex.mcp_servers["engineering-workflow"].env.WORKFLOW_COORDINATOR_KIND, "codex");
    assert.deepEqual(
      claude.mcpServers["engineering-workflow"].args,
      codex.mcp_servers["engineering-workflow"].args,
    );

    await executeUserScopeInstallOperation({
      operation: "uninstall",
      selections: "all",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(external.values.has("KILO_CONFIG_DIR"), false);
    assert.equal(await exists(resolveOwnershipPaths("user", home).manifestPath), false);
    const finalClaude = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.equal(finalClaude.theme, "dark");
    assert.equal(finalClaude.mcpServers["engineering-workflow"], undefined);
    const finalCodex = parseToml(await readFile(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    assert.equal(finalCodex.model, "gpt");
    assert.equal(finalCodex.mcp_servers?.["engineering-workflow"], undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("forced Kilo registration displacement is private and restored on uninstall", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-kilo-force-"));
  const external = new MemoryExternalRegistrationBackend();
  external.values.set("KILO_CONFIG_DIR", "C:\\prior-toolkit");
  try {
    await executeUserScopeInstallOperation({
      selections: "kilo",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      force: true,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: PROJECTED_AT,
    });
    const locations = resolveOwnershipPaths("user", home);
    const manifest = readOwnershipManifest(locations.manifestPath, { root: home });
    assert.equal(manifest.displacedValues.length, 1);
    assert.equal(manifest.displacedValues[0].secret, false);
    assert.doesNotMatch(await readFile(locations.manifestPath, "utf8"), /prior-toolkit/);
    assert.match(await readFile(locations.restoreDataPath, "utf8"), /prior-toolkit/);

    await executeUserScopeInstallOperation({
      operation: "uninstall",
      selections: "kilo",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(external.values.get("KILO_CONFIG_DIR"), "C:\\prior-toolkit");
    assert.equal(await exists(locations.manifestPath), false);
    assert.equal(await exists(locations.restoreDataPath), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a late external registration failure rolls back all earlier harness artifacts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-rollback-"));
  const external = new FailingExternalRegistrationBackend();
  try {
    await assert.rejects(
      executeUserScopeInstallOperation({
        selections: "all",
        checkoutRoot: CHECKOUT_ROOT,
        homeRoot: home,
        skipDependencies: true,
        preflightBackend: passingPreflight(),
        externalRegistrationBackend: external,
        projectedAt: PROJECTED_AT,
      }),
      /injected external registration failure/i,
    );
    assert.equal(await exists(path.join(home, ".claude.json")), false);
    assert.equal(await exists(path.join(home, ".codex", "config.toml")), false);
    assert.equal(await exists(path.join(home, ".claude", "skills", "implement-task", "SKILL.md")), false);
    assert.equal(await exists(path.join(home, ".agents", "skills", "implement-task", "SKILL.md")), false);
    assert.equal(await exists(resolveOwnershipPaths("user", home).manifestPath), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("ownership bytes and parsed state remain bound across asynchronous preflight", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-metadata-race-"));
  const external = new MemoryExternalRegistrationBackend();
  try {
    const base = {
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      externalRegistrationBackend: external,
    };
    await executeUserScopeInstallOperation({
      ...base,
      preflightBackend: passingPreflight(),
      projectedAt: PROJECTED_AT,
    });
    const locations = resolveOwnershipPaths("user", home);
    const initial = readOwnershipManifest(locations.manifestPath, { root: home });
    const concurrent = { ...initial, updatedAt: "2026-08-20T12:00:30.000Z" };
    let changed = false;

    await assert.rejects(
      executeUserScopeInstallOperation({
        ...base,
        operation: "update",
        preflightBackend: {
          ...passingPreflight(),
          checkHarness: () => {
            if (!changed) {
              writeOwnershipManifest(locations.manifestPath, concurrent);
              changed = true;
            }
            return true;
          },
        },
        projectedAt: "2026-08-20T12:01:00.000Z",
      }),
      /changed before staging|baseline changed/i,
    );
    assert.equal(
      readOwnershipManifest(locations.manifestPath, { root: home }).updatedAt,
      concurrent.updatedAt,
    );
    assert.equal(external.values.get("KILO_CONFIG_DIR"), CHECKOUT_ROOT);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("forced named registration conflicts are restored while skill collisions always fail closed", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-conflict-"));
  try {
    const original = { command: "custom", args: ["serve"] };
    await writeFile(
      path.join(home, ".claude.json"),
      `${JSON.stringify({ keep: true, mcpServers: { "engineering-workflow": original } }, null, 2)}\n`,
    );
    await executeUserScopeInstallOperation({
      selections: "claude",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      force: true,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      projectedAt: PROJECTED_AT,
    });
    await executeUserScopeInstallOperation({
      operation: "uninstall",
      selections: "claude",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    const restored = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.equal(restored.keep, true);
    assert.deepEqual(restored.mcpServers["engineering-workflow"], original);

    await mkdir(path.join(home, ".claude", "skills", "implement-task"), { recursive: true });
    const collisionPath = path.join(home, ".claude", "skills", "implement-task", "SKILL.md");
    await writeFile(collisionPath, "user-owned\n");
    await assert.rejects(
      executeUserScopeInstallOperation({
        selections: "claude",
        checkoutRoot: CHECKOUT_ROOT,
        homeRoot: home,
        force: true,
        skipDependencies: true,
        preflightBackend: passingPreflight(),
        projectedAt: "2026-08-20T12:02:00.000Z",
      }),
      /cannot be safely force-replaced/i,
    );
    assert.equal(await readFile(collisionPath, "utf8"), "user-owned\n");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("modified owned skills survive update and uninstall with residual ownership", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "user-install-modified-"));
  try {
    const request = {
      selections: "claude" as const,
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
    };
    await executeUserScopeInstallOperation({ ...request, projectedAt: PROJECTED_AT });
    const skillPath = path.join(home, ".claude", "skills", "implement-task", "SKILL.md");
    await writeFile(skillPath, "locally modified\n");
    const updated = await executeUserScopeInstallOperation({
      ...request,
      operation: "update",
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(await readFile(skillPath, "utf8"), "locally modified\n");
    assert.ok(updated.transaction.warnings.some((warning) => warning.code === "modified-owned-content"));

    await executeUserScopeInstallOperation({
      ...request,
      operation: "uninstall",
      projectedAt: "2026-08-20T12:02:00.000Z",
    });
    assert.equal(await readFile(skillPath, "utf8"), "locally modified\n");
    const manifest = readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home });
    assert.equal(manifest.files.length, 0);
    assert.equal(manifest.residualOwnership[0].artifactType, "file");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("moved checkout updates registrations and generated arguments launch through paths with spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "user checkout fixture "));
  const checkout = path.join(root, "checkout with spaces");
  const home = path.join(root, "home");
  const external = new MemoryExternalRegistrationBackend();
  try {
    await mkdir(home);
    await copyCheckout(checkout);
    await executeUserScopeInstallOperation({
      selections: "all",
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: PROJECTED_AT,
    });
    const moved = await executeUserScopeInstallOperation({
      operation: "update",
      selections: "all",
      checkoutRoot: checkout,
      homeRoot: home,
      skipDependencies: true,
      preflightBackend: passingPreflight(),
      externalRegistrationBackend: external,
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(external.values.get("KILO_CONFIG_DIR"), checkout);
    assert.ok(moved.transaction.warnings.some((warning) => warning.code === "checkout-moved"));
    const installedClaude = JSON.parse(await readFile(path.join(home, ".claude.json"), "utf8"));
    assert.equal(
      installedClaude.mcpServers["engineering-workflow"].args[1],
      path.join(checkout, "mcp", "server.ts"),
    );

    const registration = buildUserMcpRegistration("claude", checkout) as {
      command: string;
      args: string[];
      env: Record<string, string>;
    };
    assert.equal(registration.args.length, 2);
    assert.equal(registration.args[1], path.join(checkout, "mcp", "server.ts"));
    const response = await initializeWorkerServer(registration);
    assert.equal(response.id, 1);
    assert.equal(response.error, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class MemoryExternalRegistrationBackend implements ExternalRegistrationBackend {
  readonly values = new Map<string, string>();

  read(key: string): string | undefined {
    return this.values.get(key);
  }

  replace(request: ExternalRegistrationReplaceRequest): void {
    const current = this.values.get(request.key);
    if (current !== request.expectedValue) {
      throw new Error(`Concurrent external registration change for ${request.key}.`);
    }
    if (request.value === undefined) this.values.delete(request.key);
    else this.values.set(request.key, request.value);
  }
}

class FailingExternalRegistrationBackend extends MemoryExternalRegistrationBackend {
  override replace(_request: ExternalRegistrationReplaceRequest): void {
    throw new Error("Injected external registration failure.");
  }
}

function passingPreflight(): InstallPreflightBackend {
  return {
    checkHarness: () => true,
    checkNode: () => true,
    checkNpm: () => true,
    checkDependencies: () => true,
    checkHerdr: () => true,
    checkIntegration: () => true,
  };
}

async function copyCheckout(destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const directory of ["core", "mcp", "skills", "launcher", "plugin", "command"]) {
    await cp(path.join(CHECKOUT_ROOT, directory), path.join(destination, directory), { recursive: true });
  }
  for (const file of ["package.json", "package-lock.json"]) {
    await cp(path.join(CHECKOUT_ROOT, file), path.join(destination, file));
  }
  await symlink(
    path.join(CHECKOUT_ROOT, "node_modules"),
    path.join(destination, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function initializeWorkerServer(registration: {
  command: string;
  args: string[];
  env: Record<string, string>;
}): Promise<Record<string, any>> {
  const child = spawn(registration.command, registration.args, {
    cwd: path.dirname(path.dirname(registration.args[1])),
    env: {
      ...process.env,
      ...registration.env,
      WORKFLOW_ROLE: "tests",
      WORKFLOW_RUN_ID: "run-user-install-path-spaces",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "user-install-test", version: "1.0.0" },
    },
  })}\n`);
  const response = await waitForLine(() => stdout, 5_000);
  child.stdin.end();
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill();
  await closed;
  return JSON.parse(response) as Record<string, any>;
}

async function waitForLine(read: () => string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    const newline = value.indexOf("\n");
    if (newline >= 0) return value.slice(0, newline);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for MCP initialization response.");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
