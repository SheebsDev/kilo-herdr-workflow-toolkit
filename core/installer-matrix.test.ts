import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { InstallPreflightBackend } from "./install-plan.ts";
import { readOwnershipManifest, resolveOwnershipPaths } from "./ownership-manifest.ts";
import { executeUnixInstallOperation } from "./unix-installer.ts";
import type { UnixInstallRequest, UnixInstallResult } from "./unix-installer.ts";
import {
  defaultProjectRestoreRoot,
  executeWindowsInstallOperation,
} from "./windows-installer.ts";
import type {
  WindowsInstallRequest,
  WindowsInstallResult,
} from "./windows-installer.ts";

const CHECKOUT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const PLATFORM_ADAPTERS = ["unix", "windows"] as const;
const MATRIX_CASES = [
  { platform: "unix", scope: "user", selection: "kilo" },
  { platform: "unix", scope: "project", selection: "claude" },
  { platform: "windows", scope: "user", selection: "codex" },
  { platform: "windows", scope: "project", selection: "all" },
] as const;

test("Unix and Windows wrappers smoke each scope and use stable default project restore roots", async () => {
  for (const { platform, scope, selection } of MATRIX_CASES) {
    const fixture = await createFixture(`${platform}-${scope}-${selection}`);
    try {
      const request = createRequest(platform, scope, selection, fixture);
      const installed = await execute(platform, request);
      assert.equal(installed.transaction.status, "committed");
      assert.deepEqual(installed.preflightPlan.harnesses, expectedHarnesses(selection));

      const destination = scope === "user" ? fixture.home : fixture.project;
      const ownershipPath = resolveOwnershipPaths(scope, destination, fixture.privateRoot).manifestPath;
      assert.deepEqual(
        readOwnershipManifest(ownershipPath, { root: destination }).harnesses,
        expectedHarnesses(selection),
      );

      const repeated = await execute(platform, { ...request, operation: "update" });
      assert.equal(repeated.transaction.status, "committed");

      const uninstalled = await execute(platform, { ...request, operation: "uninstall" });
      assert.equal(uninstalled.transaction.status, "committed");
      assert.equal(await exists(ownershipPath), false);
      assert.equal(await readFile(path.join(fixture.project, ".workflow", "sentinel"), "utf8"), "keep\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }

  const home = path.resolve("C:/Users/test user");
  const project = path.resolve("C:/Work/project with spaces");
  const first = defaultProjectRestoreRoot(home, project);
  assert.equal(first, defaultProjectRestoreRoot(home, project));
  assert.match(first, /project-restore-data/);
  assert.equal(path.dirname(path.dirname(path.dirname(first))), path.join(home, ".config"));
});

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly home: string;
  readonly project: string;
  readonly privateRoot: string;
  readonly environmentStore: string;
  readonly profile: string;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `installer-matrix-${name}-`));
  const checkout = path.join(root, "checkout with spaces");
  const home = path.join(root, "home with spaces");
  const project = path.join(root, "project with spaces");
  const privateRoot = path.join(root, "private restore data");
  const environmentStore = path.join(home, "environment.json");
  const profile = path.join(home, ".profile");

  await mkdir(checkout, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(path.join(project, ".workflow"), { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await writeFile(path.join(project, ".workflow", "sentinel"), "keep\n");

  for (const directory of [
    "core",
    "mcp",
    "launcher",
    "skills",
    "plugin",
    "command",
    "project/kilo",
  ]) {
    await cp(path.join(CHECKOUT_ROOT, directory), path.join(checkout, directory), { recursive: true });
  }
  await mkdir(path.join(checkout, "node_modules", "fixture-package"), { recursive: true });
  await writeFile(path.join(checkout, "node_modules", "fixture-package", "index.js"), "export const fixture = true;\n");
  await writeFile(
    path.join(checkout, "package.json"),
    `${JSON.stringify({
      name: "installer-matrix-fixture",
      private: true,
      type: "module",
      dependencies: { "fixture-package": "1.0.0" },
    }, null, 2)}\n`,
  );
  await writeFile(
    path.join(checkout, "package-lock.json"),
    `${JSON.stringify({ name: "installer-matrix-fixture", lockfileVersion: 3, packages: {} }, null, 2)}\n`,
  );
  return { root, checkout, home, project, privateRoot, environmentStore, profile };
}

function createRequest(
  platform: typeof PLATFORM_ADAPTERS[number],
  scope: "user" | "project",
  selection: HarnessSelection,
  fixture: Fixture,
): UnixInstallRequest | WindowsInstallRequest {
  const common = {
    scope,
    selections: selection,
    checkoutRoot: fixture.checkout,
    homeRoot: fixture.home,
    projectRoot: scope === "project" ? fixture.project : undefined,
    privateRestoreRoot: fixture.privateRoot,
    skipDependencies: true,
    preflightBackend: passingPreflight(),
    environment: {},
  } as const;
  return platform === "unix"
    ? { ...common, profilePath: fixture.profile }
    : { ...common, environmentStorePath: fixture.environmentStore };
}

function execute(
  platform: typeof PLATFORM_ADAPTERS[number],
  request: UnixInstallRequest | WindowsInstallRequest,
): Promise<UnixInstallResult | WindowsInstallResult> {
  return platform === "unix"
    ? executeUnixInstallOperation(request as UnixInstallRequest)
    : executeWindowsInstallOperation(request as WindowsInstallRequest);
}

type HarnessSelection = "kilo" | "claude" | "codex" | "all";

function expectedHarnesses(selection: HarnessSelection): string[] {
  return selection === "all" ? ["kilo", "claude", "codex"] : [selection];
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}
