import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  PAYLOAD_ARTIFACT_TYPES,
  PAYLOAD_INVENTORY,
  compareDisplacedValue,
  compareOwnership,
  createOwnershipManifest,
  createRestoreData,
  hashOwnedValue,
  inspectLegacyPhase1Manifest,
  parseOwnershipManifest,
  readOwnershipManifest,
  readRestoreData,
  resolveOwnershipPaths,
  serializeOwnershipManifest,
  validateOwnershipManifest,
  writeOwnershipManifest,
  writeRestoreData,
} from "./ownership-manifest.ts";
import type {
  ConfigRegistrationRecord,
  OwnershipManifest,
} from "./ownership-manifest.ts";
import type { JsonValue } from "./model.ts";

test("payload inventory covers every Phase 2 authored artifact boundary", () => {
  assert.deepEqual(Object.keys(PAYLOAD_INVENTORY), [
    "sharedRuntime",
    "mcpEntrypoint",
    "launcher",
    "kiloAdapter",
    "canonicalSkill",
    "reviewerSkills",
  ]);
  assert.equal(
    PAYLOAD_INVENTORY.sharedRuntime.projectMappings[0].destinationPath,
    ".agents/toolkits/kilo-herdr-engineering-workflow/core",
  );
  assert.ok(
    PAYLOAD_INVENTORY.sharedRuntime.projectMappings.some(
      (mapping) =>
        mapping.sourcePath === "skills" &&
        mapping.destinationPath === ".agents/toolkits/kilo-herdr-engineering-workflow/skills",
    ),
  );
  assert.equal(PAYLOAD_INVENTORY.mcpEntrypoint.projectMappings[0].sourcePath, "mcp/server.ts");
  assert.ok(
    PAYLOAD_INVENTORY.mcpEntrypoint.projectMappings.some(
      (mapping) => mapping.sourcePath === "mcp/workflow-server.ts",
    ),
  );
  assert.ok(
    PAYLOAD_INVENTORY.kiloAdapter.userMappings.some(
      (mapping) => mapping.sourcePath === "plugin/workflow.ts",
    ),
  );
  assert.ok(
    PAYLOAD_INVENTORY.kiloAdapter.userMappings.some(
      (mapping) => mapping.sourcePath === "plugin/herdr-agent-state.js",
    ),
  );
  assert.equal(PAYLOAD_INVENTORY.canonicalSkill.projectMappings.length, 2);
  assert.equal(PAYLOAD_INVENTORY.reviewerSkills.projectMappings.length, 6);
});

test("versioned manifest represents files, directories, dependencies, registrations, blocks, displaced values, and residual ownership", () => {
  const manifest = createFixtureManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.scope, "project");
  assert.deepEqual(manifest.harnesses, ["kilo", "claude", "codex"]);
  assert.equal(manifest.files[0].sha256.length, 64);
  assert.equal(manifest.configRegistrations[0].installedValue.command, "node");
  assert.equal(manifest.insertedBlocks[0].block, "# owned block\n");
  assert.equal(manifest.displacedValues[0].secret, true);
  assert.equal(manifest.residualOwnership[0].reason, "modified");
  assert.doesNotThrow(() => validateOwnershipManifest(manifest));
});

test("schema accepts each supported scope, harness, and payload artifact type", () => {
  for (const scope of ["user", "project"] as const) {
    for (const harness of ["kilo", "claude", "codex"] as const) {
      assert.doesNotThrow(() =>
        createOwnershipManifest({ scope, harnesses: [harness] }),
      );
    }
  }

  const manifest = createFixtureManifest();
  assert.doesNotThrow(() =>
    validateOwnershipManifest({
      ...manifest,
      files: PAYLOAD_ARTIFACT_TYPES.map((artifactType, index) => ({
        ...manifest.files[0],
        id: `artifact-${index}`,
        artifactType,
        path: `payload/artifact-${index}.js`,
      })),
    }),
  );
});

test("malformed, duplicate, unsupported, absolute, traversal, and workflow paths are rejected", () => {
  const manifest = createFixtureManifest();
  const invalidManifests: unknown[] = [
    { ...manifest, schemaVersion: 2 },
    { ...manifest, files: [{ ...manifest.files[0], path: "/etc/passwd" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: "../outside" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: "C:/outside" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: "C:outside" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: ".workflow/runs.json" }] },
    { ...manifest, files: [{ ...manifest.files[0], path: ".WORKFLOW/runs.json" }] },
    { ...manifest, files: [manifest.files[0], { ...manifest.files[0], id: "other" }] },
    { ...manifest, configRegistrations: [{ ...manifest.configRegistrations[0], installedValueSha256: "0".repeat(64) }] },
  ];

  for (const invalid of invalidManifests) {
    assert.throws(() => validateOwnershipManifest(invalid), /Ownership|path|hash|unsupported/i);
  }
  assert.throws(() => parseOwnershipManifest("not-json"), /valid JSON/);
});

test("real-path validation rejects a symlink that escapes the ownership root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ownership-outside-"));
  try {
    await symlink(outside, path.join(root, "escape"), "junction");
    assert.throws(
      () => validateOwnershipManifest(createFixtureManifest({ path: "escape/file.txt" }), { root }),
      /symlink|escapes/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("real-path validation rejects dangling symlinks and project-local restore roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-dangling-"));
  const outside = await mkdtemp(path.join(tmpdir(), "ownership-dangling-target-"));
  try {
    await symlink(outside, path.join(root, "dangling"), "junction");
    await rm(outside, { recursive: true, force: true });
    assert.throws(
      () => validateOwnershipManifest(createFixtureManifest({ path: "dangling/file.txt" }), { root }),
      /resolve|symlink|safely/i,
    );
    assert.throws(
      () => resolveOwnershipPaths("project", root, root),
      /outside the project root/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ownership comparison distinguishes unrelated, unchanged, modified, and missing content", () => {
  const manifest = createFixtureManifest();
  const owned = manifest.files[0];
  assert.deepEqual(
    compareOwnership(manifest, { type: "file", path: "payload/runtime.js", exists: true, sha256: owned.sha256 }),
    { state: "owned-unchanged", recordId: owned.id },
  );
  assert.deepEqual(
    compareOwnership(manifest, { type: "file", path: "payload/runtime.js", exists: true, sha256: "f".repeat(64) }),
    { state: "owned-modified", recordId: owned.id },
  );
  assert.deepEqual(
    compareOwnership(manifest, { type: "file", path: "payload/runtime.js", exists: false }),
    { state: "owned-missing", recordId: owned.id },
  );
  assert.deepEqual(
    compareOwnership(manifest, { type: "file", path: "user/file.txt", exists: false }),
    { state: "unrelated" },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "config-registration",
      path: "config.json",
      key: "mcpServers.engineering-workflow",
      exists: true,
      value: manifest.configRegistrations[0].installedValue,
    }),
    { state: "owned-unchanged", recordId: manifest.configRegistrations[0].id },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "directory",
      path: "payload",
      exists: true,
      snapshotSha256: "c".repeat(64),
    }),
    { state: "owned-unchanged", recordId: "runtime-directory" },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "dependency",
      path: "payload/node_modules",
      exists: true,
      treeSha256: "d".repeat(64),
    }),
    { state: "owned-unchanged", recordId: "runtime-dependencies" },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "directory",
      path: "payload",
      exists: true,
      snapshotSha256: "f".repeat(64),
    }),
    { state: "owned-modified", recordId: "runtime-directory" },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "dependency",
      path: "payload/node_modules",
      exists: true,
      treeSha256: "f".repeat(64),
    }),
    { state: "owned-modified", recordId: "runtime-dependencies" },
  );
  assert.deepEqual(
    compareOwnership(manifest, {
      type: "inserted-block",
      path: "profile.sh",
      marker: "kilo-herdr-engineering-workflow",
      exists: true,
      block: "# owned block\n",
    }),
    { state: "owned-unchanged", recordId: "profile-block" },
  );
});

test("force replacement is restorable only with exact private displaced data and unchanged installed content", () => {
  const original = "secret-value";
  const installed = { command: "node", args: ["server.ts"] };
  const record = createFixtureManifest({ original, installed }).displacedValues[0];
  const restoreData = createRestoreData({ [record.restoreDataId]: original });

  assert.deepEqual(
    compareDisplacedValue(record, installed, restoreData),
    { state: "restorable-displaced", value: original },
  );
  assert.deepEqual(
    compareDisplacedValue(record, { command: "changed" }, restoreData),
    { state: "modified-installed-value" },
  );
  assert.deepEqual(
    compareDisplacedValue(record, installed, createRestoreData({})),
    { state: "missing-restore-data" },
  );
  assert.deepEqual(
    compareDisplacedValue(record, installed, createRestoreData({ [record.restoreDataId]: "tampered" })),
    { state: "invalid-restore-data" },
  );
});

test("legacy Phase 1 TSV is explicitly refused and never silently discarded", () => {
  const hash = "a".repeat(64);
  const inspection = inspectLegacyPhase1Manifest(`${hash}\tplugin/workflow.ts\n`);
  assert.equal(inspection.action, "refuse");
  assert.equal(inspection.entries.length, 1);
  assert.match(inspection.reason, /scope, harness/);

  const malformed = inspectLegacyPhase1Manifest(`${hash}\t../outside\n`);
  assert.equal(malformed.action, "refuse");
  assert.match(malformed.reason, /malformed/);
});

test("manifest and private restore data round-trip in temporary roots", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ownership-io-"));
  const privateRoot = await mkdtemp(path.join(tmpdir(), "ownership-private-"));
  try {
    const locations = resolveOwnershipPaths("project", root, privateRoot);
    const manifest = createFixtureManifest();
    await mkdir(path.dirname(locations.manifestPath), { recursive: true });
    writeOwnershipManifest(locations.manifestPath, manifest);
    writeRestoreData(
      locations.restoreDataPath,
      createRestoreData({ "displaced-secret": "do-not-commit" }),
    );

    assert.deepEqual(readOwnershipManifest(locations.manifestPath, { root }), manifest);
    assert.equal(readRestoreData(locations.restoreDataPath).entries["displaced-secret"], "do-not-commit");
    assert.match(await readFile(locations.manifestPath, "utf8"), /schemaVersion/);
    assert.equal(path.relative(root, locations.restoreDataPath).startsWith(".."), true);

    const userLocations = resolveOwnershipPaths("user", root);
    writeOwnershipManifest(userLocations.manifestPath, manifest);
    writeRestoreData(
      userLocations.restoreDataPath,
      createRestoreData({ "user-displaced-secret": "do-not-commit" }),
    );
    assert.deepEqual(readOwnershipManifest(userLocations.manifestPath, { root }), manifest);
    assert.equal(
      readRestoreData(userLocations.restoreDataPath).entries["user-displaced-secret"],
      "do-not-commit",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(privateRoot, { recursive: true, force: true });
  }
});

test("restore data with broad permissions is rejected where permission bits are available", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(tmpdir(), "ownership-permissions-"));
  try {
    const filePath = path.join(root, "restore-data.json");
    writeRestoreData(filePath, createRestoreData({ secret: "value" }));
    await chmod(filePath, 0o644);
    assert.throws(() => readRestoreData(filePath), /private|readable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function createFixtureManifest(options: {
  path?: string;
  original?: string;
  installed?: JsonValue;
} = {}): OwnershipManifest {
  const original = options.original ?? "old-value";
  const installed = options.installed ?? { command: "node", args: ["server.ts"] };
  const registration: ConfigRegistrationRecord = {
    id: "claude-registration",
    harness: "claude",
    path: "config.json",
    key: "mcpServers.engineering-workflow",
    installedValue: installed,
    installedValueSha256: hashOwnedValue(installed),
  };

  return createOwnershipManifest({
    manifestId: "manifest-fixture",
    scope: "project",
    harnesses: ["kilo", "claude", "codex"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [
      {
        id: "runtime-file",
        artifactType: "shared-runtime",
        harnesses: ["kilo", "claude", "codex"],
        path: options.path ?? "payload/runtime.js",
        sha256: "a".repeat(64),
      },
    ],
    directories: [
      {
        id: "runtime-directory",
        harnesses: ["kilo", "claude", "codex"],
        path: "payload",
        emptyAtInstall: false,
        snapshotSha256: "c".repeat(64),
      },
    ],
    dependencies: [
      {
        id: "runtime-dependencies",
        harnesses: ["kilo", "claude", "codex"],
        path: "payload/node_modules",
        packageManager: "npm",
        packageNames: ["@kilocode/plugin"],
        lockfilePath: "payload/package-lock.json",
        treeSha256: "d".repeat(64),
      },
    ],
    configRegistrations: [registration],
    insertedBlocks: [
      {
        id: "profile-block",
        harness: "kilo",
        path: "profile.sh",
        marker: "kilo-herdr-engineering-workflow",
        block: "# owned block\n",
        blockSha256: hashOwnedValue("# owned block\n"),
      },
    ],
    displacedValues: [
      {
        id: "displaced-secret",
        harness: "claude",
        path: "config.json",
        key: "mcpServers.engineering-workflow",
        restoreDataId: "displaced-secret",
        originalValueSha256: hashOwnedValue(original),
        installedValueSha256: hashOwnedValue(installed),
        valueKind: "text",
        secret: true,
      },
    ],
    residualOwnership: [
      {
        id: "residual-runtime-file",
        sourceId: "runtime-file",
        artifactType: "file",
        path: options.path ?? "payload/runtime.js",
        reason: "modified",
        expectedSha256: "a".repeat(64),
        observedSha256: "b".repeat(64),
        retainedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
}
