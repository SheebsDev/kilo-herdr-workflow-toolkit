import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  compileExecutableInstallPlan,
} from "./executable-install-plan.ts";
import type {
  ExecutableInstallPlan,
  MetadataResourceObservation,
  TransitionAdapterContext,
} from "./executable-install-plan.ts";
import {
  FileSystemInstallAdapter,
} from "./filesystem-install-adapter.ts";
import type {
  DependencyTreePrepareRequest,
  FileSystemInstallFaultEvent,
} from "./filesystem-install-adapter.ts";
import {
  copyFileSystemTree,
  snapshotFileSystemTree,
} from "./filesystem-tree.ts";
import type { InstallPlan, PlannedOwnedChange } from "./install-plan.ts";
import {
  InstallTransactionError,
  executeInstallTransaction,
} from "./install-transaction.ts";
import {
  createOwnershipManifest,
  hashOwnedValue,
  serializeOwnershipManifest,
} from "./ownership-manifest.ts";
import type { OwnershipManifest } from "./ownership-manifest.ts";

const PROJECTED_AT = "2026-08-20T18:00:00.000Z";
const MANIFEST_RELATIVE_PATH =
  ".agents/toolkits/kilo-herdr-engineering-workflow/ownership.json";

test("real adapters commit binary payload and metadata then remove private staging", async () => {
  const fixture = await createFixture("binary path with spaces");
  const desired = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x41]);
  try {
    const plan = await createFilePlan(fixture, {
      desired,
      relativePath: "payload with spaces/runtime.bin",
    });
    const adapter = new FileSystemInstallAdapter({ temporaryRoot: fixture.transactions });

    const result = await executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
    });

    assert.equal(result.committed, true);
    assert.deepEqual(
      await readFile(resolveRelative(fixture.destination, "payload with spaces/runtime.bin")),
      desired,
    );
    assert.equal(
      hash(await readFile(resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH))),
      plan.transitions.find((transition) => transition.kind === "ownership-manifest")!.desired.type === "file"
        ? plan.transitions.find((transition) => transition.kind === "ownership-manifest")!.desired.sha256
        : "",
    );
    assert.deepEqual(await readdir(fixture.transactions), []);
    if (process.platform !== "win32") {
      const mode = (await lstat(resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH))).mode & 0o777;
      assert.equal(mode & 0o077, 0);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("staging faults leave all live payload and metadata resources unchanged", async () => {
  const fixture = await createFixture("staging fault");
  try {
    const plan = await createFilePlan(fixture, {
      desired: Buffer.from("new payload\r\n", "utf8"),
    });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "prepare:after-stage" &&
          event.context.transition.kind === "ownership-manifest",
        "manifest staging fault",
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        assertTransactionFailure(error, "staging");
        return true;
      },
    );

    await assert.rejects(readFile(resolveRelative(fixture.destination, "payload/runtime.bin")), /ENOENT/);
    await assert.rejects(readFile(resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH)), /ENOENT/);
    assert.deepEqual(await readdir(fixture.transactions), []);
  } finally {
    await fixture.cleanup();
  }
});

test("write-then-throw is compensated with exact baseline bytes", async () => {
  const fixture = await createFixture("write then throw");
  const baseline = Buffer.from([0x00, 0xfe, 0x0d, 0x0a, 0x41]);
  const desired = Buffer.from([0x00, 0xfd, 0x0a, 0x42]);
  try {
    const plan = await createFilePlan(fixture, { baseline, desired });
    const file = plan.transitions.find((transition) => transition.kind === "file")!;
    const baselineManifest = await readFile(
      resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH),
    );
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:after-mutation" &&
          event.context.transition.kind === "file",
        "fault after payload write",
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const failure = assertTransactionFailure(error, "apply");
        assert.match(failure.cause.message, /fault after payload write/);
        assert.deepEqual(failure.intentTransitionIds, [file.id]);
        assert.equal(failure.rollback.complete, true);
        return true;
      },
    );

    assert.deepEqual(
      await readFile(resolveRelative(fixture.destination, "payload/runtime.bin")),
      baseline,
    );
    assert.deepEqual(
      await readFile(resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH)),
      baselineManifest,
    );
    assert.deepEqual(await readdir(fixture.transactions), []);
  } finally {
    await fixture.cleanup();
  }
});

test("concurrent payload state is retained with named private recovery evidence", async () => {
  const fixture = await createFixture("concurrent residual");
  const baseline = Buffer.from("baseline\0bytes", "utf8");
  const desired = Buffer.from("desired\0bytes", "utf8");
  const concurrent = Buffer.from("concurrent\0bytes", "utf8");
  const targetPath = resolveRelative(fixture.destination, "payload/runtime.bin");
  try {
    const plan = await createFilePlan(fixture, { baseline, desired });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:after-mutation" &&
          event.context.transition.kind === "file",
        "concurrent payload edit",
        async () => await writeFile(targetPath, concurrent),
      ),
    });

    let recoveryPath = "";
    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const failure = assertTransactionFailure(error, "apply");
        assert.equal(failure.rollback.complete, false);
        assert.equal(failure.rollback.residuals.length, 1);
        assert.equal(failure.rollback.residuals[0].reason, "unknown-state");
        assert.equal(failure.rollback.residuals[0].recoveryArtifacts.length, 1);
        recoveryPath = failure.rollback.residuals[0].recoveryArtifacts[0];
        return true;
      },
    );

    assert.deepEqual(await readFile(targetPath), concurrent);
    assert.deepEqual(await readFile(recoveryPath), baseline);
    assert.equal(isInside(fixture.transactions, recoveryPath), true);
    if (process.platform !== "win32") {
      assert.equal((await lstat(recoveryPath)).mode & 0o077, 0);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rollback removes created parents only while they remain empty", async () => {
  const fixture = await createFixture("populated parent");
  const parentPath = resolveRelative(fixture.destination, "new-parent");
  const unrelatedPath = path.join(parentPath, "unrelated.txt");
  try {
    const plan = await createFilePlan(fixture, {
      desired: Buffer.from("payload", "utf8"),
      relativePath: "new-parent/runtime.bin",
      missingParents: ["new-parent"],
    });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:before-mutation" &&
          event.context.transition.kind === "file",
        "stop after parent creation",
        async () => await writeFile(unrelatedPath, "unrelated", "utf8"),
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const failure = assertTransactionFailure(error, "apply");
        const parentResidual = failure.rollback.residuals.find((residual) =>
          residual.target.relativePath === "new-parent"
        );
        assert.ok(parentResidual);
        assert.deepEqual(parentResidual.recoveryArtifacts, []);
        return true;
      },
    );

    assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated");
    await assert.rejects(readFile(path.join(parentPath, "runtime.bin")), /ENOENT/);
  } finally {
    await fixture.cleanup();
  }
});

test("changed expected state is rejected at the immediate apply boundary", async () => {
  const fixture = await createFixture("changed expected state");
  const baseline = Buffer.from("baseline", "utf8");
  const concurrent = Buffer.from("user changed", "utf8");
  const targetPath = resolveRelative(fixture.destination, "payload/runtime.bin");
  try {
    const plan = await createFilePlan(fixture, {
      baseline,
      desired: Buffer.from("desired", "utf8"),
    });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:before-mutation" &&
          event.context.transition.kind === "file",
        "concurrent pre-mutation edit",
        async () => await writeFile(targetPath, concurrent),
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const failure = assertTransactionFailure(error, "apply");
        assert.equal(failure.rollback.complete, false);
        return true;
      },
    );
    assert.deepEqual(await readFile(targetPath), concurrent);
  } finally {
    await fixture.cleanup();
  }
});

test("dependency rollback restores internal links and bytes after metadata failure", async () => {
  const fixture = await createFixture("dependency links");
  const targetPath = resolveRelative(fixture.destination, "payload/node_modules");
  const oldTemplate = path.join(fixture.root, "old dependency template");
  const newTemplate = path.join(fixture.root, "new dependency template");
  try {
    await createDependencyTree(oldTemplate, "old package");
    await createDependencyTree(newTemplate, "new package");
    await mkdir(path.dirname(targetPath), { recursive: true });
    copyFileSystemTree(oldTemplate, targetPath, { allowInternalLinks: true });
    const oldHash = snapshotFileSystemTree(targetPath, { allowInternalLinks: true }).sha256;
    const desiredHash = snapshotFileSystemTree(newTemplate, { allowInternalLinks: true }).sha256;
    const plan = await createDependencyPlan(fixture, oldHash, desiredHash);
    const baselineManifest = await readFile(
      resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH),
    );
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      prepareDependencyTree: copyDependencyPreparer(newTemplate),
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:after-mutation" &&
          event.context.transition.kind === "ownership-manifest",
        "manifest write fault",
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const failure = assertTransactionFailure(error, "apply");
        assert.equal(failure.rollback.complete, true);
        return true;
      },
    );

    assert.equal(
      snapshotFileSystemTree(targetPath, { allowInternalLinks: true }).sha256,
      oldHash,
    );
    assert.equal(
      await readFile(path.join(targetPath, "package", "index.js"), "utf8"),
      "old package",
    );
    assert.equal(isInside(targetPath, await realLinkTarget(path.join(targetPath, "alias"))), true);
    assert.deepEqual(
      await readFile(resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH)),
      baselineManifest,
    );
    assert.deepEqual(await readdir(fixture.transactions), []);
  } finally {
    await fixture.cleanup();
  }
});

test("empty directory-tree removal restores exactly when provisional metadata fails", async () => {
  const fixture = await createFixture("empty directory tree");
  const treePath = resolveRelative(fixture.destination, "payload/empty-owned");
  const unrelatedPath = resolveRelative(fixture.destination, "payload/unrelated.txt");
  try {
    await mkdir(treePath, { recursive: true });
    await writeFile(unrelatedPath, "unrelated", "utf8");
    const treeHash = snapshotFileSystemTree(treePath).sha256;
    const manifest = createOwnershipManifest({
      manifestId: "filesystem-directory-manifest",
      scope: "project",
      harnesses: ["kilo"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      directories: [{
        id: "empty-directory",
        harnesses: ["kilo"],
        path: "payload/empty-owned",
        emptyAtInstall: true,
        snapshotSha256: treeHash,
      }],
    });
    await writeFile(
      resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH),
      serializeOwnershipManifest(manifest),
      { mode: 0o600 },
    );
    const plan = compile({
      operation: "uninstall",
      scope: "project",
      harnesses: ["kilo"],
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      sourceInventory: [],
      destinationPreconditions: [{
        path: treePath,
        relativePath: "payload/empty-owned",
        exists: true,
        kind: "directory",
        snapshotSha256: treeHash,
        ownership: "owned-unchanged",
        expectedSha256: treeHash,
      }],
      requiredParentDirectories: [],
      ownedChanges: [{
        id: "empty-directory",
        artifactType: "directory",
        harnesses: ["kilo"],
        destinationPath: treePath,
        destinationRelativePath: "payload/empty-owned",
        action: "remove",
        sha256: treeHash,
      }],
      rollbackInputs: [],
      prerequisites: [],
      warnings: [],
    }, fixture, manifest);
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "apply:after-mutation" &&
          event.context.transition.kind === "ownership-manifest",
        "metadata removal fault",
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        assert.equal(assertTransactionFailure(error, "apply").rollback.complete, true);
        return true;
      },
    );
    assert.equal(snapshotFileSystemTree(treePath).sha256, treeHash);
    assert.deepEqual(await readdir(treePath), []);
    assert.equal(await readFile(unrelatedPath, "utf8"), "unrelated");
    assert.deepEqual(await readdir(fixture.transactions), []);
  } finally {
    await fixture.cleanup();
  }
});

test("private restore-data staging is restrictive, exact, and rollback-safe", async () => {
  const fixture = await createFixture("private restore data");
  try {
    const plan = await createRestoreDataPlan(fixture);
    const transition = plan.transitions.find((candidate) => candidate.kind === "restore-data")!;
    const context: TransitionAdapterContext = { plan, transition };
    const adapter = new FileSystemInstallAdapter({ temporaryRoot: fixture.transactions });
    const signal = new AbortController().signal;
    const baseline = await adapter.inspect(context, signal);
    const prepared = await adapter.prepare(context, baseline, signal);
    await adapter.apply(context, prepared, signal);

    const restorePath = resolveRelative(fixture.privateRoot, "restore-data.json");
    assert.equal(hash(await readFile(restorePath)), transition.desired.type === "file" ? transition.desired.sha256 : "");
    if (process.platform !== "win32") {
      assert.equal((await lstat(restorePath)).mode & 0o077, 0);
    }
    await adapter.rollback(context, undefined, signal);
    await adapter.cleanup(context, prepared, "rolled-back", signal);
    await assert.rejects(readFile(restorePath), /ENOENT/);
    assert.deepEqual(await readdir(fixture.transactions), []);
  } finally {
    await fixture.cleanup();
  }
});

test("escaping dependency links and destination junctions fail before unsafe mutation", async () => {
  const fixture = await createFixture("escape attempts");
  const outside = path.join(fixture.root, "outside");
  try {
    await mkdir(outside);
    await writeFile(path.join(outside, "untouched.txt"), "untouched", "utf8");
    const plan = await createFreshDependencyPlan(fixture, "a".repeat(64));
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      prepareDependencyTree: async ({ outputPath }) => {
        await mkdir(outputPath);
        await symlink(
          outside,
          path.join(outputPath, "escape"),
          process.platform === "win32" ? "junction" : "dir",
        );
      },
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        assertTransactionFailure(error, "staging");
        return true;
      },
    );
    assert.equal(await readFile(path.join(outside, "untouched.txt"), "utf8"), "untouched");
    await assert.rejects(readFile(resolveRelative(fixture.destination, "payload/node_modules")), /ENOENT|EISDIR/);

    const junctionPlan = await createFilePlan(fixture, {
      desired: Buffer.from("blocked", "utf8"),
      relativePath: "linked/runtime.bin",
      missingParents: ["linked"],
    });
    await symlink(
      outside,
      resolveRelative(fixture.destination, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const junctionAdapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
    });
    await assert.rejects(
      executeInstallTransaction({
        plan: junctionPlan,
        resolveAdapter: () => junctionAdapter,
      }),
      /link|junction/i,
    );
    assert.equal(await readFile(path.join(outside, "untouched.txt"), "utf8"), "untouched");
  } finally {
    await fixture.cleanup();
  }
});

test("root replacement after staging is detected before adapter mutation", async () => {
  const fixture = await createFixture("root replacement");
  const movedDestination = path.join(fixture.root, "moved destination");
  const outside = path.join(fixture.root, "replacement outside");
  try {
    await mkdir(outside);
    const plan = await createFilePlan(fixture, {
      desired: Buffer.from("never installed", "utf8"),
    });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "prepare:after-stage" &&
          event.context.transition.kind === "file",
        "replace destination root",
        async () => {
          await rename(fixture.destination, movedDestination);
          await symlink(
            outside,
            fixture.destination,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
        false,
      ),
    });

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      /root|link|junction/i,
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await fixture.cleanup();
  }
});

test("cleanup faults are reported without reversing a verified commit", async () => {
  const fixture = await createFixture("cleanup fault");
  try {
    const plan = await createFilePlan(fixture, {
      desired: Buffer.from("committed", "utf8"),
    });
    const adapter = new FileSystemInstallAdapter({
      temporaryRoot: fixture.transactions,
      injectFault: failOnce(
        (event) =>
          event.boundary === "cleanup:before" &&
          event.context.transition.kind === "file",
        "cleanup fault",
      ),
    });

    const result = await executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
    });
    assert.equal(result.committed, true);
    assert.equal(result.cleanupErrors.some((issue) => issue.transitionId?.includes("file")), true);
    assert.equal(
      await readFile(resolveRelative(fixture.destination, "payload/runtime.bin"), "utf8"),
      "committed",
    );
  } finally {
    await fixture.cleanup();
  }
});

interface Fixture {
  readonly root: string;
  readonly checkout: string;
  readonly destination: string;
  readonly privateRoot: string;
  readonly transactions: string;
  cleanup(): Promise<void>;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), `filesystem-adapter-${name}-`));
  const fixture = {
    root,
    checkout: path.join(root, "checkout"),
    destination: path.join(root, "destination"),
    privateRoot: path.join(root, "private"),
    transactions: path.join(root, "transactions"),
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  await Promise.all([
    mkdir(path.join(fixture.checkout, "core"), { recursive: true }),
    mkdir(resolveRelative(fixture.destination, path.dirname(MANIFEST_RELATIVE_PATH)), {
      recursive: true,
    }),
    mkdir(fixture.privateRoot, { recursive: true }),
    mkdir(fixture.transactions, { recursive: true }),
  ]);
  return fixture;
}

async function createFilePlan(
  fixture: Fixture,
  options: {
    readonly baseline?: Buffer;
    readonly desired: Buffer;
    readonly relativePath?: string;
    readonly missingParents?: readonly string[];
  },
): Promise<ExecutableInstallPlan> {
  const relativePath = options.relativePath ?? "payload/runtime.bin";
  const sourcePath = "core/runtime.bin";
  const targetPath = resolveRelative(fixture.destination, relativePath);
  await writeFile(resolveRelative(fixture.checkout, sourcePath), options.desired);
  for (const parent of parentPaths(relativePath)) {
    if (!options.missingParents?.includes(parent)) {
      await mkdir(resolveRelative(fixture.destination, parent), { recursive: true });
    }
  }

  let manifest: OwnershipManifest | undefined;
  if (options.baseline) {
    await writeFile(targetPath, options.baseline);
    manifest = createOwnershipManifest({
      manifestId: "filesystem-file-manifest",
      scope: "project",
      harnesses: ["kilo"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      files: [{
        id: "runtime-file",
        artifactType: "shared-runtime",
        harnesses: ["kilo"],
        path: relativePath,
        sha256: hash(options.baseline),
      }],
    });
    await writeFile(
      resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH),
      serializeOwnershipManifest(manifest),
      { mode: 0o600 },
    );
  }

  const change: PlannedOwnedChange = {
    id: "runtime-file",
    artifactType: "shared-runtime",
    harnesses: ["kilo"],
    sourcePath,
    destinationPath: targetPath,
    destinationRelativePath: relativePath,
    action: options.baseline ? "replace" : "create",
    sha256: hash(options.desired),
  };
  const preflight: InstallPlan = {
    operation: options.baseline ? "update" : "install",
    scope: "project",
    harnesses: ["kilo"],
    checkoutRoot: fixture.checkout,
    destinationRoot: fixture.destination,
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath,
      destinationPath: targetPath,
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: hash(options.desired),
      size: options.desired.byteLength,
    }],
    destinationPreconditions: [{
      path: targetPath,
      relativePath,
      exists: options.baseline !== undefined,
      kind: options.baseline ? "file" : undefined,
      sha256: options.baseline ? hash(options.baseline) : undefined,
      ownership: options.baseline ? "owned-unchanged" : "unrelated",
      expectedSha256: options.baseline ? hash(options.baseline) : undefined,
    }],
    requiredParentDirectories: (options.missingParents ?? []).map((parent) => ({
      path: resolveRelative(fixture.destination, parent),
      relativePath: parent,
      harnesses: ["kilo"],
      exists: false,
    })),
    ownedChanges: [change],
    rollbackInputs: [],
    prerequisites: [],
    warnings: [],
  };
  return compile(preflight, fixture, manifest);
}

async function createDependencyPlan(
  fixture: Fixture,
  baselineHash: string,
  desiredHash: string,
): Promise<ExecutableInstallPlan> {
  const relativePath = "payload/node_modules";
  const targetPath = resolveRelative(fixture.destination, relativePath);
  const manifest = createOwnershipManifest({
    manifestId: "filesystem-dependency-manifest",
    scope: "project",
    harnesses: ["kilo"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dependencies: [{
      id: "runtime-dependencies",
      harnesses: ["kilo"],
      path: relativePath,
      packageManager: "npm",
      packageNames: ["fixture"],
      treeSha256: baselineHash,
    }],
  });
  await writeFile(
    resolveRelative(fixture.destination, MANIFEST_RELATIVE_PATH),
    serializeOwnershipManifest(manifest),
    { mode: 0o600 },
  );
  const preflight = dependencyPreflight(
    fixture,
    "update",
    baselineHash,
    desiredHash,
  );
  return compile(preflight, fixture, manifest);
}

async function createFreshDependencyPlan(
  fixture: Fixture,
  desiredHash: string,
): Promise<ExecutableInstallPlan> {
  await mkdir(resolveRelative(fixture.destination, "payload"), { recursive: true });
  return compile(
    dependencyPreflight(fixture, "install", undefined, desiredHash),
    fixture,
  );
}

async function createRestoreDataPlan(fixture: Fixture): Promise<ExecutableInstallPlan> {
  const relativePath = "config/claude.json";
  const destinationPath = resolveRelative(fixture.destination, relativePath);
  const content = Buffer.from('{"mcpServers":{}}\n', "utf8");
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, content);
  const previousValue = { command: "previous" };
  const desiredValue = { command: "node", args: ["mcp/server.ts"] };
  const change: PlannedOwnedChange = {
    id: "claude-registration",
    artifactType: "config-registration",
    harnesses: ["claude"],
    destinationPath,
    destinationRelativePath: relativePath,
    action: "replace",
    sha256: hashOwnedValue(desiredValue),
    desiredValue,
    semanticKey: "mcpServers.engineering-workflow",
    adapterKind: "claude-json",
    ownershipState: "unrelated",
  };
  return compile({
    operation: "install",
    scope: "project",
    harnesses: ["claude"],
    checkoutRoot: fixture.checkout,
    destinationRoot: fixture.destination,
    sourceInventory: [],
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: true,
      kind: "file",
      sha256: hash(content),
      ownership: "unrelated",
    }],
    requiredParentDirectories: [],
    ownedChanges: [change],
    rollbackInputs: [{
      type: "config",
      path: destinationPath,
      key: change.semanticKey!,
      existed: true,
      sha256: hashOwnedValue(previousValue),
      value: previousValue,
      content: content.toString("utf8"),
    }],
    prerequisites: [],
    warnings: [],
  }, fixture);
}

function dependencyPreflight(
  fixture: Fixture,
  operation: "install" | "update",
  baselineHash: string | undefined,
  desiredHash: string,
): InstallPlan {
  const relativePath = "payload/node_modules";
  const targetPath = resolveRelative(fixture.destination, relativePath);
  return {
    operation,
    scope: "project",
    harnesses: ["kilo"],
    checkoutRoot: fixture.checkout,
    destinationRoot: fixture.destination,
    sourceInventory: [],
    destinationPreconditions: [{
      path: targetPath,
      relativePath,
      exists: baselineHash !== undefined,
      kind: baselineHash ? "directory" : undefined,
      treeSha256: baselineHash,
      ownership: baselineHash ? "owned-unchanged" : "unrelated",
      expectedSha256: baselineHash,
    }],
    requiredParentDirectories: [],
    ownedChanges: [{
      id: "runtime-dependencies",
      artifactType: "dependency",
      harnesses: ["kilo"],
      destinationPath: targetPath,
      destinationRelativePath: relativePath,
      action: baselineHash ? "replace" : "create",
      sha256: desiredHash,
      dependencyInput: {
        packageManager: "npm",
        packageNames: ["fixture"],
      },
    }],
    rollbackInputs: [],
    prerequisites: [],
    warnings: [],
  };
}

function compile(
  preflightPlan: InstallPlan,
  fixture: Fixture,
  manifest?: OwnershipManifest,
): ExecutableInstallPlan {
  const manifestTarget: MetadataResourceObservation = {
    target: {
      root: fixture.destination,
      relativePath: MANIFEST_RELATIVE_PATH,
    },
    baseline: manifest
      ? { type: "file", sha256: hash(serializeOwnershipManifest(manifest)) }
      : { type: "absent" },
    requiredParentDirectories: [],
  };
  return compileExecutableInstallPlan({
    preflightPlan,
    projectedAt: PROJECTED_AT,
    ownership: {
      manifest,
      manifestResource: manifestTarget,
      restoreDataResource: {
        target: {
          root: fixture.privateRoot,
          relativePath: "restore-data.json",
        },
        baseline: { type: "absent" },
        requiredParentDirectories: [],
      },
    },
  });
}

async function createDependencyTree(root: string, content: string): Promise<void> {
  await mkdir(path.join(root, "package"), { recursive: true });
  await writeFile(path.join(root, "package", "index.js"), content, "utf8");
  await symlink(
    process.platform === "win32" ? path.join(root, "package") : "package",
    path.join(root, "alias"),
    process.platform === "win32" ? "junction" : "dir",
  );
}

function copyDependencyPreparer(
  templatePath: string,
): (request: DependencyTreePrepareRequest) => Promise<void> {
  return async ({ outputPath }) => {
    copyFileSystemTree(templatePath, outputPath, { allowInternalLinks: true });
  };
}

function failOnce(
  predicate: (event: FileSystemInstallFaultEvent) => boolean,
  message: string,
  beforeThrow?: () => void | Promise<void>,
  shouldThrow = true,
): (event: FileSystemInstallFaultEvent) => Promise<void> {
  let failed = false;
  return async (event) => {
    if (failed || !predicate(event)) return;
    failed = true;
    await beforeThrow?.();
    if (shouldThrow) throw new Error(message);
  };
}

function assertTransactionFailure(
  error: unknown,
  phase: InstallTransactionError["details"]["phase"],
): InstallTransactionError["details"] {
  assert.ok(error instanceof InstallTransactionError);
  assert.equal(error.details.phase, phase);
  return error.details;
}

function parentPaths(relativePath: string): string[] {
  const parts = relativePath.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function resolveRelative(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.split("/"));
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

async function realLinkTarget(linkPath: string): Promise<string> {
  return path.resolve(path.dirname(linkPath), await readlink(linkPath));
}
