import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import {
  isAgentKind,
  isJsonValue,
} from "./model.ts";
import type { AgentKind, JsonValue } from "./model.ts";

export const OWNERSHIP_MANIFEST_FORMAT =
  "kilo-herdr-engineering-workflow.ownership" as const;
export const OWNERSHIP_SCHEMA_VERSION = 1 as const;
export const OWNERSHIP_MANIFEST_FILENAME = "ownership.json" as const;
export const OWNERSHIP_RESTORE_DATA_FILENAME = "restore-data.json" as const;
export const PROJECT_TOOLKIT_ROOT =
  ".agents/toolkits/kilo-herdr-engineering-workflow" as const;
export const PROJECT_OWNERSHIP_MANIFEST_PATH =
  `${PROJECT_TOOLKIT_ROOT}/${OWNERSHIP_MANIFEST_FILENAME}` as const;

export const PAYLOAD_ARTIFACT_TYPES = [
  "shared-runtime",
  "mcp-entrypoint",
  "launcher",
  "kilo-adapter",
  "canonical-skill",
  "reviewer-skill",
] as const;

export type PayloadArtifactType = (typeof PAYLOAD_ARTIFACT_TYPES)[number];
export type OwnershipScope = "user" | "project";

export interface PayloadMapping {
  sourcePath: string;
  destinationPath: string | null;
}

export interface PayloadInventoryEntry {
  artifactType: PayloadArtifactType;
  userMappings: readonly PayloadMapping[];
  projectMappings: readonly PayloadMapping[];
}

/**
 * The inventory describes authored payload boundaries, not every source file.
 * Installers expand each source directory into file records before mutation.
 */
export const PAYLOAD_INVENTORY = {
  sharedRuntime: {
    artifactType: "shared-runtime",
    userMappings: [
      { sourcePath: "core", destinationPath: null },
      { sourcePath: "package.json", destinationPath: null },
      { sourcePath: "package-lock.json", destinationPath: null },
      { sourcePath: "skills", destinationPath: null },
    ],
    projectMappings: [
      { sourcePath: "core", destinationPath: `${PROJECT_TOOLKIT_ROOT}/core` },
      { sourcePath: "package.json", destinationPath: `${PROJECT_TOOLKIT_ROOT}/package.json` },
      { sourcePath: "package-lock.json", destinationPath: `${PROJECT_TOOLKIT_ROOT}/package-lock.json` },
      { sourcePath: "skills", destinationPath: `${PROJECT_TOOLKIT_ROOT}/skills` },
    ],
  },
  mcpEntrypoint: {
    artifactType: "mcp-entrypoint",
    userMappings: [
      { sourcePath: "mcp/server.ts", destinationPath: null },
      { sourcePath: "mcp/workflow-server.ts", destinationPath: null },
    ],
    projectMappings: [
      { sourcePath: "mcp/server.ts", destinationPath: `${PROJECT_TOOLKIT_ROOT}/mcp/server.ts` },
      { sourcePath: "mcp/workflow-server.ts", destinationPath: `${PROJECT_TOOLKIT_ROOT}/mcp/workflow-server.ts` },
    ],
  },
  launcher: {
    artifactType: "launcher",
    userMappings: [{ sourcePath: "launcher", destinationPath: null }],
    projectMappings: [{ sourcePath: "launcher", destinationPath: `${PROJECT_TOOLKIT_ROOT}/launcher` }],
  },
  kiloAdapter: {
    artifactType: "kilo-adapter",
    userMappings: [
      { sourcePath: "plugin/workflow.ts", destinationPath: null },
      { sourcePath: "plugin/herdr-agent-state.js", destinationPath: null },
      { sourcePath: "command/implement-task.md", destinationPath: null },
    ],
    projectMappings: [
      { sourcePath: "plugin/workflow.ts", destinationPath: ".kilo/plugin/workflow.ts" },
      { sourcePath: "plugin/herdr-agent-state.js", destinationPath: ".kilo/plugin/herdr-agent-state.js" },
      { sourcePath: "command/implement-task.md", destinationPath: ".kilo/command/implement-task.md" },
    ],
  },
  canonicalSkill: {
    artifactType: "canonical-skill",
    userMappings: [
      { sourcePath: "skills/implement-task/SKILL.md", destinationPath: ".claude/skills/implement-task/SKILL.md" },
      { sourcePath: "skills/implement-task/SKILL.md", destinationPath: ".agents/skills/implement-task/SKILL.md" },
    ],
    projectMappings: [
      { sourcePath: "skills/implement-task/SKILL.md", destinationPath: ".claude/skills/implement-task/SKILL.md" },
      { sourcePath: "skills/implement-task/SKILL.md", destinationPath: ".agents/skills/implement-task/SKILL.md" },
    ],
  },
  reviewerSkills: {
    artifactType: "reviewer-skill",
    userMappings: [
      { sourcePath: "skills/test-verification/SKILL.md", destinationPath: ".claude/skills/test-verification/SKILL.md" },
      { sourcePath: "skills/test-verification/SKILL.md", destinationPath: ".agents/skills/test-verification/SKILL.md" },
      { sourcePath: "skills/code-review/SKILL.md", destinationPath: ".claude/skills/code-review/SKILL.md" },
      { sourcePath: "skills/code-review/SKILL.md", destinationPath: ".agents/skills/code-review/SKILL.md" },
      { sourcePath: "skills/readability-review/SKILL.md", destinationPath: ".claude/skills/readability-review/SKILL.md" },
      { sourcePath: "skills/readability-review/SKILL.md", destinationPath: ".agents/skills/readability-review/SKILL.md" },
    ],
    projectMappings: [
      { sourcePath: "skills/test-verification/SKILL.md", destinationPath: ".claude/skills/test-verification/SKILL.md" },
      { sourcePath: "skills/test-verification/SKILL.md", destinationPath: ".agents/skills/test-verification/SKILL.md" },
      { sourcePath: "skills/code-review/SKILL.md", destinationPath: ".claude/skills/code-review/SKILL.md" },
      { sourcePath: "skills/code-review/SKILL.md", destinationPath: ".agents/skills/code-review/SKILL.md" },
      { sourcePath: "skills/readability-review/SKILL.md", destinationPath: ".claude/skills/readability-review/SKILL.md" },
      { sourcePath: "skills/readability-review/SKILL.md", destinationPath: ".agents/skills/readability-review/SKILL.md" },
    ],
  },
} as const;

export interface OwnedFileRecord {
  id: string;
  artifactType: PayloadArtifactType;
  harnesses: AgentKind[];
  path: string;
  sha256: string;
}

export interface OwnedDirectoryRecord {
  id: string;
  harnesses: AgentKind[];
  path: string;
  emptyAtInstall: boolean;
  snapshotSha256: string;
}

export interface OwnedDependencyRecord {
  id: string;
  harnesses: AgentKind[];
  path: string;
  packageManager: "npm";
  packageNames: string[];
  lockfilePath?: string;
  treeSha256: string;
}

export interface ConfigRegistrationRecord {
  id: string;
  harness: AgentKind;
  path: string;
  key: string;
  installedValue: JsonValue;
  installedValueSha256: string;
}

export interface InsertedBlockRecord {
  id: string;
  harness: AgentKind;
  path: string;
  marker: string;
  block: string;
  blockSha256: string;
}

export interface DisplacedValueRecord {
  id: string;
  harness: AgentKind;
  path: string;
  key: string;
  restoreDataId: string;
  originalValueSha256: string;
  installedValueSha256: string;
  valueKind: "json" | "text";
  secret: boolean;
}

export interface ResidualOwnershipRecord {
  id: string;
  sourceId: string;
  artifactType:
    | "file"
    | "directory"
    | "dependency"
    | "config-registration"
    | "inserted-block";
  path: string;
  reason: "modified" | "concurrent-change" | "missing-restore-data";
  expectedSha256?: string;
  observedSha256?: string;
  retainedAt: string;
}

export interface OwnershipManifest {
  format: typeof OWNERSHIP_MANIFEST_FORMAT;
  schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION;
  manifestId: string;
  scope: OwnershipScope;
  harnesses: AgentKind[];
  createdAt: string;
  updatedAt: string;
  files: OwnedFileRecord[];
  directories: OwnedDirectoryRecord[];
  dependencies: OwnedDependencyRecord[];
  configRegistrations: ConfigRegistrationRecord[];
  insertedBlocks: InsertedBlockRecord[];
  displacedValues: DisplacedValueRecord[];
  residualOwnership: ResidualOwnershipRecord[];
}

export interface RestoreData {
  format: "kilo-herdr-engineering-workflow.restore-data";
  schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION;
  entries: Record<string, JsonValue>;
}

export interface OwnershipManifestInput
  extends Partial<
    Pick<
      OwnershipManifest,
      | "manifestId"
      | "createdAt"
      | "updatedAt"
      | "files"
      | "directories"
      | "dependencies"
      | "configRegistrations"
      | "insertedBlocks"
      | "displacedValues"
      | "residualOwnership"
    >
  > {
  scope: OwnershipScope;
  harnesses: AgentKind[];
}

export interface ManifestValidationOptions {
  root?: string;
}

export function createOwnershipManifest(
  input: OwnershipManifestInput,
  now = new Date().toISOString(),
): OwnershipManifest {
  const manifest: OwnershipManifest = {
    format: OWNERSHIP_MANIFEST_FORMAT,
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    manifestId: input.manifestId ?? randomUUID(),
    scope: input.scope,
    harnesses: input.harnesses,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
    files: input.files ?? [],
    directories: input.directories ?? [],
    dependencies: input.dependencies ?? [],
    configRegistrations: input.configRegistrations ?? [],
    insertedBlocks: input.insertedBlocks ?? [],
    displacedValues: input.displacedValues ?? [],
    residualOwnership: input.residualOwnership ?? [],
  };

  return validateOwnershipManifest(manifest);
}

export function validateOwnershipManifest(
  value: unknown,
  options: ManifestValidationOptions = {},
): OwnershipManifest {
  if (!isRecord(value)) {
    throw new Error("Ownership manifest must be a JSON object.");
  }
  if (value.format !== OWNERSHIP_MANIFEST_FORMAT) {
    throw new Error("Ownership manifest has an unsupported format.");
  }
  if (value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) {
    throw new Error(
      `Ownership manifest schema version ${String(value.schemaVersion)} is unsupported.`,
    );
  }
  if (!isManifestIdentifier(value.manifestId)) {
    throw new Error("Ownership manifest has an invalid manifest ID.");
  }
  if (value.scope !== "user" && value.scope !== "project") {
    throw new Error("Ownership manifest has an invalid scope.");
  }
  if (!isAgentList(value.harnesses) || value.harnesses.length === 0) {
    throw new Error("Ownership manifest must name at least one harness.");
  }
  if (!isIsoDate(value.createdAt) || !isIsoDate(value.updatedAt)) {
    throw new Error("Ownership manifest has invalid timestamps.");
  }

  const manifest = value as unknown as OwnershipManifest;
  validateFiles(manifest, options);
  validateDirectories(manifest, options);
  validateDependencies(manifest, options);
  validateConfigRegistrations(manifest, options);
  validateInsertedBlocks(manifest, options);
  validateDisplacedValues(manifest, options);
  validateResidualOwnership(manifest, options);
  assertUnique(
    [
      ...manifest.files,
      ...manifest.directories,
      ...manifest.dependencies,
      ...manifest.configRegistrations,
      ...manifest.insertedBlocks,
      ...manifest.displacedValues,
      ...manifest.residualOwnership,
    ].map((record) => record.id),
    "record IDs",
  );

  const knownHarnesses = new Set(manifest.harnesses);
  for (const record of allRecords(manifest)) {
    if (!record.harnesses.every((harness) => knownHarnesses.has(harness))) {
      throw new Error(`Ownership record "${record.id}" names an unowned harness.`);
    }
  }

  return manifest;
}

export function parseOwnershipManifest(
  source: string,
  options: ManifestValidationOptions = {},
): OwnershipManifest {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`Ownership manifest is not valid JSON: ${errorMessage(error)}`);
  }

  return validateOwnershipManifest(value, options);
}

export function serializeOwnershipManifest(
  manifest: OwnershipManifest,
): string {
  return `${JSON.stringify(validateOwnershipManifest(manifest), null, 2)}\n`;
}

export function readOwnershipManifest(
  filePath: string,
  options: ManifestValidationOptions = {},
): OwnershipManifest {
  let source: string;
  try {
    source = readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read ownership manifest ${filePath}: ${errorMessage(error)}`,
    );
  }

  return parseOwnershipManifest(source, options);
}

export function writeOwnershipManifest(
  filePath: string,
  manifest: OwnershipManifest,
): void {
  const serialized = serializeOwnershipManifest(manifest);
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup must not hide the original write error.
      }
    }
  }
}

export function createRestoreData(
  entries: Record<string, JsonValue>,
): RestoreData {
  const restoreData: RestoreData = {
    format: "kilo-herdr-engineering-workflow.restore-data",
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    entries,
  };
  return validateRestoreData(restoreData);
}

export function validateRestoreData(value: unknown): RestoreData {
  if (!isRecord(value)) {
    throw new Error("Restore data must be a JSON object.");
  }
  if (value.format !== "kilo-herdr-engineering-workflow.restore-data") {
    throw new Error("Restore data has an unsupported format.");
  }
  if (value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION) {
    throw new Error("Restore data has an unsupported schema version.");
  }
  if (!isRecord(value.entries)) {
    throw new Error("Restore data entries must be an object.");
  }
  for (const [id, entry] of Object.entries(value.entries)) {
    if (!isSafeIdentifier(id) || !isJsonValue(entry)) {
      throw new Error(`Restore data entry "${id}" is invalid.`);
    }
  }
  return value as unknown as RestoreData;
}

export function readRestoreData(filePath: string): RestoreData {
  if (process.platform !== "win32") {
    const mode = statSync(filePath).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error("Restore data must not be readable by group or other users.");
    }
  }

  try {
    return validateRestoreData(JSON.parse(readFileSync(filePath, "utf8")));
  } catch (error) {
    if (error instanceof Error && /Restore data/.test(error.message)) {
      throw error;
    }
    throw new Error(`Could not read restore data: ${errorMessage(error)}`);
  }
}

export function writeRestoreData(
  filePath: string,
  restoreData: RestoreData,
): void {
  const serialized = `${JSON.stringify(validateRestoreData(restoreData), null, 2)}\n`;
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Best-effort cleanup must not hide the original write error.
      }
    }
  }
}

export function hashOwnedValue(value: JsonValue | string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Owned values must be JSON data or text.");
  }
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export type OwnershipComparison =
  | { state: "unrelated" }
  | { state: "owned-missing"; recordId: string }
  | { state: "owned-unchanged"; recordId: string }
  | { state: "owned-modified"; recordId: string };

export type OwnershipCandidate =
  | { type: "file"; path: string; exists: boolean; sha256?: string }
  | {
      type: "directory";
      path: string;
      exists: boolean;
      snapshotSha256?: string;
    }
  | { type: "dependency"; path: string; exists: boolean; treeSha256?: string }
  | {
      type: "config-registration";
      path: string;
      key: string;
      exists: boolean;
      value?: JsonValue;
    }
  | {
      type: "inserted-block";
      path: string;
      marker: string;
      exists: boolean;
      block?: string;
    };

export function compareOwnership(
  manifest: OwnershipManifest,
  candidate: OwnershipCandidate,
): OwnershipComparison {
  validateOwnershipManifest(manifest);
  validateSafeRelativePath(candidate.path);

  if (candidate.type === "file") {
    const record = manifest.files.find((entry) => entry.path === candidate.path);
    if (!record) return { state: "unrelated" };
    if (!candidate.exists) return { state: "owned-missing", recordId: record.id };
    return candidate.sha256 === record.sha256
      ? { state: "owned-unchanged", recordId: record.id }
      : { state: "owned-modified", recordId: record.id };
  }

  if (candidate.type === "directory") {
    const record = manifest.directories.find((entry) => entry.path === candidate.path);
    if (!record) return { state: "unrelated" };
    if (!candidate.exists) return { state: "owned-missing", recordId: record.id };
    return candidate.snapshotSha256 === record.snapshotSha256
      ? { state: "owned-unchanged", recordId: record.id }
      : { state: "owned-modified", recordId: record.id };
  }

  if (candidate.type === "dependency") {
    const record = manifest.dependencies.find((entry) => entry.path === candidate.path);
    if (!record) return { state: "unrelated" };
    if (!candidate.exists) return { state: "owned-missing", recordId: record.id };
    return candidate.treeSha256 === record.treeSha256
      ? { state: "owned-unchanged", recordId: record.id }
      : { state: "owned-modified", recordId: record.id };
  }

  if (candidate.type === "config-registration") {
    const record = manifest.configRegistrations.find(
      (entry) => entry.path === candidate.path && entry.key === candidate.key,
    );
    if (!record) return { state: "unrelated" };
    if (!candidate.exists) return { state: "owned-missing", recordId: record.id };
    return candidate.value !== undefined &&
      hashOwnedValue(candidate.value) === record.installedValueSha256
      ? { state: "owned-unchanged", recordId: record.id }
      : { state: "owned-modified", recordId: record.id };
  }

  const record = manifest.insertedBlocks.find(
    (entry) => entry.path === candidate.path && entry.marker === candidate.marker,
  );
  if (!record) return { state: "unrelated" };
  if (!candidate.exists) return { state: "owned-missing", recordId: record.id };
  return hashOwnedValue(candidate.block ?? "") === record.blockSha256
    ? { state: "owned-unchanged", recordId: record.id }
    : { state: "owned-modified", recordId: record.id };
}

export type DisplacedValueComparison =
  | { state: "restorable-displaced"; value: JsonValue }
  | { state: "modified-installed-value" }
  | { state: "missing-restore-data" }
  | { state: "invalid-restore-data" };

export function compareDisplacedValue(
  record: DisplacedValueRecord,
  currentValue: JsonValue | string,
  restoreData: RestoreData,
): DisplacedValueComparison {
  if (hashOwnedValue(currentValue) !== record.installedValueSha256) {
    return { state: "modified-installed-value" };
  }

  const originalValue = restoreData.entries[record.restoreDataId];
  if (originalValue === undefined) {
    return { state: "missing-restore-data" };
  }
  if (
    (record.valueKind === "text" && typeof originalValue !== "string") ||
    hashOwnedValue(originalValue) !== record.originalValueSha256
  ) {
    return { state: "invalid-restore-data" };
  }

  return { state: "restorable-displaced", value: originalValue };
}

export interface LegacyPhase1ManifestInspection {
  format: "phase-1-tsv";
  action: "refuse";
  entries: Array<{ sha256: string; path: string }>;
  reason: string;
}

/**
 * Phase 1 cannot be safely inferred into a multi-harness manifest: it has no
 * scope, harness, config, dependency, or displaced-value ownership. Refusal
 * is therefore explicit and preserves the old file for a later migration.
 */
export function inspectLegacyPhase1Manifest(
  source: string,
): LegacyPhase1ManifestInspection {
  const entries: Array<{ sha256: string; path: string }> = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (
      parts.length !== 2 ||
      !isSha256(parts[0]) ||
      !isSafeRelativePath(parts[1])
    ) {
      return {
        format: "phase-1-tsv",
        action: "refuse",
        entries,
        reason: `Phase 1 TSV entry on line ${index + 1} is malformed; no ownership was changed.`,
      };
    }
    entries.push({ sha256: parts[0], path: parts[1] });
  }

  return {
    format: "phase-1-tsv",
    action: "refuse",
    entries,
    reason:
      "Phase 1 TSV ownership is refused until an explicit migration supplies scope, harness, and non-file ownership.",
  };
}

export function validateSafeRelativePath(
  value: unknown,
  root?: string,
): asserts value is string {
  if (!isSafeRelativePath(value)) {
    throw new Error(`Owned path is not a normalized relative path: ${String(value)}.`);
  }

  if (root !== undefined) {
    assertPathContainedByRoot(value, root);
  }
}

export function resolveOwnershipPaths(
  scope: OwnershipScope,
  root: string,
  privateRestoreRoot?: string,
): { manifestPath: string; restoreDataPath: string } {
  assertCanonicalRoot(root);
  if (scope === "user") {
    const metadataRoot = path.join(root, ".config", "kilo-herdr-engineering-workflow");
    const manifestPath = path.join(metadataRoot, OWNERSHIP_MANIFEST_FILENAME);
    const restoreDataPath = path.join(metadataRoot, OWNERSHIP_RESTORE_DATA_FILENAME);
    assertPathContainedByRoot(path.relative(root, manifestPath), root);
    assertPathContainedByRoot(path.relative(root, restoreDataPath), root);
    return {
      manifestPath,
      restoreDataPath,
    };
  }

  if (!privateRestoreRoot) {
    throw new Error(
      "Project ownership requires a private restore-data root outside the project.",
    );
  }
  assertCanonicalRoot(privateRestoreRoot);
  assertPrivateRestoreRoot(root, privateRestoreRoot);
  assertPathContainedByRoot(PROJECT_OWNERSHIP_MANIFEST_PATH, root);
  assertPathContainedByRoot(OWNERSHIP_RESTORE_DATA_FILENAME, privateRestoreRoot);
  return {
    manifestPath: path.join(root, ...PROJECT_OWNERSHIP_MANIFEST_PATH.split("/")),
    restoreDataPath: path.join(privateRestoreRoot, OWNERSHIP_RESTORE_DATA_FILENAME),
  };
}

function validateFiles(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.files, "files");
  assertUnique(manifest.files.map((record) => record.id), "file IDs");
  assertUnique(manifest.files.map((record) => record.path), "file paths");
  for (const record of manifest.files) {
    assertRecordBase(record, "file");
    if (!PAYLOAD_ARTIFACT_TYPES.includes(record.artifactType)) {
      throw new Error(`File "${record.id}" has an unsupported artifact type.`);
    }
    assertPath(record.path, options.root);
    assertSha256(record.sha256, `file "${record.id}" hash`);
  }
}

function validateDirectories(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.directories, "directories");
  assertUnique(manifest.directories.map((record) => record.id), "directory IDs");
  assertUnique(manifest.directories.map((record) => record.path), "directory paths");
  for (const record of manifest.directories) {
    assertRecordBase(record, "directory");
    assertPath(record.path, options.root);
    if (typeof record.emptyAtInstall !== "boolean") {
      throw new Error(`Directory "${record.id}" has an invalid empty-state flag.`);
    }
    assertSha256(record.snapshotSha256, `directory "${record.id}" snapshot`);
  }
}

function validateDependencies(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.dependencies, "dependencies");
  assertUnique(manifest.dependencies.map((record) => record.id), "dependency IDs");
  assertUnique(manifest.dependencies.map((record) => record.path), "dependency paths");
  for (const record of manifest.dependencies) {
    assertRecordBase(record, "dependency");
    assertPath(record.path, options.root);
    if (record.packageManager !== "npm") {
      throw new Error(`Dependency "${record.id}" has an unsupported package manager.`);
    }
    if (
      !Array.isArray(record.packageNames) ||
      record.packageNames.length === 0 ||
      !record.packageNames.every(isPackageName)
    ) {
      throw new Error(`Dependency "${record.id}" has invalid package names.`);
    }
    if (record.lockfilePath !== undefined) {
      assertPath(record.lockfilePath, options.root);
    }
    assertSha256(record.treeSha256, `dependency "${record.id}" tree`);
  }
}

function validateConfigRegistrations(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.configRegistrations, "config registrations");
  assertUnique(manifest.configRegistrations.map((record) => record.id), "config IDs");
  assertUnique(
    manifest.configRegistrations.map((record) => `${record.path}\u0000${record.key}`),
    "config registration targets",
  );
  for (const record of manifest.configRegistrations) {
    assertSingleHarnessRecord(record, "config registration");
    assertPath(record.path, options.root);
    assertKey(record.key, "config registration key");
    assertJsonValue(record.installedValue, `config registration "${record.id}" value`);
    assertSha256(record.installedValueSha256, `config registration "${record.id}" hash`);
    if (hashOwnedValue(record.installedValue) !== record.installedValueSha256) {
      throw new Error(`Config registration "${record.id}" value hash does not match.`);
    }
  }
}

function validateInsertedBlocks(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.insertedBlocks, "inserted blocks");
  assertUnique(manifest.insertedBlocks.map((record) => record.id), "block IDs");
  assertUnique(
    manifest.insertedBlocks.map((record) => `${record.path}\u0000${record.marker}`),
    "inserted block targets",
  );
  for (const record of manifest.insertedBlocks) {
    assertSingleHarnessRecord(record, "inserted block");
    assertPath(record.path, options.root);
    assertKey(record.marker, "inserted block marker");
    if (typeof record.block !== "string" || !record.block) {
      throw new Error(`Inserted block "${record.id}" must contain exact text.`);
    }
    assertSha256(record.blockSha256, `inserted block "${record.id}" hash`);
    if (hashOwnedValue(record.block) !== record.blockSha256) {
      throw new Error(`Inserted block "${record.id}" hash does not match.`);
    }
  }
}

function validateDisplacedValues(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.displacedValues, "displaced values");
  assertUnique(manifest.displacedValues.map((record) => record.id), "displaced IDs");
  assertUnique(
    manifest.displacedValues.map((record) => record.restoreDataId),
    "restore data IDs",
  );
  for (const record of manifest.displacedValues) {
    assertSingleHarnessRecord(record, "displaced value");
    assertPath(record.path, options.root);
    assertKey(record.key, "displaced value key");
    if (!isSafeIdentifier(record.restoreDataId)) {
      throw new Error(`Displaced value "${record.id}" has an invalid restore-data ID.`);
    }
    assertSha256(record.originalValueSha256, `displaced value "${record.id}" original hash`);
    assertSha256(record.installedValueSha256, `displaced value "${record.id}" installed hash`);
    if (record.valueKind !== "json" && record.valueKind !== "text") {
      throw new Error(`Displaced value "${record.id}" has an invalid value kind.`);
    }
    if (typeof record.secret !== "boolean") {
      throw new Error(`Displaced value "${record.id}" has an invalid secret flag.`);
    }
  }
}

function validateResidualOwnership(
  manifest: OwnershipManifest,
  options: ManifestValidationOptions,
): void {
  assertArray(manifest.residualOwnership, "residual ownership");
  assertUnique(manifest.residualOwnership.map((record) => record.id), "residual IDs");
  for (const record of manifest.residualOwnership) {
    if (
      !isRecord(record) ||
      !isSafeIdentifier(record.id) ||
      !isSafeIdentifier(record.sourceId)
    ) {
      throw new Error("Residual ownership has invalid identity fields.");
    }
    if (
      ![
        "file",
        "directory",
        "dependency",
        "config-registration",
        "inserted-block",
      ].includes(record.artifactType)
    ) {
      throw new Error(`Residual ownership "${record.id}" has an invalid artifact type.`);
    }
    assertPath(record.path, options.root);
    if (
      record.reason !== "modified" &&
      record.reason !== "concurrent-change" &&
      record.reason !== "missing-restore-data"
    ) {
      throw new Error(`Residual ownership "${record.id}" has an invalid reason.`);
    }
    if (record.expectedSha256 !== undefined) {
      assertSha256(record.expectedSha256, `residual "${record.id}" expected hash`);
    }
    if (record.observedSha256 !== undefined) {
      assertSha256(record.observedSha256, `residual "${record.id}" observed hash`);
    }
    if (!isIsoDate(record.retainedAt)) {
      throw new Error(`Residual ownership "${record.id}" has an invalid timestamp.`);
    }
  }
}

function assertRecordBase(
  record: { id?: unknown; harnesses?: unknown },
  label: string,
): void {
  if (!isSafeIdentifier(record.id)) {
    throw new Error(`${label} has an invalid ID.`);
  }
  if (!isAgentList(record.harnesses) || record.harnesses.length === 0) {
    throw new Error(`${label} must name at least one harness.`);
  }
}

function assertSingleHarnessRecord(
  record: { id?: unknown; harness?: unknown },
  label: string,
): void {
  if (!isSafeIdentifier(record.id) || !isAgentKind(record.harness)) {
    throw new Error(`${label} has invalid identity or harness fields.`);
  }
}

function assertPath(value: unknown, root?: string): void {
  validateSafeRelativePath(value, root);
}

function assertKey(value: unknown, label: string): void {
  if (typeof value !== "string" || !value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON data without executable values.`);
  }
}

function assertSha256(value: unknown, label: string): void {
  if (!isSha256(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Ownership manifest ${label} must be an array.`);
  }
}

function assertUnique(values: string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Ownership manifest contains duplicate ${label}.`);
  }
}

function allRecords(manifest: OwnershipManifest): Array<{ id: string; harnesses: AgentKind[] }> {
  return [
    ...manifest.files,
    ...manifest.directories,
    ...manifest.dependencies,
    ...manifest.configRegistrations.map((record) => ({ ...record, harnesses: [record.harness] })),
    ...manifest.insertedBlocks.map((record) => ({ ...record, harnesses: [record.harness] })),
    ...manifest.displacedValues.map((record) => ({ ...record, harnesses: [record.harness] })),
  ];
}

function isSafeRelativePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\u0000") ||
    /[\u0001-\u001f\u007f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("//")
  ) {
    return false;
  }
  const segments = value.split("/");
  return (
    segments.every((segment) => segment && segment !== "." && segment !== "..") &&
    path.posix.normalize(value) === value &&
    !segments.some((segment) => segment.toLowerCase() === ".workflow")
  );
}

function assertPathContainedByRoot(relativePath: string, root: string): void {
  assertCanonicalRoot(root);
  const realRoot = realpathSync(root);
  let candidate = path.resolve(root, ...relativePath.split("/"));
  while (true) {
    try {
      const candidateStat = lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        const realCandidate = resolveRealPath(candidate, relativePath);
        if (!isPathInside(realRoot, realCandidate)) {
          throw new Error(`Owned path escapes its root through a symlink: ${relativePath}.`);
        }
        return;
      }
      break;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  const realCandidate = resolveRealPath(candidate, relativePath);
  if (!isPathInside(realRoot, realCandidate)) {
    throw new Error(`Owned path escapes its root through a symlink: ${relativePath}.`);
  }
}

function assertPrivateRestoreRoot(projectRoot: string, privateRestoreRoot: string): void {
  const projectRealRoot = realpathSync(projectRoot);
  const restoreRealRoot = realpathSync(privateRestoreRoot);
  if (
    isPathInside(projectRoot, privateRestoreRoot) ||
    isPathInside(projectRealRoot, restoreRealRoot)
  ) {
    throw new Error("Project restore data must be stored outside the project root.");
  }
}

function resolveRealPath(candidate: string, relativePath: string): string {
  try {
    return realpathSync(candidate);
  } catch (error) {
    throw new Error(
      `Owned path cannot be resolved safely: ${relativePath}: ${errorMessage(error)}`,
    );
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function assertCanonicalRoot(root: string): void {
  if (
    typeof root !== "string" ||
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    /[\u0000-\u001f\u007f]/.test(root) ||
    !existsSync(root)
  ) {
    throw new Error("Ownership root must be an existing absolute canonical path.");
  }
  if (!statSync(root).isDirectory()) {
    throw new Error("Ownership root must be a directory.");
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentList(value: unknown): value is AgentKind[] {
  return Array.isArray(value) && value.every(isAgentKind) && new Set(value).size === value.length;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(value);
}

function isManifestIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value);
}

function isPackageName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
