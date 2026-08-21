import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseToml } from "toml";

import type { InstallPreflightBackend } from "./install-plan.ts";
import { InstallTransactionError } from "./install-transaction.ts";
import {
  PROJECT_DEPENDENCY_PATH,
  buildProjectMcpRegistration,
  executeProjectScopeInstallOperation,
} from "./project-scope-install.ts";
import {
  PROJECT_TOOLKIT_ROOT,
  readOwnershipManifest,
  resolveOwnershipPaths,
} from "./ownership-manifest.ts";

const CHECKOUT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PROJECTED_AT = "2026-08-20T18:00:00.000Z";

test("each project harness installs one common runtime with only its discovery payload", async () => {
  for (const harness of ["kilo", "claude", "codex"] as const) {
    const fixture = await createFixture(`single-${harness}`);
    try {
      const result = await install(fixture, { selections: harness });
      assert.deepEqual(result.preflightPlan.harnesses, [harness]);
      assert.equal(await exists(toolkitPath(fixture, "core", "model.ts")), true);
      assert.equal(await exists(toolkitPath(fixture, "mcp", "server.ts")), true);
      assert.equal(await exists(toolkitPath(fixture, "node_modules", "fixture-package", "index.js")), true);

      assert.equal(await exists(projectPath(fixture, ".kilo", "plugin", "workflow.ts")), harness === "kilo");
      assert.equal(await exists(projectPath(fixture, ".mcp.json")), harness === "claude");
      assert.equal(await exists(projectPath(fixture, ".codex", "config.toml")), harness === "codex");
      assert.equal(
        await exists(projectPath(fixture, ".claude", "skills", "implement-task", "SKILL.md")),
        harness === "claude",
      );
      assert.equal(
        await exists(projectPath(fixture, ".agents", "skills", "implement-task", "SKILL.md")),
        harness === "codex",
      );

      const manifest = readProjectManifest(fixture);
      assert.deepEqual(manifest.harnesses, [harness]);
      assert.deepEqual(manifest.dependencies[0], {
        id: manifest.dependencies[0].id,
        harnesses: [harness],
        path: PROJECT_DEPENDENCY_PATH,
        packageManager: "npm",
        packageNames: ["fixture-package"],
        lockfilePath: `${PROJECT_TOOLKIT_ROOT}/package-lock.json`,
        treeSha256: manifest.dependencies[0].treeSha256,
      });

      await install(fixture, {
        operation: "uninstall",
        selections: harness,
        projectedAt: "2026-08-20T18:01:00.000Z",
      });
      assert.equal(await exists(toolkitPath(fixture, "core", "model.ts")), false);
      assert.equal(await exists(projectPath(fixture, ".workflow", "sentinel")), true);
      assert.equal(await exists(ownershipPaths(fixture).manifestPath), false);
    } finally {
      await cleanup(fixture);
    }
  }
});

test("all harnesses share dependencies and support safe partial uninstall", async () => {
  const fixture = await createFixture("all-partial");
  try {
    await install(fixture, { selections: "all" });
    const installed = readProjectManifest(fixture);
    assert.deepEqual(installed.harnesses, ["kilo", "claude", "codex"]);
    assert.deepEqual(installed.dependencies[0].harnesses, ["kilo", "claude", "codex"]);
    await install(fixture, {
      operation: "uninstall",
      selections: "kilo",
      projectedAt: "2026-08-20T18:01:00.000Z",
    });
    assert.equal(await exists(projectPath(fixture, ".kilo", "plugin", "workflow.ts")), false);
    assert.equal(await exists(toolkitPath(fixture, "node_modules", "fixture-package", "index.js")), true);
    assert.equal(await exists(projectPath(fixture, ".mcp.json")), true);
    assert.equal(await exists(projectPath(fixture, ".codex", "config.toml")), true);
    assert.deepEqual(readProjectManifest(fixture).harnesses, ["claude", "codex"]);

    await install(fixture, {
      operation: "uninstall",
      selections: ["claude", "codex"],
      projectedAt: "2026-08-20T18:02:00.000Z",
    });
    assert.equal(await exists(ownershipPaths(fixture).manifestPath), false);
    assert.equal(await exists(projectPath(fixture, ".workflow", "sentinel")), true);
  } finally {
    await cleanup(fixture);
  }
});

test("portable registrations launch the copied MCP entrypoint from root and nested paths with spaces", async () => {
  const fixture = await createFixture("portable launch with spaces");
  try {
    await install(fixture, { selections: ["claude", "codex"] });
    const claude = JSON.parse(await readFile(projectPath(fixture, ".mcp.json"), "utf8"));
    const codex = parseToml(
      await readFile(projectPath(fixture, ".codex", "config.toml"), "utf8"),
    ) as Record<string, any>;
    const registrations = [
      claude.mcpServers["engineering-workflow"],
      codex.mcp_servers["engineering-workflow"],
    ];
    await mkdir(projectPath(fixture, "nested", "deeper"), { recursive: true });

    for (const [index, registration] of registrations.entries()) {
      assert.equal(registration.command, "node");
      assert.equal(registration.args.some((argument: string) => path.isAbsolute(argument)), false);
      assert.doesNotMatch(JSON.stringify(registration), new RegExp(escapeRegex(fixture.project)));
      const cwd = index === 0
        ? fixture.project
        : projectPath(fixture, "nested", "deeper");
      const response = await initializeWorkerServer(registration, cwd);
      assert.equal(response.id, 1);
      assert.equal(response.result.serverInfo.name, "fixture-project-server");
    }

    const direct = buildProjectMcpRegistration("claude") as Record<string, any>;
    assert.deepEqual(direct.args, registrations[0].args);
  } finally {
    await cleanup(fixture);
  }
});

test("thin Kilo discovery imports the toolkit adapter and resolves the bundled Windows launcher", async () => {
  const fixture = await createFixture("kilo-thin");
  try {
    await install(fixture, { selections: "kilo" });
    const shimPath = projectPath(fixture, ".kilo", "plugin", "workflow.ts");
    const shimSource = await readFile(shimPath, "utf8");
    assert.match(shimSource, /^export \{ default \} from /);
    assert.doesNotMatch(shimSource, /WorkflowService|workflow_start/);
    const loaded = await import(`${pathToFileURL(shimPath).href}?fixture=${Date.now()}`);
    assert.deepEqual(loaded.default, { id: "fixture-workflow" });

    const stateShim = projectPath(fixture, ".kilo", "plugin", "herdr-agent-state.js");
    const state = await import(`${pathToFileURL(stateShim).href}?fixture=${Date.now()}`);
    assert.equal(typeof state.HerdrAgentStatePlugin, "function");
    assert.equal(await exists(toolkitPath(fixture, "launcher", "kilo-with-prompt.ps1")), true);
    assert.match(
      await readFile(projectPath(fixture, ".kilo", "command", "implement-task.md"), "utf8"),
      /\.agents\/toolkits\/kilo-herdr-engineering-workflow\/skills\/implement-task\/SKILL\.md/,
    );
  } finally {
    await cleanup(fixture);
  }
});

test("update and uninstall retain modified files, dependency trees, and workflow history", async () => {
  const fixture = await createFixture("modified-update");
  try {
    await install(fixture, { selections: "claude" });
    const skillPath = projectPath(
      fixture,
      ".claude",
      "skills",
      "implement-task",
      "SKILL.md",
    );
    const dependencyPath = toolkitPath(
      fixture,
      "node_modules",
      "fixture-package",
      "index.js",
    );
    await writeFile(skillPath, "user-modified skill\n");
    await writeFile(dependencyPath, "user-modified dependency\n");
    await writeFile(path.join(fixture.checkout, "core", "model.ts"), "export const model = 2;\n");

    const update = await install(fixture, {
      operation: "update",
      selections: "claude",
      projectedAt: "2026-08-20T18:01:00.000Z",
    });
    assert.equal(await readFile(skillPath, "utf8"), "user-modified skill\n");
    assert.equal(await readFile(dependencyPath, "utf8"), "user-modified dependency\n");
    assert.equal(await readFile(toolkitPath(fixture, "core", "model.ts"), "utf8"), "export const model = 2;\n");
    assert.ok(update.transaction.warnings.filter((warning) => warning.code === "modified-owned-content").length >= 2);

    await install(fixture, {
      operation: "uninstall",
      selections: "claude",
      projectedAt: "2026-08-20T18:02:00.000Z",
    });
    assert.equal(await readFile(skillPath, "utf8"), "user-modified skill\n");
    assert.equal(await readFile(dependencyPath, "utf8"), "user-modified dependency\n");
    assert.equal(await readFile(projectPath(fixture, ".workflow", "sentinel"), "utf8"), "keep\n");
    const residual = readProjectManifest(fixture).residualOwnership;
    assert.ok(residual.some((record) => record.artifactType === "file"));
    assert.ok(residual.some((record) => record.artifactType === "dependency"));
  } finally {
    await cleanup(fixture);
  }
});

test("forced project config displacement is private, portable, and restored on uninstall", async () => {
  const fixture = await createFixture("force-config");
  const original = { command: "custom-server", args: ["--local"] };
  try {
    await writeFile(
      projectPath(fixture, ".mcp.json"),
      `${JSON.stringify({ keep: true, mcpServers: { "engineering-workflow": original } }, null, 2)}\n`,
    );
    await install(fixture, { selections: "claude", force: true });
    const locations = ownershipPaths(fixture);
    const manifestSource = await readFile(locations.manifestPath, "utf8");
    const restoreSource = await readFile(locations.restoreDataPath, "utf8");
    assert.doesNotMatch(manifestSource, /custom-server/);
    assert.match(restoreSource, /custom-server/);
    assert.doesNotMatch(manifestSource, new RegExp(escapeRegex(fixture.project)));

    await install(fixture, {
      operation: "uninstall",
      selections: "claude",
      projectedAt: "2026-08-20T18:01:00.000Z",
    });
    const restored = JSON.parse(await readFile(projectPath(fixture, ".mcp.json"), "utf8"));
    assert.equal(restored.keep, true);
    assert.deepEqual(restored.mcpServers["engineering-workflow"], original);
    assert.equal(await exists(locations.restoreDataPath), false);
  } finally {
    await cleanup(fixture);
  }
});

test("a late multi-harness failure rolls back payload, registrations, and dependencies", async () => {
  const fixture = await createFixture("rollback");
  try {
    await assert.rejects(
      install(fixture, {
        selections: "all",
        filesystemOptions: {
          injectFault: ({ boundary, context }) => {
            if (
              boundary === "apply:before-mutation" &&
              context.transition.kind === "ownership-manifest"
            ) {
              throw new Error("injected project metadata failure");
            }
          },
        },
      }),
      /injected project metadata failure/i,
    );
    assert.equal(await exists(projectPath(fixture, ".mcp.json")), false);
    assert.equal(await exists(projectPath(fixture, ".codex", "config.toml")), false);
    assert.equal(await exists(projectPath(fixture, ".kilo", "plugin", "workflow.ts")), false);
    assert.equal(await exists(toolkitPath(fixture, "core", "model.ts")), false);
    assert.equal(await exists(toolkitPath(fixture, "node_modules")), false);
    assert.equal(await exists(ownershipPaths(fixture).manifestPath), false);
    assert.equal(await readFile(projectPath(fixture, ".workflow", "sentinel"), "utf8"), "keep\n");
  } finally {
    await cleanup(fixture);
  }
});

test("concurrent project payload changes are retained and reported as rollback residuals", async () => {
  const fixture = await createFixture("rollback-residual");
  const runtimePath = toolkitPath(fixture, "core", "model.ts");
  try {
    await assert.rejects(
      install(fixture, {
        selections: "all",
        filesystemOptions: {
          injectFault: async ({ boundary, context }) => {
            if (
              boundary === "apply:after-mutation" &&
              context.transition.kind === "file" &&
              context.transition.target.relativePath ===
                `${PROJECT_TOOLKIT_ROOT}/core/model.ts`
            ) {
              await writeFile(runtimePath, "concurrent project edit\n");
            }
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof InstallTransactionError);
        assert.equal(error.details.rollback.complete, false);
        assert.ok(
          error.details.rollback.residuals.some(
            (residual) =>
              residual.target.relativePath ===
                `${PROJECT_TOOLKIT_ROOT}/core/model.ts`,
          ),
        );
        return true;
      },
    );
    assert.equal(await readFile(runtimePath, "utf8"), "concurrent project edit\n");
    assert.equal(await exists(ownershipPaths(fixture).manifestPath), false);
    assert.equal(await readFile(projectPath(fixture, ".workflow", "sentinel"), "utf8"), "keep\n");
  } finally {
    await cleanup(fixture);
  }
});

test("legacy Phase 1 ownership is explicitly refused", async () => {
  const legacy = await createFixture("legacy");
  try {
    const legacyPath = projectPath(
      legacy,
      ".kilo",
      "kilo-herdr-engineering-workflow.manifest",
    );
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, `${"a".repeat(64)}\tplugin/workflow.ts\n`);
    await assert.rejects(
      install(legacy, { selections: "kilo" }),
      /Phase 1 TSV ownership is refused|Legacy manifest retained/i,
    );
    assert.equal(await exists(legacyPath), true);
    assert.equal(await exists(ownershipPaths(legacy).manifestPath), false);
  } finally {
    await cleanup(legacy);
  }
});

interface Fixture {
  root: string;
  checkout: string;
  project: string;
  privateRoot: string;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `project-install-${name}-`));
  const checkout = path.join(root, "checkout");
  const project = path.join(root, "project with spaces");
  const privateRoot = path.join(root, "private restore data");
  for (const directory of [
    "core",
    "mcp",
    "plugin",
    "launcher",
    "project/kilo/plugin",
    "project/kilo/command",
    "skills/implement-task",
    "skills/test-verification",
    "skills/code-review",
    "skills/readability-review",
    "node_modules/fixture-package",
  ]) {
    await mkdir(path.join(checkout, ...directory.split("/")), { recursive: true });
  }
  await mkdir(project, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await mkdir(path.join(project, ".workflow"));
  await writeFile(path.join(project, ".workflow", "sentinel"), "keep\n");

  await writeFile(path.join(checkout, "core", "model.ts"), "export const model = 1;\n");
  await writeFile(
    path.join(checkout, "mcp", "server.ts"),
    [
      'process.stdin.setEncoding("utf8");',
      'let input = "";',
      'process.stdin.on("data", (chunk) => {',
      '  input += chunk;',
      '  let newline;',
      '  while ((newline = input.indexOf("\\n")) >= 0) {',
      '    const request = JSON.parse(input.slice(0, newline));',
      '    input = input.slice(newline + 1);',
      '    process.stdout.write(`${JSON.stringify({',
      '      jsonrpc: "2.0",',
      '      id: request.id,',
      '      result: {',
      '        protocolVersion: request.params?.protocolVersion,',
      '        capabilities: {},',
      '        serverInfo: { name: "fixture-project-server", version: "1" },',
      '      },',
      '    })}\\n`);',
      '  }',
      '});',
      "",
    ].join("\n"),
  );
  await writeFile(path.join(checkout, "mcp", "workflow-server.ts"), "export {};\n");
  await writeFile(
    path.join(checkout, "plugin", "workflow.ts"),
    'export default { id: "fixture-workflow" };\n',
  );
  await writeFile(
    path.join(checkout, "plugin", "herdr-agent-state.js"),
    "export const HerdrAgentStatePlugin = async () => ({});\n",
  );
  await writeFile(path.join(checkout, "launcher", "kilo.cmd"), "@echo off\r\n");
  await writeFile(
    path.join(checkout, "launcher", "kilo-with-prompt.ps1"),
    "param()\n",
  );
  for (const skill of [
    "implement-task",
    "test-verification",
    "code-review",
    "readability-review",
  ]) {
    await writeFile(
      path.join(checkout, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: fixture\n---\n\n# ${skill}\n`,
    );
  }
  for (const relativePath of [
    "project/kilo/plugin/workflow.ts",
    "project/kilo/plugin/herdr-agent-state.js",
    "project/kilo/command/implement-task.md",
  ]) {
    await writeFile(
      path.join(checkout, ...relativePath.split("/")),
      await readFile(path.join(CHECKOUT_ROOT, ...relativePath.split("/"))),
    );
  }
  await writeFile(
    path.join(checkout, "package.json"),
    `${JSON.stringify({
      name: "fixture-project-runtime",
      private: true,
      type: "module",
      dependencies: { "fixture-package": "1.0.0" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(checkout, "package-lock.json"),
    `${JSON.stringify({ name: "fixture-project-runtime", lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  await writeFile(
    path.join(checkout, "node_modules", "fixture-package", "index.js"),
    "export const fixture = true;\n",
  );
  return { root, checkout, project, privateRoot };
}

function install(
  fixture: Fixture,
  overrides: Partial<Parameters<typeof executeProjectScopeInstallOperation>[0]> = {},
) {
  return executeProjectScopeInstallOperation({
    checkoutRoot: fixture.checkout,
    projectRoot: fixture.project,
    privateRestoreRoot: fixture.privateRoot,
    skipDependencies: true,
    preflightBackend: passingPreflight(),
    projectedAt: PROJECTED_AT,
    ...overrides,
  });
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

function projectPath(fixture: Fixture, ...segments: string[]): string {
  return path.join(fixture.project, ...segments);
}

function toolkitPath(fixture: Fixture, ...segments: string[]): string {
  return projectPath(fixture, ...PROJECT_TOOLKIT_ROOT.split("/"), ...segments);
}

function ownershipPaths(fixture: Fixture) {
  return resolveOwnershipPaths("project", fixture.project, fixture.privateRoot);
}

function readProjectManifest(fixture: Fixture) {
  return readOwnershipManifest(ownershipPaths(fixture).manifestPath, {
    root: fixture.project,
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (isErrorCode(error, "EISDIR") || isErrorCode(error, "EPERM")) return true;
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function initializeWorkerServer(
  registration: { command: string; args: string[]; env: Record<string, string> },
  cwd: string,
): Promise<Record<string, any>> {
  const child = spawn(registration.command, registration.args, {
    cwd,
    env: {
      ...process.env,
      ...registration.env,
      WORKFLOW_ROLE: "tests",
      WORKFLOW_RUN_ID: "run-project-install-portable",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  })}\n`);

  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Portable MCP launch timed out: ${stderr}`));
      }, 10_000);
      const inspect = () => {
        const line = stdout.split("\n").find(Boolean);
        if (!line) return;
        clearTimeout(timeout);
        resolve(JSON.parse(line));
      };
      child.stdout.on("data", inspect);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        if (stdout.trim()) return;
        clearTimeout(timeout);
        reject(new Error(`Portable MCP launch exited with code ${code}: ${stderr}`));
      });
    });
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

async function cleanup(fixture: Fixture): Promise<void> {
  await rm(fixture.root, { recursive: true, force: true });
}
