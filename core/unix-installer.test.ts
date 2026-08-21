import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { executeUnixInstallOperation } from "./unix-installer.ts";
import { readOwnershipManifest, resolveOwnershipPaths } from "./ownership-manifest.ts";
import { defaultCheckoutRoot } from "../scripts/unix-install.ts";

const CHECKOUT_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("Unix CLI defaults its checkout to this repository", () => {
  assert.equal(defaultCheckoutRoot(), CHECKOUT_ROOT);
});

test("Unix Kilo profile installation preserves exact surrounding bytes, including no trailing newline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unix-installer-profile-"));
  const home = path.join(root, "home with spaces");
  const profile = path.join(home, ".bashrc");
  await mkdir(home, { recursive: true });
  await writeFile(profile, "keep=this-value", "utf8");
  try {
    const request = {
      scope: "user" as const,
      selections: "kilo" as const,
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      profilePath: profile,
      skipDependencies: true,
      environment: {},
      preflightBackend: passingPreflight(),
      projectedAt: "2026-08-20T12:00:00.000Z",
    };
    await executeUnixInstallOperation(request);
    const installed = await readFile(profile, "utf8");
    assert.match(installed, /# >>> kilo-herdr-engineering-workflow >>>/);
    assert.equal(
      readOwnershipManifest(resolveOwnershipPaths("user", home).manifestPath, { root: home })
        .insertedBlocks.length,
      1,
    );

    await executeUnixInstallOperation({
      ...request,
      operation: "uninstall",
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.equal(await readFile(profile, "utf8"), "keep=this-value");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Unix uninstall retains an edited owned profile block and reports it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "unix-installer-edited-profile-"));
  const home = path.join(root, "home");
  const profile = path.join(home, ".profile");
  await mkdir(home, { recursive: true });
  await writeFile(profile, "# before\n", "utf8");
  try {
    const request = {
      scope: "user" as const,
      checkoutRoot: CHECKOUT_ROOT,
      homeRoot: home,
      profilePath: profile,
      skipDependencies: true,
      environment: {},
      preflightBackend: passingPreflight(),
      projectedAt: "2026-08-20T12:00:00.000Z",
    };
    await executeUnixInstallOperation(request);
    const changed = (await readFile(profile, "utf8"))
      .replace("export KILO_CONFIG_DIR=", "export KILO_CONFIG_DIR_EDITED=");
    await writeFile(profile, changed, "utf8");

    const result = await executeUnixInstallOperation({
      ...request,
      operation: "uninstall",
      projectedAt: "2026-08-20T12:01:00.000Z",
    });
    assert.ok(result.transaction.warnings.some((warning) => warning.code === "modified-owned-content"));
    assert.match(await readFile(profile, "utf8"), /KILO_CONFIG_DIR_EDITED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function passingPreflight() {
  return {
    checkHarness: () => true,
    checkNode: () => true,
    checkNpm: () => true,
    checkDependencies: () => true,
    checkHerdr: () => true,
    checkIntegration: () => true,
  };
}
