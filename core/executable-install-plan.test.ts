import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  EXECUTABLE_INSTALL_PLAN_VERSION,
  compileExecutableInstallPlan,
  validateExecutableInstallPlan,
} from "./executable-install-plan.ts";
import type {
  CompileExecutableInstallPlanRequest,
  ExecutableInstallPlan,
  OwnershipCompilationInput,
} from "./executable-install-plan.ts";
import { buildInstallPlan } from "./install-plan.ts";
import type { InstallPlan, PlannedOwnedChange } from "./install-plan.ts";
import type { AgentKind } from "./model.ts";
import {
  createOwnershipManifest,
  createRestoreData,
  hashOwnedValue,
} from "./ownership-manifest.ts";

const PROJECTED_AT = "2026-08-19T12:00:00.000Z";

test("fresh install compiles deterministic parent, file, and metadata transitions without mutation", async () => {
  const fixture = await createCheckoutFixture();
  try {
    const preflight = await buildInstallPlan({
      scope: "project",
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      backend: passingBackend(),
    });
    const request = compileRequest(preflight, fixture.privateRoot);
    const before = await listTree(fixture.destination);

    const first = compileExecutableInstallPlan(request);
    const second = compileExecutableInstallPlan(request);

    assert.deepEqual(first, second);
    assert.deepEqual(first, JSON.parse(JSON.stringify(first)));
    assert.equal(first.schemaVersion, EXECUTABLE_INSTALL_PLAN_VERSION);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.transitions), true);
    assert.ok(first.transitions.some((transition) => transition.kind === "parent-directory"));
    assert.ok(first.transitions.some((transition) => transition.kind === "file"));
    assert.deepEqual(first.transitions.slice(-2).map((transition) => transition.kind), [
      "restore-data",
      "ownership-manifest",
    ]);
    assert.equal(first.projection.manifest?.files.length, preflight.ownedChanges.length);
    assert.deepEqual(await listTree(fixture.destination), before);
    assert.doesNotThrow(() => validateExecutableInstallPlan(first));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("opaque configuration changes sharing one file compile into one transition with private displaced data", () => {
  const roots = fixtureRoots("opaque-group");
  const configRelativePath = "config/claude.json";
  const configPath = resolveRelative(roots.destination, configRelativePath);
  const baselineHash = sha256('{"mcpServers":{}}\n');
  const changes: PlannedOwnedChange[] = [
    configChange("claude-one", configPath, configRelativePath, "mcpServers.one", { command: "node", args: ["one"] }),
    configChange("claude-two", configPath, configRelativePath, "mcpServers.two", { command: "node", args: ["two"] }),
  ];
  const preflight = makePlan(roots, {
    harnesses: ["claude"],
    destinationPreconditions: [{
      path: configPath,
      relativePath: configRelativePath,
      exists: true,
      kind: "file",
      sha256: baselineHash,
      ownership: "unrelated",
      priorContent: '{"mcpServers":{}}\n',
    }],
    ownedChanges: changes,
    rollbackInputs: changes.map((change, index) => ({
      type: "config" as const,
      path: configPath,
      key: change.semanticKey!,
      existed: true,
      sha256: hashOwnedValue(`prior-${index}`),
      value: `prior-${index}`,
      content: '{"mcpServers":{}}\n',
    })),
  });

  const plan = compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot));
  const opaque = plan.transitions.filter((transition) => transition.kind === "opaque-registration");

  assert.equal(opaque.length, 1);
  assert.deepEqual(opaque[0].logicalChangeIds, ["claude-one", "claude-two"]);
  assert.equal(opaque[0].stage.changes.length, 2);
  assert.deepEqual(
    opaque[0].stage.changes.map((change) => change.expectedValueSha256),
    [hashOwnedValue("prior-0"), hashOwnedValue("prior-1")],
  );
  assert.deepEqual(
    plan.projection.manifest?.configRegistrations.map((record) => record.key),
    ["mcpServers.one", "mcpServers.two"],
  );
  assert.equal(plan.projection.manifest?.displacedValues.length, 2);
  assert.deepEqual(Object.values(plan.projection.restoreData?.entries ?? {}), ["prior-0", "prior-1"]);
  assert.equal("priorContent" in opaque[0], false);
});

test("identical unowned content is not adopted into ownership", () => {
  const roots = fixtureRoots("unowned-identical");
  const relativePath = "payload/runtime.js";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const contentHash = sha256("runtime\n");
  const preflight = makePlan(roots, {
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: true,
      kind: "file",
      sha256: contentHash,
      ownership: "unrelated",
      expectedSha256: contentHash,
      priorContent: "runtime\n",
    }],
    ownedChanges: [{
      id: "runtime-file",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      action: "unchanged",
      sha256: contentHash,
    }],
  });

  const plan = compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot));

  assert.equal(plan.projection.manifest, null);
  assert.equal(plan.projection.restoreData, null);
  assert.deepEqual(plan.transitions.map((transition) => transition.kind), [
    "restore-data",
    "ownership-manifest",
  ]);
});

test("update preserves stable record identities and unselected shared harnesses", () => {
  const roots = fixtureRoots("stable-update");
  const relativePath = "payload/runtime.js";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const oldHash = sha256("old\n");
  const newHash = sha256("new\n");
  const manifest = createOwnershipManifest({
    manifestId: "stable-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [{
      id: "stable-runtime",
      artifactType: "shared-runtime",
      harnesses: ["kilo", "claude"],
      path: relativePath,
      sha256: oldHash,
    }],
  });
  const preflight = makePlan(roots, {
    operation: "update",
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: true,
      kind: "file",
      sha256: oldHash,
      ownership: "owned-unchanged",
      expectedSha256: oldHash,
      priorContent: "old\n",
    }],
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: newHash,
      size: 4,
    }],
    ownedChanges: [{
      id: "new-planner-id",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      action: "replace",
      sha256: newHash,
    }],
  });

  const plan = compileExecutableInstallPlan(
    compileRequest(preflight, roots.privateRoot, manifest),
  );
  const record = plan.projection.manifest?.files[0];

  assert.equal(record?.id, "stable-runtime");
  assert.deepEqual(record?.harnesses, ["kilo", "claude"]);
  assert.equal(record?.sha256, newHash);
});

test("partial uninstall detaches selected owners and projects modified residual content", () => {
  const roots = fixtureRoots("partial-uninstall");
  const sharedPath = "payload/shared.js";
  const modifiedPath = "payload/modified.js";
  const sharedHash = sha256("shared\n");
  const expectedModifiedHash = sha256("original\n");
  const observedModifiedHash = sha256("user edit\n");
  const manifest = createOwnershipManifest({
    manifestId: "partial-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [
      {
        id: "shared-file",
        artifactType: "shared-runtime",
        harnesses: ["kilo", "claude"],
        path: sharedPath,
        sha256: sharedHash,
      },
      {
        id: "modified-file",
        artifactType: "kilo-adapter",
        harnesses: ["kilo"],
        path: modifiedPath,
        sha256: expectedModifiedHash,
      },
    ],
  });
  const changes: PlannedOwnedChange[] = [
    preserveFile("shared-file", roots.destination, sharedPath, "shared-runtime", ["kilo", "claude"], sharedHash),
    preserveFile("modified-file", roots.destination, modifiedPath, "kilo-adapter", ["kilo"], expectedModifiedHash),
  ];
  const preflight = makePlan(roots, {
    operation: "uninstall",
    destinationPreconditions: [
      filePrecondition(roots.destination, sharedPath, sharedHash, "owned-unchanged"),
      filePrecondition(roots.destination, modifiedPath, observedModifiedHash, "owned-modified", expectedModifiedHash),
    ],
    ownedChanges: changes,
  });

  const plan = compileExecutableInstallPlan(
    compileRequest(preflight, roots.privateRoot, manifest),
  );

  assert.deepEqual(plan.projection.manifest?.files, [{
    ...manifest.files[0],
    harnesses: ["claude"],
  }]);
  assert.equal(plan.projection.manifest?.residualOwnership[0].sourceId, "modified-file");
  assert.equal(plan.projection.manifest?.residualOwnership[0].observedSha256, observedModifiedHash);
  assert.equal(plan.transitions.filter((transition) => !["restore-data", "ownership-manifest"].includes(transition.kind)).length, 0);
});

test("full uninstall emits all destructive resource variants and deletes final metadata", () => {
  const roots = fixtureRoots("full-uninstall");
  const filePath = "payload/file.js";
  const directoryPath = "empty-dir";
  const dependencyPath = "node_modules";
  const configPath = "config/claude.json";
  const fileHash = sha256("file\n");
  const directoryHash = sha256("directory snapshot");
  const dependencyHash = sha256("dependency tree");
  const installed = { command: "node", args: ["server.ts"] };
  const original = { command: "old" };
  const restoreDataId = "config-restore";
  const manifest = createOwnershipManifest({
    manifestId: "full-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [{
      id: "owned-file",
      artifactType: "shared-runtime",
      harnesses: ["kilo", "claude"],
      path: filePath,
      sha256: fileHash,
    }],
    directories: [{
      id: "owned-directory",
      harnesses: ["kilo", "claude"],
      path: directoryPath,
      emptyAtInstall: true,
      snapshotSha256: directoryHash,
    }],
    dependencies: [{
      id: "owned-dependencies",
      harnesses: ["kilo", "claude"],
      path: dependencyPath,
      packageManager: "npm",
      packageNames: ["fixture"],
      treeSha256: dependencyHash,
    }],
    configRegistrations: [{
      id: "owned-config",
      harness: "claude",
      path: configPath,
      key: "mcpServers.engineering-workflow",
      installedValue: installed,
      installedValueSha256: hashOwnedValue(installed),
    }],
    displacedValues: [{
      id: "owned-config-displaced",
      harness: "claude",
      path: configPath,
      key: "mcpServers.engineering-workflow",
      restoreDataId,
      originalValueSha256: hashOwnedValue(original),
      installedValueSha256: hashOwnedValue(installed),
      valueKind: "json",
      secret: true,
    }],
  });
  const restoreData = createRestoreData({ [restoreDataId]: original });
  const configAbsolutePath = resolveRelative(roots.destination, configPath);
  const preflight = makePlan(roots, {
    operation: "uninstall",
    harnesses: ["kilo", "claude"],
    destinationPreconditions: [
      filePrecondition(roots.destination, filePath, fileHash, "owned-unchanged"),
      {
        path: resolveRelative(roots.destination, directoryPath),
        relativePath: directoryPath,
        exists: true,
        kind: "directory",
        snapshotSha256: directoryHash,
        ownership: "owned-unchanged",
        expectedSha256: directoryHash,
        entries: [],
      },
      {
        path: resolveRelative(roots.destination, dependencyPath),
        relativePath: dependencyPath,
        exists: true,
        kind: "directory",
        treeSha256: dependencyHash,
        ownership: "owned-unchanged",
        expectedSha256: dependencyHash,
        entries: [],
      },
      {
        path: configAbsolutePath,
        relativePath: configPath,
        exists: true,
        kind: "file",
        sha256: sha256("config bytes"),
        ownership: "owned-unchanged",
        expectedSha256: hashOwnedValue(installed),
      },
    ],
    ownedChanges: [
      removeChange(manifest.files[0], roots.destination, "shared-runtime", fileHash),
      removeChange(manifest.directories[0], roots.destination, "directory", directoryHash),
      removeChange(manifest.dependencies[0], roots.destination, "dependency", dependencyHash),
      {
        id: "owned-config-displaced",
        artifactType: "config-registration",
        harnesses: ["claude"],
        destinationPath: configAbsolutePath,
        destinationRelativePath: configPath,
        action: "restore",
        sha256: hashOwnedValue(original),
        desiredValue: original,
        semanticKey: "mcpServers.engineering-workflow",
        adapterKind: "claude-json",
        ownershipState: "owned-unchanged",
      },
    ],
    rollbackInputs: [{
      type: "config",
      path: configAbsolutePath,
      key: "mcpServers.engineering-workflow",
      existed: true,
      sha256: hashOwnedValue(installed),
      value: installed,
    }],
  });

  const plan = compileExecutableInstallPlan(
    compileRequest(preflight, roots.privateRoot, manifest, restoreData),
  );
  const kinds = new Set(plan.transitions.map((transition) => transition.kind));

  assert.ok(kinds.has("file"));
  assert.ok(kinds.has("directory-tree"));
  assert.ok(kinds.has("dependency-tree"));
  assert.ok(kinds.has("opaque-registration"));
  assert.equal(plan.projection.manifest, null);
  assert.equal(plan.projection.restoreData, null);
  assert.equal(plan.transitions.at(-2)?.desired.type, "absent");
  assert.equal(plan.transitions.at(-1)?.desired.type, "absent");
});

test("runtime validator rejects unsupported versions, unsafe paths, collisions, references, ordering, and overlaps", async () => {
  const fixture = await createCheckoutFixture();
  try {
    const preflight = await buildInstallPlan({
      scope: "project",
      checkoutRoot: fixture.checkout,
      destinationRoot: fixture.destination,
      backend: passingBackend(),
    });
    const plan = compileExecutableInstallPlan(compileRequest(preflight, fixture.privateRoot));
    const fileIndex = plan.transitions.findIndex((transition) => transition.kind === "file");
    const otherFileIndex = plan.transitions.findIndex(
      (transition, index) => transition.kind === "file" && index !== fileIndex,
    );

    assert.throws(
      () => validateExecutableInstallPlan({ ...plan, schemaVersion: 999 }),
      /unsupported/i,
    );
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[fileIndex].target.relativePath = ".workflow/history";
    }, /path|normalized/i);
    assertInvalidMutation(plan, (copy) => {
      copy.resourceRoots.push(path.join(copy.destinationRoot, ".workflow"));
      copy.transitions[fileIndex].target = {
        root: path.join(copy.destinationRoot, ".workflow"),
        relativePath: "history",
      };
    }, /path|normalized/i);
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[otherFileIndex].target = { ...copy.transitions[fileIndex].target };
    }, /collision/i);
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[fileIndex].dependsOn = ["missing-transition"];
    }, /missing transition/i);
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[fileIndex].order += 1;
    }, /order/i);
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[otherFileIndex].target.relativePath =
        `${copy.transitions[fileIndex].target.relativePath}/child`;
      copy.transitions[otherFileIndex].dependsOn = Array.from(new Set([
        ...copy.transitions[otherFileIndex].dependsOn,
        ...copy.transitions[fileIndex].dependsOn,
      ]));
    }, /overlapping/i);
    assertInvalidMutation(plan, (copy) => {
      copy.transitions[otherFileIndex].logicalChangeIds = [
        ...copy.transitions[fileIndex].logicalChangeIds,
      ];
      copy.transitions[otherFileIndex].ownershipEffects = [
        ...copy.transitions[fileIndex].ownershipEffects,
      ];
    }, /multiple transitions/i);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("compiler refuses forced replacement of unrelated payload without a private displaced-resource contract", () => {
  const roots = fixtureRoots("forced-payload");
  const relativePath = "payload/runtime.js";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const oldHash = sha256("unowned\n");
  const newHash = sha256("owned\n");
  const preflight = makePlan(roots, {
    destinationPreconditions: [filePrecondition(roots.destination, relativePath, oldHash, "unrelated")],
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: newHash,
      size: 6,
    }],
    ownedChanges: [{
      id: "forced-runtime",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      action: "replace",
      sha256: newHash,
    }],
    rollbackInputs: [{
      type: "file",
      path: destinationPath,
      existed: true,
      kind: "file",
      sha256: oldHash,
      content: "unowned\n",
    }],
  });

  assert.throws(
    () => compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot)),
    /private displaced-resource contract/i,
  );
});

test("project plans reject commit-intended restore-data targets", () => {
  const roots = fixtureRoots("private-restore");
  const preflight = makePlan(roots);
  const request = compileRequest(preflight, roots.destination);

  assert.throws(
    () => compileExecutableInstallPlan(request),
    /restore data must be outside/i,
  );
});

test("missing metadata parents compile as explicit rollback-guarded transitions", () => {
  const roots = fixtureRoots("metadata-parents");
  const relativePath = "payload/runtime.js";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const contentHash = sha256("runtime\n");
  const preflight = makePlan(roots, {
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: contentHash,
      size: 8,
    }],
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: false,
      ownership: "unrelated",
      expectedSha256: contentHash,
    }],
    requiredParentDirectories: [{
      path: resolveRelative(roots.destination, "payload"),
      relativePath: "payload",
      harnesses: ["kilo"],
      exists: false,
    }],
    ownedChanges: [{
      id: "runtime-file",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      action: "create",
      sha256: contentHash,
    }],
  });
  const baseRequest = compileRequest(preflight, roots.privateRoot);
  const request: CompileExecutableInstallPlanRequest = {
    ...baseRequest,
    ownership: {
      ...baseRequest.ownership,
      manifestResource: {
        ...baseRequest.ownership.manifestResource,
        requiredParentDirectories: [{
          root: roots.destination,
          relativePath: ".agents/toolkits/kilo-herdr-engineering-workflow",
        }],
      },
    },
  };

  const plan = compileExecutableInstallPlan(request);
  const manifestParent = plan.transitions.find(
    (transition) =>
      transition.kind === "parent-directory" &&
      transition.target.relativePath === ".agents/toolkits/kilo-herdr-engineering-workflow",
  );
  const manifestTransition = plan.transitions.at(-1)!;

  assert.equal(manifestParent?.rollbackGuard.type, "created-empty-directory");
  assert.ok(manifestParent && manifestTransition.dependsOn.includes(manifestParent.id));
});

test("container removal cannot absorb shared content that must be retained", () => {
  const roots = fixtureRoots("shared-container");
  const directoryPath = "payload";
  const filePath = "payload/shared.js";
  const directoryHash = sha256("directory snapshot");
  const fileHash = sha256("shared\n");
  const manifest = createOwnershipManifest({
    manifestId: "shared-container-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    directories: [{
      id: "owned-container",
      harnesses: ["kilo"],
      path: directoryPath,
      emptyAtInstall: false,
      snapshotSha256: directoryHash,
    }],
    files: [{
      id: "shared-child",
      artifactType: "shared-runtime",
      harnesses: ["kilo", "claude"],
      path: filePath,
      sha256: fileHash,
    }],
  });
  const preflight = makePlan(roots, {
    operation: "uninstall",
    destinationPreconditions: [
      {
        path: resolveRelative(roots.destination, directoryPath),
        relativePath: directoryPath,
        exists: true,
        kind: "directory",
        snapshotSha256: directoryHash,
        ownership: "owned-unchanged",
        expectedSha256: directoryHash,
        entries: [],
      },
      filePrecondition(roots.destination, filePath, fileHash, "owned-unchanged"),
    ],
    ownedChanges: [
      removeChange(manifest.directories[0], roots.destination, "directory", directoryHash),
      preserveFile("shared-child", roots.destination, filePath, "shared-runtime", ["kilo", "claude"], fileHash),
    ],
  });

  assert.throws(
    () => compileExecutableInstallPlan(
      compileRequest(preflight, roots.privateRoot, manifest),
    ),
    /overlaps a non-removal transition/i,
  );
});

test("tree removal checks retained baseline ownership omitted from selected changes", () => {
  const roots = fixtureRoots("unselected-tree-child");
  const directoryPath = "payload";
  const childPath = "payload/claude.js";
  const directoryHash = sha256("directory snapshot");
  const childHash = sha256("claude\n");
  const manifest = createOwnershipManifest({
    manifestId: "unselected-tree-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    directories: [{
      id: "kilo-container",
      harnesses: ["kilo"],
      path: directoryPath,
      emptyAtInstall: false,
      snapshotSha256: directoryHash,
    }],
    files: [{
      id: "claude-child",
      artifactType: "shared-runtime",
      harnesses: ["claude"],
      path: childPath,
      sha256: childHash,
    }],
  });
  const preflight = makePlan(roots, {
    operation: "uninstall",
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, directoryPath),
      relativePath: directoryPath,
      exists: true,
      kind: "directory",
      snapshotSha256: directoryHash,
      ownership: "owned-unchanged",
      expectedSha256: directoryHash,
      entries: [],
    }],
    ownedChanges: [
      removeChange(manifest.directories[0], roots.destination, "directory", directoryHash),
    ],
  });

  assert.throws(
    () => compileExecutableInstallPlan(
      compileRequest(preflight, roots.privateRoot, manifest),
    ),
    /retained ownership record.*claude-child/i,
  );
});

test("file removal cannot delete ownership retained for an unselected harness", () => {
  const roots = fixtureRoots("shared-file-removal");
  const relativePath = "payload/shared.js";
  const fileHash = sha256("shared\n");
  const manifest = createOwnershipManifest({
    manifestId: "shared-file-manifest",
    scope: "project",
    harnesses: ["kilo", "claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [{
      id: "shared-file",
      artifactType: "shared-runtime",
      harnesses: ["kilo", "claude"],
      path: relativePath,
      sha256: fileHash,
    }],
  });
  const preflight = makePlan(roots, {
    operation: "uninstall",
    destinationPreconditions: [
      filePrecondition(roots.destination, relativePath, fileHash, "owned-unchanged"),
    ],
    ownedChanges: [
      removeChange(manifest.files[0], roots.destination, "shared-runtime", fileHash),
    ],
  });

  assert.throws(
    () => compileExecutableInstallPlan(
      compileRequest(preflight, roots.privateRoot, manifest),
    ),
    /retained ownership record.*shared-file/i,
  );
});

test("semantic config ownership preserves displacement when another key is already owned", () => {
  const roots = fixtureRoots("config-semantic-ownership");
  const configPath = "config/claude.json";
  const configAbsolutePath = resolveRelative(roots.destination, configPath);
  const ownedValue = { command: "owned" };
  const replacement = { command: "replacement" };
  const manifest = createOwnershipManifest({
    manifestId: "config-semantic-manifest",
    scope: "project",
    harnesses: ["claude"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    configRegistrations: [{
      id: "owned-registration",
      harness: "claude",
      path: configPath,
      key: "mcpServers.owned",
      installedValue: ownedValue,
      installedValueSha256: hashOwnedValue(ownedValue),
    }],
  });
  const preflight = makePlan(roots, {
    operation: "update",
    harnesses: ["claude"],
    destinationPreconditions: [{
      path: configAbsolutePath,
      relativePath: configPath,
      exists: true,
      kind: "file",
      sha256: sha256("config bytes"),
      ownership: "owned-unchanged",
    }],
    ownedChanges: [
      {
        id: "owned-registration",
        artifactType: "config-registration",
        harnesses: ["claude"],
        destinationPath: configAbsolutePath,
        destinationRelativePath: configPath,
        action: "unchanged",
        sha256: hashOwnedValue(ownedValue),
        desiredValue: ownedValue,
        semanticKey: "mcpServers.owned",
        adapterKind: "claude-json",
        ownershipState: "owned-unchanged",
      },
      {
        id: "forced-registration",
        artifactType: "config-registration",
        harnesses: ["claude"],
        destinationPath: configAbsolutePath,
        destinationRelativePath: configPath,
        action: "replace",
        sha256: hashOwnedValue(replacement),
        desiredValue: replacement,
        semanticKey: "mcpServers.user",
        adapterKind: "claude-json",
        ownershipState: "unrelated",
      },
    ],
    rollbackInputs: [{
      type: "config",
      path: configAbsolutePath,
      key: "mcpServers.user",
      existed: true,
      sha256: hashOwnedValue("user-value"),
      value: "user-value",
    }],
  });

  const plan = compileExecutableInstallPlan(
    compileRequest(preflight, roots.privateRoot, manifest),
  );

  assert.equal(plan.projection.manifest?.displacedValues.length, 1);
  assert.equal(
    plan.projection.manifest?.displacedValues[0].restoreDataId,
    "forced-registration-restore",
  );
  assert.equal(
    plan.projection.restoreData?.entries["forced-registration-restore"],
    "user-value",
  );
});

test("runtime validation binds opaque staging, restore references, staging roots, and effects", () => {
  const roots = fixtureRoots("validator-bindings");
  const configPath = "config/claude.json";
  const configAbsolutePath = resolveRelative(roots.destination, configPath);
  const preflight = makePlan(roots, {
    harnesses: ["claude"],
    destinationPreconditions: [{
      path: configAbsolutePath,
      relativePath: configPath,
      exists: true,
      kind: "file",
      sha256: sha256("config bytes"),
      ownership: "unrelated",
    }],
    ownedChanges: [
      configChange(
        "forced-config",
        configAbsolutePath,
        configPath,
        "mcpServers.engineering-workflow",
        { command: "node" },
      ),
    ],
    rollbackInputs: [{
      type: "config",
      path: configAbsolutePath,
      key: "mcpServers.engineering-workflow",
      existed: true,
      sha256: hashOwnedValue("prior"),
      value: "prior",
    }],
  });
  const plan = compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot));

  assertInvalidMutation(plan, (copy) => {
    const opaque = copy.transitions.find(
      (transition: any) => transition.kind === "opaque-registration",
    );
    opaque.stage.changes[0].key = "mcpServers.unrelated";
  }, /does not match its postimage/i);
  assertInvalidMutation(plan, (copy) => {
    const restore = copy.transitions.find(
      (transition: any) => transition.kind === "restore-data",
    );
    copy.projection.restoreData.entries = {};
    restore.stage.value.entries = {};
    restore.desired.sha256 = serializedHash(restore.stage.value);
  }, /requires exact private restore data|missing exact private restore data/i);
  assertInvalidMutation(plan, (copy) => {
    const opaque = copy.transitions.find(
      (transition: any) => transition.kind === "opaque-registration",
    );
    opaque.ownershipEffects[0].recordId = "missing-record";
  }, /missing from projection/i);

  const fixturePlan = makeSingleFileExecutablePlan(roots);
  assertInvalidMutation(fixturePlan, (copy) => {
    const file = copy.transitions.find((transition: any) => transition.kind === "file");
    file.stage.checkoutRoot = path.resolve(roots.root, "other-checkout");
  }, /outside the plan checkout root/i);
  assertInvalidMutation(fixturePlan, (copy) => {
    const file = copy.transitions.find((transition: any) => transition.kind === "file");
    file.ownershipEffects[0].action = "detach";
  }, /ownership effects do not match its postimage/i);
  assertInvalidMutation(fixturePlan, (copy) => {
    const file = copy.transitions.find((transition: any) => transition.kind === "file");
    file.desired = { type: "absent" };
    file.stage = { type: "none" };
    file.mutates = false;
    file.ownershipEffects[0].action = "detach";
  }, /retained ownership record.*runtime-file/i);
  if (process.platform === "win32") {
    assertInvalidMutation(fixturePlan, (copy) => {
      const file = copy.transitions.find((transition: any) => transition.kind === "file");
      file.target.relativePath = "Payload/runtime.js";
      file.desired = { type: "absent" };
      file.stage = { type: "none" };
      file.mutates = false;
      file.ownershipEffects[0].action = "detach";
    }, /retained ownership record.*runtime-file/i);
  }
});

test("runtime validation detects physical target aliases across resource roots", () => {
  const roots = fixtureRoots("target-alias");
  const plan = makeSingleFileExecutablePlan(roots);

  assertInvalidMutation(plan, (copy) => {
    const file = copy.transitions.find((transition: any) => transition.kind === "file");
    const aliasRoot = path.dirname(resolveRelative(file.target.root, file.target.relativePath));
    copy.resourceRoots.push(aliasRoot);
    const duplicate = structuredClone(file);
    duplicate.id = "alias-file";
    duplicate.order = 1;
    duplicate.target = { root: aliasRoot, relativePath: path.basename(file.target.relativePath) };
    duplicate.logicalChangeIds = ["alias-change"];
    duplicate.ownershipEffects = [{
      changeId: "alias-change",
      action: "upsert",
      recordId: file.ownershipEffects[0].recordId,
    }];
    copy.transitions.splice(1, 0, duplicate);
    for (let index = 2; index < copy.transitions.length; index += 1) {
      copy.transitions[index].order = index;
      copy.transitions[index].dependsOn.push("alias-file");
    }
  }, /target collision/i);
});

test("fresh dependency ownership compiles a prepared dependency-tree transition", () => {
  const roots = fixtureRoots("dependency-create");
  const relativePath = "payload/node_modules";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const treeHash = sha256("prepared dependency tree");
  const preflight = makePlan(roots, {
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: false,
      ownership: "unrelated",
    }],
    ownedChanges: [{
      id: "runtime-dependencies",
      artifactType: "dependency",
      harnesses: ["kilo"],
      destinationPath,
      destinationRelativePath: relativePath,
      action: "create",
      sha256: treeHash,
      dependencyInput: {
        packageManager: "npm",
        packageNames: ["@kilocode/plugin", "zod"],
        lockfilePath: "payload/package-lock.json",
      },
    }],
  });

  const plan = compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot));
  const dependency = plan.transitions.find(
    (transition) => transition.kind === "dependency-tree",
  );

  assert.deepEqual(dependency?.baseline, { type: "absent" });
  assert.deepEqual(dependency?.desired, { type: "dependency-tree", sha256: treeHash });
  assert.equal(dependency?.stage.type, "dependency-prepare");
  assert.deepEqual(plan.projection.manifest?.dependencies[0], {
    id: "runtime-dependencies",
    harnesses: ["kilo"],
    path: relativePath,
    packageManager: "npm",
    packageNames: ["@kilocode/plugin", "zod"],
    lockfilePath: "payload/package-lock.json",
    treeSha256: treeHash,
  });
});

function compileRequest(
  preflightPlan: InstallPlan,
  privateRoot: string,
  manifest?: ReturnType<typeof createOwnershipManifest>,
  restoreData?: ReturnType<typeof createRestoreData>,
): CompileExecutableInstallPlanRequest {
  const ownership = metadataInput(preflightPlan, privateRoot, manifest, restoreData);
  return { preflightPlan, ownership, projectedAt: PROJECTED_AT };
}

function metadataInput(
  plan: InstallPlan,
  privateRoot: string,
  manifest?: ReturnType<typeof createOwnershipManifest>,
  restoreData?: ReturnType<typeof createRestoreData>,
): OwnershipCompilationInput {
  return {
    manifest,
    restoreData,
    manifestResource: {
      target: {
        root: plan.destinationRoot,
        relativePath: ".agents/toolkits/kilo-herdr-engineering-workflow/ownership.json",
      },
      baseline: manifest ? { type: "file", sha256: sha256(JSON.stringify(manifest)) } : { type: "absent" },
      requiredParentDirectories: [],
    },
    restoreDataResource: {
      target: { root: privateRoot, relativePath: "restore-data.json" },
      baseline: restoreData ? { type: "file", sha256: sha256(JSON.stringify(restoreData)) } : { type: "absent" },
      requiredParentDirectories: [],
    },
  };
}

function makeSingleFileExecutablePlan(
  roots: ReturnType<typeof fixtureRoots>,
): ExecutableInstallPlan {
  const relativePath = "payload/runtime.js";
  const destinationPath = resolveRelative(roots.destination, relativePath);
  const contentHash = sha256("runtime\n");
  const preflight = makePlan(roots, {
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: contentHash,
      size: 8,
    }],
    destinationPreconditions: [{
      path: destinationPath,
      relativePath,
      exists: false,
      ownership: "unrelated",
      expectedSha256: contentHash,
    }],
    ownedChanges: [{
      id: "runtime-file",
      artifactType: "shared-runtime",
      harnesses: ["kilo"],
      sourcePath: "core/runtime.js",
      destinationPath,
      destinationRelativePath: relativePath,
      action: "create",
      sha256: contentHash,
    }],
  });
  return compileExecutableInstallPlan(compileRequest(preflight, roots.privateRoot));
}

function makePlan(
  roots: ReturnType<typeof fixtureRoots>,
  overrides: Partial<InstallPlan> = {},
): InstallPlan {
  return {
    operation: "install",
    scope: "project",
    harnesses: ["kilo"],
    checkoutRoot: roots.checkout,
    destinationRoot: roots.destination,
    sourceInventory: [],
    destinationPreconditions: [],
    requiredParentDirectories: [],
    ownedChanges: [],
    rollbackInputs: [],
    prerequisites: [],
    warnings: [],
    ...overrides,
  };
}

function fixtureRoots(name: string) {
  const root = path.resolve(tmpdir(), `executable-plan-${name}`);
  return {
    root,
    checkout: path.join(root, "checkout"),
    destination: path.join(root, "destination"),
    privateRoot: path.join(root, "private"),
  };
}

function configChange(
  id: string,
  destinationPath: string,
  destinationRelativePath: string,
  semanticKey: string,
  desiredValue: JsonObject,
): PlannedOwnedChange {
  return {
    id,
    artifactType: "config-registration",
    harnesses: ["claude"],
    destinationPath,
    destinationRelativePath,
    action: "replace",
    sha256: hashOwnedValue(desiredValue),
    desiredValue,
    semanticKey,
    adapterKind: "claude-json",
    ownershipState: "unrelated",
  };
}

type JsonObject = { [key: string]: string | string[] };

function preserveFile(
  id: string,
  destinationRoot: string,
  relativePath: string,
  artifactType: "shared-runtime" | "kilo-adapter",
  harnesses: Array<"kilo" | "claude">,
  hash: string,
): PlannedOwnedChange {
  return {
    id,
    artifactType,
    harnesses,
    destinationPath: resolveRelative(destinationRoot, relativePath),
    destinationRelativePath: relativePath,
    action: "preserve",
    sha256: hash,
  };
}

function removeChange(
  record: { id: string; path: string; harnesses: AgentKind[] },
  destinationRoot: string,
  artifactType: "shared-runtime" | "directory" | "dependency",
  hash: string,
): PlannedOwnedChange {
  return {
    id: record.id,
    artifactType,
    harnesses: record.harnesses,
    destinationPath: resolveRelative(destinationRoot, record.path),
    destinationRelativePath: record.path,
    action: "remove",
    sha256: hash,
  };
}

function filePrecondition(
  destinationRoot: string,
  relativePath: string,
  observedHash: string,
  ownership: "unrelated" | "owned-unchanged" | "owned-modified",
  expectedSha256 = observedHash,
) {
  return {
    path: resolveRelative(destinationRoot, relativePath),
    relativePath,
    exists: true as const,
    kind: "file" as const,
    sha256: observedHash,
    ownership,
    expectedSha256,
    priorContent: "fixture",
  };
}

function resolveRelative(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.split("/"));
}

function assertInvalidMutation(
  plan: ExecutableInstallPlan,
  mutate: (copy: any) => void,
  expected: RegExp,
): void {
  const copy = JSON.parse(JSON.stringify(plan));
  mutate(copy);
  assert.throws(() => validateExecutableInstallPlan(copy), expected);
}

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

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function serializedHash(value: unknown): string {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

async function listTree(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (current: string, relative: string): Promise<void> => {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const childRelative = relative ? `${relative}/${child.name}` : child.name;
      entries.push(`${child.isDirectory() ? "D" : "F"}:${childRelative}`);
      if (child.isDirectory()) await visit(path.join(current, child.name), childRelative);
    }
  };
  await visit(root, "");
  return entries;
}

async function createCheckoutFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "executable-plan-"));
  const checkout = path.join(root, "checkout");
  const destination = path.join(root, "destination");
  const privateRoot = path.join(root, "private");
  for (const directory of [
    "core",
    "mcp",
    "plugin",
    "command",
    "project/kilo/plugin",
    "project/kilo/command",
    "launcher",
    "skills/implement-task",
    "skills/test-verification",
    "skills/code-review",
    "skills/readability-review",
  ]) {
    await mkdir(path.join(checkout, ...directory.split("/")), { recursive: true });
  }
  for (const file of [
    "core/model.ts",
    "mcp/server.ts",
    "mcp/workflow-server.ts",
    "plugin/workflow.ts",
    "plugin/herdr-agent-state.js",
    "command/implement-task.md",
    "project/kilo/plugin/workflow.ts",
    "project/kilo/plugin/herdr-agent-state.js",
    "project/kilo/command/implement-task.md",
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
  await mkdir(privateRoot, { recursive: true });
  assert.equal(await readFile(path.join(checkout, "package.json"), "utf8"), "{}\n");
  return { root, checkout, destination, privateRoot };
}
