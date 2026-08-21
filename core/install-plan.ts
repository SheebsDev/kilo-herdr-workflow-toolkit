import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import * as path from "node:path";
import { parse as parseToml } from "toml";

import {
  PAYLOAD_INVENTORY,
  compareDisplacedValue,
  compareOwnership,
  hashOwnedValue,
  validateOwnershipManifest,
  validateRestoreData,
  validateSafeRelativePath,
} from "./ownership-manifest.ts";
import type {
  OwnershipManifest,
  PayloadArtifactType,
  RestoreData,
} from "./ownership-manifest.ts";
import {
  AGENT_KINDS,
  isAgentKind,
  isJsonValue,
} from "./model.ts";
import type { AgentKind, JsonValue } from "./model.ts";
import { snapshotFileSystemTree } from "./filesystem-tree.ts";
import { getTrustedWorkerProfile, isWorkerExecutableAvailable } from "./worker-profile.ts";

export const INSTALL_SELECTIONS = [...AGENT_KINDS, "all"] as const;
export type InstallSelection = (typeof INSTALL_SELECTIONS)[number];
export type InstallOperation = "install" | "update" | "uninstall";
export type InstallScope = "user" | "project";

export interface SourceInventoryEntry {
  readonly artifactType: PayloadArtifactType;
  readonly sourcePath: string;
  readonly destinationPath?: string;
  readonly destinationRelativePath?: string;
  readonly harnesses: readonly AgentKind[];
  readonly sha256: string;
  readonly size: number;
}

export type DestinationKind = "file" | "directory" | "other";

export interface DestinationSnapshot {
  readonly exists: boolean;
  readonly kind?: DestinationKind;
  readonly sha256?: string;
  readonly snapshotSha256?: string;
  readonly treeSha256?: string;
  readonly entries?: readonly DirectorySnapshotEntry[];
  readonly content?: string;
}

export interface DirectorySnapshotEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "link";
  readonly sha256: string;
  readonly contentBase64?: string;
  readonly linkTarget?: string;
}

export type PlannedOwnershipState =
  | "unrelated"
  | "owned-missing"
  | "owned-unchanged"
  | "owned-modified";

export interface DestinationPrecondition {
  readonly path: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly kind?: DestinationKind;
  readonly sha256?: string;
  readonly snapshotSha256?: string;
  readonly treeSha256?: string;
  readonly entries?: readonly DirectorySnapshotEntry[];
  readonly ownership: PlannedOwnershipState;
  readonly expectedSha256?: string;
  readonly priorContent?: string;
}

export interface RequiredParentDirectory {
  readonly path: string;
  readonly relativePath: string;
  readonly harnesses: readonly AgentKind[];
  readonly exists: false;
}

export interface FileRollbackInput {
  readonly type: "file";
  readonly path: string;
  readonly existed: boolean;
  readonly kind?: DestinationKind;
  readonly sha256?: string;
  readonly content?: string;
}

export interface ConfigRollbackInput {
  readonly type: "config";
  readonly path: string;
  readonly key: string;
  readonly existed: boolean;
  readonly sha256?: string;
  readonly value?: JsonValue;
  readonly content?: string;
}

export interface ExternalRegistrationRollbackInput {
  readonly type: "external-registration";
  readonly path: string;
  readonly key: string;
  readonly existed: boolean;
  readonly value?: string;
}

export interface DirectoryRollbackInput {
  readonly type: "directory" | "dependency" | "inserted-block";
  readonly path: string;
  readonly existed: boolean;
  readonly sha256?: string;
  readonly entries?: readonly DirectorySnapshotEntry[];
  readonly content?: string;
}

export type RollbackInput =
  | FileRollbackInput
  | ConfigRollbackInput
  | ExternalRegistrationRollbackInput
  | DirectoryRollbackInput;

export type PlannedChangeAction =
  | "create"
  | "replace"
  | "remove"
  | "restore"
  | "preserve"
  | "unchanged";

export interface PlannedOwnedChange {
  readonly id: string;
  readonly artifactType:
    | PayloadArtifactType
    | "directory"
    | "dependency"
    | "config-registration"
    | "external-registration"
    | "inserted-block";
  readonly harnesses: readonly AgentKind[];
  readonly sourcePath?: string;
  readonly destinationPath: string;
  readonly destinationRelativePath: string;
  readonly action: PlannedChangeAction;
  readonly sha256?: string;
  readonly desiredValue?: JsonValue;
  readonly semanticKey?: string;
  readonly adapterKind?: "claude-json" | "codex-toml" | "inserted-block";
  readonly ownershipState?: PlannedOwnershipState;
  readonly preservationReason?:
    | "modified"
    | "missing"
    | "shared"
    | "missing-restore-data";
  readonly dependencyInput?: {
    readonly packageManager: "npm";
    readonly packageNames: readonly string[];
    readonly lockfilePath?: string;
  };
  readonly warning?: string;
}

export interface InstallWarning {
  readonly code:
    | "modified-owned-content"
    | "conflict-forced"
    | "shared-content-retained"
    | "missing-owned-content"
    | "checkout-moved"
    | "trust-required";
  readonly path?: string;
  readonly message: string;
}

export interface InstallPlan {
  readonly operation: InstallOperation;
  readonly scope: InstallScope;
  readonly harnesses: readonly AgentKind[];
  readonly checkoutRoot: string;
  readonly destinationRoot: string;
  readonly sourceInventory: readonly SourceInventoryEntry[];
  readonly destinationPreconditions: readonly DestinationPrecondition[];
  readonly requiredParentDirectories: readonly RequiredParentDirectory[];
  readonly ownedChanges: readonly PlannedOwnedChange[];
  readonly rollbackInputs: readonly RollbackInput[];
  readonly prerequisites: readonly string[];
  readonly warnings: readonly InstallWarning[];
}

export interface InstallConfigTarget {
  readonly harness: AgentKind;
  /** Path relative to destinationRoot. */
  readonly path: string;
  readonly key: string;
  readonly format: "json" | "toml";
  readonly installedValue: JsonValue;
  readonly trustRequired?: boolean;
}

export interface InstallExternalRegistrationTarget {
  readonly harness: AgentKind;
  /** Logical resource path relative to destinationRoot; no file is created here. */
  readonly path: string;
  readonly key: string;
  readonly installedValue: string;
}

export interface InstallExternalRegistrationSnapshot {
  readonly exists: boolean;
  readonly value?: string;
}

export interface InstallConfigSnapshot {
  readonly exists: boolean;
  readonly parseable: boolean;
  readonly value?: JsonValue;
  readonly content?: string;
  readonly sha256?: string;
  readonly snapshotSha256?: string;
  readonly treeSha256?: string;
  readonly entries?: readonly DirectorySnapshotEntry[];
}

export interface InstallTrustTarget {
  readonly harness: AgentKind;
  readonly path: string;
  readonly trusted: boolean;
  readonly message?: string;
}

export interface InstallPreflightBackend {
  readonly checkHarness?: (
    harness: AgentKind,
  ) => boolean | void | Promise<boolean | void>;
  readonly checkNode?: () => boolean | void | Promise<boolean | void>;
  readonly checkNpm?: () => boolean | void | Promise<boolean | void>;
  readonly checkDependencies?: () => boolean | void | Promise<boolean | void>;
  readonly checkHerdr?: () => boolean | void | Promise<boolean | void>;
  readonly checkIntegration?: (
    harness: AgentKind,
  ) => boolean | void | Promise<boolean | void>;
  readonly readDestination?: (
    absolutePath: string,
  ) => DestinationSnapshot | Promise<DestinationSnapshot>;
  readonly readConfig?: (
    target: InstallConfigTarget,
    absolutePath: string,
  ) => InstallConfigSnapshot | Promise<InstallConfigSnapshot>;
  readonly readExternalRegistration?: (
    target: InstallExternalRegistrationTarget,
  ) => InstallExternalRegistrationSnapshot | Promise<InstallExternalRegistrationSnapshot>;
  readonly readTrust?: (
    target: InstallTrustTarget,
  ) => boolean | Promise<boolean>;
}

export interface InstallPlanRequest {
  readonly operation?: InstallOperation;
  readonly scope: InstallScope;
  readonly selections?: InstallSelection | readonly InstallSelection[];
  readonly checkoutRoot: string;
  readonly destinationRoot: string;
  readonly existingManifest?: OwnershipManifest;
  readonly existingRestoreData?: RestoreData;
  readonly configTargets?: readonly InstallConfigTarget[];
  readonly externalRegistrationTargets?: readonly InstallExternalRegistrationTarget[];
  readonly trustTargets?: readonly InstallTrustTarget[];
  readonly force?: boolean;
  readonly skipDependencies?: boolean;
  readonly backend?: InstallPreflightBackend;
}

export class InstallPreflightError extends Error {
  readonly failures: readonly string[];

  constructor(failures: readonly string[]) {
    super(`Install preflight failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`);
    this.name = "InstallPreflightError";
    this.failures = [...failures];
  }
}

/**
 * Normalize repeatable installer arguments without allowing a harness to be
 * selected more than once. An omitted or empty selection is intentionally
 * Kilo-only for compatibility with existing installers.
 */
export function normalizeInstallHarnesses(
  value?: unknown,
): AgentKind[] {
  const raw = value === undefined ? [] : Array.isArray(value) ? value : [value];
  if (raw.length === 0) return ["kilo"];

  const selected = new Set<AgentKind>();
  for (const candidate of raw) {
    if (candidate === "all") {
      for (const harness of AGENT_KINDS) selected.add(harness);
      continue;
    }
    if (!isAgentKind(candidate)) {
      throw new Error(
        `Unsupported install harness "${String(candidate)}". Choose kilo, claude, codex, or all.`,
      );
    }
    selected.add(candidate);
  }

  return AGENT_KINDS.filter((harness) => selected.has(harness));
}

export async function buildInstallPlan(
  request: InstallPlanRequest,
): Promise<InstallPlan> {
  const operation = request.operation ?? "install";
  const harnesses = normalizeInstallHarnesses(request.selections);
  const checkoutRoot = path.resolve(request.checkoutRoot);
  const destinationRoot = path.resolve(request.destinationRoot);
  const backend = request.backend ?? {};
  const manifest = request.existingManifest
    ? validateOwnershipManifest(request.existingManifest, { root: destinationRoot })
    : undefined;
  const restoreData = request.existingRestoreData
    ? validateRestoreData(request.existingRestoreData)
    : undefined;

  if (request.scope !== "user" && request.scope !== "project") {
    throw new Error(`Unsupported install scope "${String(request.scope)}".`);
  }
  if (!existsSync(checkoutRoot) || !lstatSync(checkoutRoot).isDirectory()) {
    throw new Error(`Checkout root is not a directory: ${checkoutRoot}`);
  }
  if (!existsSync(destinationRoot) || !lstatSync(destinationRoot).isDirectory()) {
    throw new Error(`Destination root is not a directory: ${destinationRoot}`);
  }
  if (manifest && manifest.scope !== request.scope) {
    throw new Error(
      `Ownership manifest scope "${manifest.scope}" does not match ${request.scope} planning.`,
    );
  }

  const failures: string[] = [];
  await preflightPrerequisites(request, harnesses, checkoutRoot, backend, failures);
  if (failures.length > 0) throw new InstallPreflightError(failures);

  const sourceInventory = collectSourceInventory(
    checkoutRoot,
    destinationRoot,
    request.scope,
    harnesses,
  );
  const destinationPreconditions: DestinationPrecondition[] = [];
  const ownedChanges: PlannedOwnedChange[] = [];
  const rollbackInputs: RollbackInput[] = [];
  const warnings: InstallWarning[] = [];
  const prerequisiteNames = describePrerequisites(request, harnesses);

  await preflightTrustTargets(request, harnesses, backend, failures, warnings);
  await preflightConfigTargets(
    request,
    harnesses,
    destinationRoot,
    backend,
    failures,
  );
  if (failures.length > 0) throw new InstallPreflightError(failures);

  const sourceDestinations = new Set(
    sourceInventory
      .filter((entry) => entry.destinationPath !== undefined)
      .map((entry) => entry.destinationPath!),
  );
  const preconditionByPath = new Map<string, DestinationPrecondition>();

  if (operation === "uninstall") {
    await planManifestRemoval(
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
      restoreData,
    );
  } else {
    for (const entry of sourceInventory) {
      if (!entry.destinationPath) continue;
      await planPayloadChange(
        entry,
        destinationRoot,
        manifest,
        request.force === true,
        backend,
        destinationPreconditions,
        preconditionByPath,
        ownedChanges,
        rollbackInputs,
        warnings,
      );
    }

    await planConfigChanges(
      request.configTargets ?? [],
      harnesses,
      destinationRoot,
      manifest,
      request.force === true,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );

    await planExternalRegistrationChanges(
      request.externalRegistrationTargets ?? [],
      harnesses,
      destinationRoot,
      manifest,
      request.force === true,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );

    if (operation === "update" && manifest) {
      await planStaleOwnedFiles(
        manifest,
        harnesses,
        destinationRoot,
        sourceDestinations,
        backend,
        destinationPreconditions,
        preconditionByPath,
        ownedChanges,
        rollbackInputs,
        warnings,
      );
      await planStaleOwnedContainersAndRegistrations(
        manifest,
        harnesses,
        destinationRoot,
        sourceDestinations,
        request.configTargets ?? [],
        backend,
        destinationPreconditions,
        preconditionByPath,
        ownedChanges,
        rollbackInputs,
        warnings,
        restoreData,
      );
    }
  }

  if (failures.length > 0) throw new InstallPreflightError(failures);

  const requiredParentDirectories = await inspectRequiredParentDirectories(
    ownedChanges,
    destinationRoot,
    backend,
  );

  const plan: InstallPlan = {
    operation,
    scope: request.scope,
    harnesses: [...harnesses],
    checkoutRoot,
    destinationRoot,
    sourceInventory,
    destinationPreconditions,
    requiredParentDirectories,
    ownedChanges,
    rollbackInputs,
    prerequisites: prerequisiteNames,
    warnings,
  };
  return deepFreeze(plan);
}

export const planInstallOperations = buildInstallPlan;

async function preflightPrerequisites(
  request: InstallPlanRequest,
  harnesses: readonly AgentKind[],
  checkoutRoot: string,
  backend: InstallPreflightBackend,
  failures: string[],
): Promise<void> {
  if (request.operation !== "uninstall") {
    for (const harness of harnesses) {
      try {
        const available = backend.checkHarness
          ? await backend.checkHarness(harness)
          : await isWorkerExecutableAvailable(harness);
        if (available === false) {
          const profile = getTrustedWorkerProfile(harness);
          failures.push(
            `${harness} CLI "${profile.executable}" is unavailable. ${profile.installCommand}`,
          );
        }
      } catch (error) {
        failures.push(`${harness} CLI preflight failed: ${errorMessage(error)}`);
      }
    }
  }

  if (request.operation !== "uninstall") {
    await requireCheck(
      "Node.js 22.22.2 or newer",
      backend.checkNode ?? (() => isSupportedNodeVersion()),
      failures,
    );
    if (!request.skipDependencies) {
      await requireCheck(
        "npm",
        backend.checkNpm ?? (() => probeExecutable("npm")),
        failures,
      );
      await requireCheck(
        "checkout dependencies",
        backend.checkDependencies ?? (() => hasUsableLockfile(checkoutRoot)),
        failures,
      );
    }
  }

  if (request.operation !== "uninstall") {
    await requireCheck(
      "Herdr",
      backend.checkHerdr ?? (() => probeExecutable("herdr")),
      failures,
    );
    for (const harness of harnesses) {
      if (harness === "kilo") continue;
      try {
        const current = backend.checkIntegration
          ? await backend.checkIntegration(harness)
          : await probeIntegration(harness);
        if (current === false) failures.push(`${harness} Herdr integration preflight failed.`);
      } catch (error) {
        failures.push(`${harness} Herdr integration preflight failed: ${errorMessage(error)}`);
      }
    }
  }
}

function describePrerequisites(
  request: InstallPlanRequest,
  harnesses: readonly AgentKind[],
): string[] {
  const prerequisites = ["checkout"];
  if ((request.operation ?? "install") === "uninstall") return prerequisites;
  prerequisites.push(...harnesses.map((harness) => `${harness} CLI`));
  prerequisites.push("Herdr", "Node.js 22.22.2 or newer");
  if (!request.skipDependencies) prerequisites.push("npm", "checkout dependencies");
  for (const harness of harnesses) {
    if (harness !== "kilo") prerequisites.push(`${harness} Herdr integration`);
  }
  return prerequisites;
}

async function preflightTrustTargets(
  request: InstallPlanRequest,
  harnesses: readonly AgentKind[],
  backend: InstallPreflightBackend,
  failures: string[],
  warnings: InstallWarning[],
): Promise<void> {
  for (const target of request.trustTargets ?? []) {
    if (!harnesses.includes(target.harness)) continue;
    let trusted = target.trusted;
    if (backend.readTrust) trusted = await backend.readTrust(target);
    if (trusted) continue;

    const message =
      target.message ??
      `Project trust is required before installing ${target.harness} artifacts at ${target.path}.`;
    failures.push(message);
    warnings.push({ code: "trust-required", path: target.path, message });
  }
}

async function preflightConfigTargets(
  request: InstallPlanRequest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  failures: string[],
): Promise<void> {
  for (const target of request.configTargets ?? []) {
    if (!harnesses.includes(target.harness)) continue;
    const expectedFormat = target.harness === "codex" ? "toml" : "json";
    if (target.format !== expectedFormat) {
      failures.push(
        `${target.harness} configuration ${target.path} must use ${expectedFormat.toUpperCase()} format.`,
      );
      continue;
    }
    if (target.trustRequired) {
      const trustTarget = request.trustTargets?.find(
        (candidate) => candidate.harness === target.harness && candidate.path === target.path,
      ) ?? { harness: target.harness, path: target.path, trusted: false };
      const trusted = backend.readTrust
        ? await backend.readTrust(trustTarget)
        : trustTarget.trusted;
      if (!trusted) {
        failures.push(
          `Project trust is required before installing ${target.harness} configuration at ${target.path}.`,
        );
      }
    }
    try {
      const relativePath = normalizeDestinationPath(target.path);
      const absolutePath = resolveDestination(destinationRoot, relativePath);
      const snapshot = backend.readConfig
        ? await backend.readConfig(target, absolutePath)
        : readConfigSnapshot(target, absolutePath);
      if (snapshot.exists && !snapshot.parseable) {
        failures.push(
          `${target.harness} configuration ${absolutePath} is not valid ${target.format.toUpperCase()}.`,
        );
      }
    } catch (error) {
      failures.push(
        `${target.harness} configuration ${target.path} could not be preflighted: ${errorMessage(error)}`,
      );
    }
  }
}

function collectSourceInventory(
  checkoutRoot: string,
  destinationRoot: string,
  scope: InstallScope,
  harnesses: readonly AgentKind[],
): SourceInventoryEntry[] {
  const mappings: Array<{
    artifactType: PayloadArtifactType;
    sourcePath: string;
    destinationPath: string | null;
    harnesses: readonly AgentKind[];
  }> = [];

  addMappingGroup("sharedRuntime", harnesses, mappings, scope);
  addMappingGroup("mcpEntrypoint", harnesses, mappings, scope);
  addMappingGroup("launcher", harnesses, mappings, scope);
  if (harnesses.includes("kilo")) addMappingGroup("kiloAdapter", ["kilo"], mappings, scope);

  for (const harness of harnesses) {
    if (harness === "kilo") continue;
    addHarnessSkillMappings("canonicalSkill", harness, mappings, scope);
    addHarnessSkillMappings("reviewerSkills", harness, mappings, scope);
  }

  const entries: SourceInventoryEntry[] = [];
  const seen = new Set<string>();
  for (const mapping of mappings) {
    const sourceFiles = expandSourceFiles(checkoutRoot, mapping.sourcePath);
    for (const sourceFile of sourceFiles) {
      const destinationRelativePath = mapping.destinationPath
        ? destinationForSource(mapping.destinationPath, mapping.sourcePath, sourceFile)
        : undefined;
      const destinationPath = destinationRelativePath
        ? resolveDestination(destinationRoot, destinationRelativePath)
        : undefined;
      const key = `${mapping.artifactType}\u0000${sourceFile}\u0000${destinationPath ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceAbsolutePath = path.join(checkoutRoot, sourceFile);
      const contents = readFileSync(sourceAbsolutePath);
      entries.push({
        artifactType: mapping.artifactType,
        sourcePath: sourceFile,
        destinationPath,
        destinationRelativePath,
        harnesses: [...mapping.harnesses],
        sha256: createHash("sha256").update(contents).digest("hex"),
        size: contents.byteLength,
      });
    }
  }

  return entries.sort((left, right) =>
    `${left.destinationRelativePath ?? ""}\u0000${left.sourcePath}`.localeCompare(
      `${right.destinationRelativePath ?? ""}\u0000${right.sourcePath}`,
    ),
  );
}

function addMappingGroup(
  key: keyof typeof PAYLOAD_INVENTORY,
  harnesses: readonly AgentKind[],
  mappings: Array<{
    artifactType: PayloadArtifactType;
    sourcePath: string;
    destinationPath: string | null;
    harnesses: readonly AgentKind[];
  }>,
  scope: InstallScope,
): void {
  const inventory = PAYLOAD_INVENTORY[key];
  const sourceMappings = scope === "user" ? inventory.userMappings : inventory.projectMappings;
  for (const mapping of sourceMappings) {
    mappings.push({
      artifactType: inventory.artifactType,
      sourcePath: mapping.sourcePath,
      destinationPath: mapping.destinationPath,
      harnesses,
    });
  }
}

function addHarnessSkillMappings(
  key: "canonicalSkill" | "reviewerSkills",
  harness: AgentKind,
  mappings: Array<{
    artifactType: PayloadArtifactType;
    sourcePath: string;
    destinationPath: string | null;
    harnesses: readonly AgentKind[];
  }>,
  scope: InstallScope,
): void {
  const inventory = PAYLOAD_INVENTORY[key];
  const sourceMappings = scope === "user" ? inventory.userMappings : inventory.projectMappings;
  const destinationPrefix = harness === "claude" ? ".claude/" : ".agents/";
  for (const mapping of sourceMappings) {
    if (!mapping.destinationPath?.startsWith(destinationPrefix)) continue;
    mappings.push({
      artifactType: inventory.artifactType,
      sourcePath: mapping.sourcePath,
      destinationPath: mapping.destinationPath,
      harnesses: [harness],
    });
  }
}

function expandSourceFiles(root: string, relativeSourcePath: string): string[] {
  validateSafeRelativePath(relativeSourcePath);
  const absolute = path.join(root, ...relativeSourcePath.split("/"));
  if (!existsSync(absolute)) throw new Error(`Checkout payload is missing: ${relativeSourcePath}`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) {
    throw new Error(`Checkout payload must not contain symlinks: ${relativeSourcePath}`);
  }
  if (info.isFile()) return [relativeSourcePath];
  if (!info.isDirectory()) throw new Error(`Checkout payload is not a file or directory: ${relativeSourcePath}`);

  const files: string[] = [];
  for (const child of readdirSync(absolute, { withFileTypes: true })) {
    const childRelative = `${relativeSourcePath}/${child.name}`;
    if (child.isSymbolicLink()) throw new Error(`Checkout payload must not contain symlinks: ${childRelative}`);
    if (child.isDirectory()) files.push(...expandSourceFiles(root, childRelative));
    else if (child.isFile()) files.push(childRelative);
  }
  return files.sort();
}

function destinationForSource(
  destinationRootPath: string,
  sourceRootPath: string,
  sourceFile: string,
): string {
  if (sourceFile === sourceRootPath) return normalizeDestinationPath(destinationRootPath);
  const suffix = sourceFile.slice(`${sourceRootPath}/`.length);
  return normalizeDestinationPath(`${destinationRootPath}/${suffix}`);
}

async function planPayloadChange(
  entry: SourceInventoryEntry,
  destinationRoot: string,
  manifest: OwnershipManifest | undefined,
  force: boolean,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  const destinationPath = entry.destinationPath!;
  const relativePath = entry.destinationRelativePath!;
  const snapshot = await readDestination(backend, destinationPath);
  const state = fileOwnershipState(manifest, relativePath, snapshot);
  addFilePrecondition(
    destinationRoot,
    relativePath,
    snapshot,
    state,
    entry.sha256,
    manifest,
    destinationPreconditions,
    preconditionByPath,
  );

  if (snapshot.exists && snapshot.kind !== "file") {
    throw new InstallPreflightError([`Destination is not a file: ${destinationPath}`]);
  }

  let action: PlannedChangeAction;
  let warning: string | undefined;
  if (!snapshot.exists) action = "create";
  else if (snapshot.sha256 === entry.sha256) action = "unchanged";
  else if (state === "owned-modified" && !force) {
    action = "preserve";
    warning = `Owned file was modified and will be retained: ${destinationPath}. Re-run with --force only after reviewing the captured rollback state.`;
    warnings.push({ code: "modified-owned-content", path: destinationPath, message: warning });
  } else if (state === "unrelated") {
    throw new InstallPreflightError([
      `Destination conflict at ${destinationPath}. Unrelated skill or payload files cannot be safely force-replaced because no displaced-file restoration contract exists.`,
    ]);
  } else {
    action = "replace";
  }

  if (action === "replace" || action === "create") {
    rollbackInputs.push({
      type: "file",
      path: destinationPath,
      existed: snapshot.exists,
      kind: snapshot.kind,
      sha256: snapshot.sha256,
    });
  }
  ownedChanges.push({
    id: `file-${hashText(`${entry.artifactType}:${relativePath}`)}`,
    artifactType: entry.artifactType,
    harnesses: entry.harnesses,
    sourcePath: entry.sourcePath,
    destinationPath,
    destinationRelativePath: relativePath,
    action,
    sha256: entry.sha256,
    warning,
  });
}

async function planConfigChanges(
  targets: readonly InstallConfigTarget[],
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  manifest: OwnershipManifest | undefined,
  force: boolean,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  for (const target of targets) {
    if (!harnesses.includes(target.harness)) continue;
    const relativePath = normalizeDestinationPath(target.path);
    const absolutePath = resolveDestination(destinationRoot, relativePath);
    const snapshot = backend.readConfig
      ? await backend.readConfig(target, absolutePath)
      : readConfigSnapshot(target, absolutePath);
    if (snapshot.exists && !snapshot.parseable) continue;
    const record = manifest?.configRegistrations.find(
      (candidate) => candidate.path === relativePath && candidate.key === target.key,
    );
    const state: PlannedOwnershipState = !record
      ? "unrelated"
      : !snapshot.exists
        ? "owned-missing"
        : snapshot.value !== undefined &&
            hashOwnedValue(snapshot.value) === record.installedValueSha256
          ? "owned-unchanged"
          : "owned-modified";
    addConfigPrecondition(
      destinationRoot,
      relativePath,
      snapshot,
      state,
      record?.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );

    let action: PlannedChangeAction;
    let warning: string | undefined;
    if (!snapshot.exists) action = "create";
    else if (snapshot.value !== undefined && hashOwnedValue(snapshot.value) === hashOwnedValue(target.installedValue)) action = "unchanged";
    else if (state === "owned-modified" && !force) {
      action = "preserve";
      warning = `Owned configuration value was modified and will be retained: ${absolutePath}#${target.key}.`;
      warnings.push({ code: "modified-owned-content", path: absolutePath, message: warning });
    } else if (snapshot.value === undefined && snapshot.exists) {
      action = "create";
    } else if (state === "unrelated" && !force) {
      throw new InstallPreflightError([
        `Configuration conflict at ${absolutePath}#${target.key}. Re-run with --force only when the prior value can be restored safely.`,
      ]);
    } else {
      if (snapshot.value === undefined) {
        throw new InstallPreflightError([
          `Cannot safely replace ${absolutePath}#${target.key}: the exact prior value was not available for rollback.`,
        ]);
      }
      action = "replace";
      warning = state === "unrelated"
        ? `Unrelated configuration will be replaced explicitly: ${absolutePath}#${target.key}.`
        : undefined;
      if (warning) warnings.push({ code: "conflict-forced", path: absolutePath, message: warning });
    }

    if (
      record &&
      hashOwnedValue(record.installedValue) !== hashOwnedValue(target.installedValue)
    ) {
      const message =
        `Checkout-backed registration ${absolutePath}#${target.key} changed; reinstall after moving the checkout or Node executable.`;
      warnings.push({ code: "checkout-moved", path: absolutePath, message });
    }

    if (action === "replace" || action === "create") {
      rollbackInputs.push({
        type: "config",
        path: absolutePath,
        key: target.key,
        existed: snapshot.exists,
        sha256: snapshot.value === undefined ? undefined : hashOwnedValue(snapshot.value),
        value: snapshot.value,
        content: snapshot.content,
      });
    }
    ownedChanges.push({
      id: `config-${hashText(`${target.harness}:${relativePath}:${target.key}`)}`,
      artifactType: "config-registration",
      harnesses: [target.harness],
      destinationPath: absolutePath,
      destinationRelativePath: relativePath,
      action,
      sha256: hashOwnedValue(target.installedValue),
      desiredValue: target.installedValue,
      semanticKey: target.key,
      adapterKind: target.format === "json" ? "claude-json" : "codex-toml",
      ownershipState: state,
      warning,
    });
  }
}

async function planExternalRegistrationChanges(
  targets: readonly InstallExternalRegistrationTarget[],
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  manifest: OwnershipManifest | undefined,
  force: boolean,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  for (const target of targets) {
    if (!harnesses.includes(target.harness)) continue;
    if (!backend.readExternalRegistration) {
      throw new InstallPreflightError([
        `External registration ${target.key} requires an injected inspection backend.`,
      ]);
    }
    const relativePath = normalizeDestinationPath(target.path);
    const absolutePath = resolveDestination(destinationRoot, relativePath);
    const snapshot = await backend.readExternalRegistration(target);
    if (snapshot.exists !== (snapshot.value !== undefined)) {
      throw new InstallPreflightError([
        `External registration ${target.key} returned an inconsistent snapshot.`,
      ]);
    }
    const record = manifest?.externalRegistrations.find(
      (candidate) => candidate.path === relativePath && candidate.key === target.key,
    );
    const state: PlannedOwnershipState = !record
      ? "unrelated"
      : !snapshot.exists
        ? "owned-missing"
        : hashOwnedValue(snapshot.value!) === record.installedValueSha256
          ? "owned-unchanged"
          : "owned-modified";
    addExternalRegistrationPrecondition(
      destinationRoot,
      relativePath,
      snapshot,
      state,
      record?.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );

    let action: PlannedChangeAction;
    let warning: string | undefined;
    if (!snapshot.exists) action = "create";
    else if (snapshot.value === target.installedValue) action = "unchanged";
    else if (state === "owned-modified" && !force) {
      action = "preserve";
      warning = `Owned external registration was modified and will be retained: ${target.key}.`;
      warnings.push({ code: "modified-owned-content", path: target.key, message: warning });
    } else if (state === "unrelated" && !force) {
      throw new InstallPreflightError([
        `External registration conflict at ${target.key}. Re-run with --force only when the prior value can be restored safely.`,
      ]);
    } else {
      action = "replace";
      if (state === "unrelated") {
        warning = `Unrelated external registration will be replaced explicitly: ${target.key}.`;
        warnings.push({ code: "conflict-forced", path: target.key, message: warning });
      }
    }

    if (record && record.installedValue !== target.installedValue) {
      const message =
        `Checkout-backed registration ${target.key} moved from ${record.installedValue} to ${target.installedValue}; reinstall after moving the checkout.`;
      warnings.push({ code: "checkout-moved", path: target.key, message });
    }
    if (action === "replace" || action === "create") {
      rollbackInputs.push({
        type: "external-registration",
        path: absolutePath,
        key: target.key,
        existed: snapshot.exists,
        value: snapshot.value,
      });
    }
    ownedChanges.push({
      id: `external-${hashText(`${target.harness}:${relativePath}:${target.key}`)}`,
      artifactType: "external-registration",
      harnesses: [target.harness],
      destinationPath: absolutePath,
      destinationRelativePath: relativePath,
      action,
      sha256: hashOwnedValue(target.installedValue),
      desiredValue: target.installedValue,
      semanticKey: target.key,
      ownershipState: state,
      warning,
    });
  }
}

async function planManifestRemoval(
  manifest: OwnershipManifest | undefined,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
  restoreData: RestoreData | undefined,
): Promise<void> {
  if (!manifest) return;
  await planManifestDirectoriesAndDependencies(
    manifest,
    harnesses,
    destinationRoot,
    backend,
    destinationPreconditions,
    preconditionByPath,
    ownedChanges,
    rollbackInputs,
    warnings,
  );
  for (const record of manifest.files) {
    if (!record.harnesses.some((harness) => harnesses.includes(harness))) continue;
    const destinationPath = resolveDestination(destinationRoot, record.path);
    const snapshot = await readDestination(backend, destinationPath);
    const state = fileOwnershipState(manifest, record.path, snapshot);
    addFilePrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.sha256,
      manifest,
      destinationPreconditions,
      preconditionByPath,
    );
    const shared = record.harnesses.some((harness) => !harnesses.includes(harness));
    if (shared) {
      const message = `Owned file retained because other harnesses still use it: ${destinationPath}.`;
      warnings.push({ code: "shared-content-retained", path: destinationPath, message });
      ownedChanges.push({
        id: record.id,
        artifactType: record.artifactType,
        harnesses: record.harnesses,
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.sha256,
        warning: message,
      });
      continue;
    }
    if (state !== "owned-unchanged") {
      const message = state === "owned-modified"
        ? `Modified owned file retained during uninstall: ${destinationPath}.`
        : `Owned file is missing and was not changed: ${destinationPath}.`;
      warnings.push({
        code: state === "owned-modified" ? "modified-owned-content" : "missing-owned-content",
        path: destinationPath,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: record.artifactType,
        harnesses: record.harnesses,
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.sha256,
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "file",
      path: destinationPath,
      existed: true,
      kind: snapshot.kind,
      sha256: snapshot.sha256,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: record.artifactType,
      harnesses: record.harnesses,
      destinationPath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.sha256,
    });
  }

  const displacedKeys = new Set(
    manifest.displacedValues
      .filter((record) => harnesses.includes(record.harness))
      .map((record) => `${record.path}\u0000${record.key}`),
  );
  await planDisplacedValues(
    manifest,
    harnesses,
    destinationRoot,
    backend,
    destinationPreconditions,
    preconditionByPath,
    ownedChanges,
    rollbackInputs,
    warnings,
    restoreData,
  );

  const externalDisplacedKeys = new Set(
    manifest.displacedValues
      .filter((record) =>
        harnesses.includes(record.harness) &&
        manifest.externalRegistrations.some(
          (registration) =>
            registration.harness === record.harness &&
            registration.path === record.path &&
            registration.key === record.key,
        )
      )
      .map((record) => `${record.path}\u0000${record.key}`),
  );
  await planExternalDisplacedValues(
    manifest,
    harnesses,
    destinationRoot,
    backend,
    destinationPreconditions,
    preconditionByPath,
    ownedChanges,
    rollbackInputs,
    warnings,
    restoreData,
  );

  for (const record of manifest.configRegistrations) {
    if (!harnesses.includes(record.harness)) continue;
    if (displacedKeys.has(`${record.path}\u0000${record.key}`)) continue;
    const target: InstallConfigTarget = {
      harness: record.harness,
      path: record.path,
      key: record.key,
      format: record.harness === "codex" ? "toml" : "json",
      installedValue: record.installedValue,
    };
    const absolutePath = resolveDestination(destinationRoot, record.path);
    const snapshot = backend.readConfig
      ? await backend.readConfig(target, absolutePath)
      : readConfigSnapshot(target, absolutePath);
    const state: PlannedOwnershipState = !snapshot.exists
      ? "owned-missing"
      : snapshot.value !== undefined && hashOwnedValue(snapshot.value) === record.installedValueSha256
        ? "owned-unchanged"
        : "owned-modified";
    addConfigPrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );
    if (state !== "owned-unchanged") {
      const message = state === "owned-modified"
        ? `Modified owned configuration retained during uninstall: ${absolutePath}#${record.key}.`
        : `Owned configuration is missing and was not changed: ${absolutePath}#${record.key}.`;
      warnings.push({
        code: state === "owned-modified" ? "modified-owned-content" : "missing-owned-content",
        path: absolutePath,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: "config-registration",
        harnesses: [record.harness],
        destinationPath: absolutePath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.installedValueSha256,
        semanticKey: record.key,
        adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
        ownershipState: state,
        preservationReason: state === "owned-modified" ? "modified" : "missing",
        warning: message,
      });
      continue;
    }
    if (snapshot.value === undefined) {
      throw new InstallPreflightError([
        `Cannot safely uninstall ${absolutePath}#${record.key}: the exact prior value was not available for rollback.`,
      ]);
    }
    rollbackInputs.push({
      type: "config",
      path: absolutePath,
      key: record.key,
      existed: true,
      sha256: hashOwnedValue(snapshot.value),
      value: snapshot.value,
      content: snapshot.content,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "config-registration",
      harnesses: [record.harness],
      destinationPath: absolutePath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.installedValueSha256,
      semanticKey: record.key,
      adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
      ownershipState: state,
    });
  }

  for (const record of manifest.externalRegistrations) {
    if (!harnesses.includes(record.harness)) continue;
    if (externalDisplacedKeys.has(`${record.path}\u0000${record.key}`)) continue;
    if (!backend.readExternalRegistration) {
      throw new InstallPreflightError([
        `External registration ${record.key} requires an injected inspection backend.`,
      ]);
    }
    const target: InstallExternalRegistrationTarget = {
      harness: record.harness,
      path: record.path,
      key: record.key,
      installedValue: record.installedValue,
    };
    const snapshot = await backend.readExternalRegistration(target);
    const state: PlannedOwnershipState = !snapshot.exists
      ? "owned-missing"
      : snapshot.value !== undefined && hashOwnedValue(snapshot.value) === record.installedValueSha256
        ? "owned-unchanged"
        : "owned-modified";
    const absolutePath = resolveDestination(destinationRoot, record.path);
    addExternalRegistrationPrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );
    if (state !== "owned-unchanged") {
      const message = state === "owned-modified"
        ? `Modified owned external registration retained during uninstall: ${record.key}.`
        : `Owned external registration is missing and was not changed: ${record.key}.`;
      warnings.push({
        code: state === "owned-modified" ? "modified-owned-content" : "missing-owned-content",
        path: record.key,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: "external-registration",
        harnesses: [record.harness],
        destinationPath: absolutePath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.installedValueSha256,
        semanticKey: record.key,
        ownershipState: state,
        preservationReason: state === "owned-modified" ? "modified" : "missing",
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "external-registration",
      path: absolutePath,
      key: record.key,
      existed: true,
      value: snapshot.value,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "external-registration",
      harnesses: [record.harness],
      destinationPath: absolutePath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.installedValueSha256,
      semanticKey: record.key,
      ownershipState: state,
    });
  }
}

async function planManifestDirectoriesAndDependencies(
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  for (const record of manifest.directories) {
    if (!record.harnesses.some((harness) => harnesses.includes(harness))) continue;
    await planOwnedContainerRemoval(
      record.id,
      "directory",
      record.harnesses,
      record.path,
      record.snapshotSha256,
      "directory",
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );
  }
  for (const record of manifest.dependencies) {
    if (!record.harnesses.some((harness) => harnesses.includes(harness))) continue;
    await planOwnedContainerRemoval(
      record.id,
      "dependency",
      record.harnesses,
      record.path,
      record.treeSha256,
      "dependency",
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );
  }
  for (const record of manifest.insertedBlocks) {
    if (!harnesses.includes(record.harness)) continue;
    const destinationPath = resolveDestination(destinationRoot, record.path);
    const snapshot = await readDestination(backend, destinationPath);
    const state = !snapshot.exists
      ? "owned-missing"
      : snapshot.content?.includes(record.block)
        ? "owned-unchanged"
        : "owned-modified";
    addFilePrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.blockSha256,
      manifest,
      destinationPreconditions,
      preconditionByPath,
    );
    const shared = false;
    if (state !== "owned-unchanged" || shared) {
      const message = state === "owned-modified"
        ? `Modified owned block retained during uninstall: ${destinationPath}.`
        : `Owned block is missing and was not changed: ${destinationPath}.`;
      warnings.push({
        code: state === "owned-modified" ? "modified-owned-content" : "missing-owned-content",
        path: destinationPath,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: "inserted-block",
        harnesses: [record.harness],
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.blockSha256,
        semanticKey: record.marker,
        adapterKind: "inserted-block",
        warning: message,
      });
      continue;
    }
    if (snapshot.content === undefined) {
      throw new InstallPreflightError([
        `Cannot safely uninstall owned block ${destinationPath}: exact prior content was not available.`,
      ]);
    }
    rollbackInputs.push({
      type: "inserted-block",
      path: destinationPath,
      existed: true,
      sha256: snapshot.sha256,
      content: snapshot.content,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "inserted-block",
      harnesses: [record.harness],
      destinationPath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.blockSha256,
      semanticKey: record.marker,
      adapterKind: "inserted-block",
    });
  }
}

async function planOwnedContainerRemoval(
  id: string,
  artifactType: "directory" | "dependency",
  recordHarnesses: readonly AgentKind[],
  relativePath: string,
  expectedSha256: string,
  candidateType: "directory" | "dependency",
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  const destinationPath = resolveDestination(destinationRoot, relativePath);
  const snapshot = await readDestination(backend, destinationPath);
  if (snapshot.exists && snapshot.kind !== "directory") {
    throw new InstallPreflightError([
      `Owned ${artifactType} destination is not a directory: ${destinationPath}.`,
    ]);
  }
  const comparison = compareOwnership(manifest, {
    type: candidateType,
    path: relativePath,
    exists: snapshot.exists,
    ...(candidateType === "directory"
      ? { snapshotSha256: snapshot.snapshotSha256 }
      : { treeSha256: snapshot.treeSha256 }),
  });
  const state = comparison.state as PlannedOwnershipState;
  addFilePrecondition(
    destinationRoot,
    relativePath,
    snapshot,
    state,
    expectedSha256,
    manifest,
    destinationPreconditions,
    preconditionByPath,
  );
  const shared = recordHarnesses.some((harness) => !harnesses.includes(harness));
  if (shared || state !== "owned-unchanged") {
    const message = shared
      ? `Owned ${artifactType} retained because other harnesses still use it: ${destinationPath}.`
      : state === "owned-modified"
        ? `Modified owned ${artifactType} retained during uninstall: ${destinationPath}.`
        : `Owned ${artifactType} is missing and was not changed: ${destinationPath}.`;
    warnings.push({
      code: shared ? "shared-content-retained" : state === "owned-modified" ? "modified-owned-content" : "missing-owned-content",
      path: destinationPath,
      message,
    });
    ownedChanges.push({
      id,
      artifactType,
      harnesses: recordHarnesses,
      destinationPath,
      destinationRelativePath: relativePath,
      action: "preserve",
      sha256: expectedSha256,
      warning: message,
    });
    return;
  }
  rollbackInputs.push({
    type: artifactType,
    path: destinationPath,
    existed: true,
    sha256: candidateType === "directory" ? snapshot.snapshotSha256 : snapshot.treeSha256,
  });
  ownedChanges.push({
    id,
    artifactType,
    harnesses: recordHarnesses,
    destinationPath,
    destinationRelativePath: relativePath,
    action: "remove",
    sha256: expectedSha256,
  });
}

async function planDisplacedValues(
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
  restoreData: RestoreData | undefined,
  onlyKeys?: ReadonlySet<string>,
): Promise<void> {
  for (const record of manifest.displacedValues) {
    if (!harnesses.includes(record.harness)) continue;
    if (!manifest.configRegistrations.some(
      (registration) =>
        registration.harness === record.harness &&
        registration.path === record.path &&
        registration.key === record.key,
    )) continue;
    if (onlyKeys && !onlyKeys.has(`${record.path}\u0000${record.key}`)) continue;
    const target: InstallConfigTarget = {
      harness: record.harness,
      path: record.path,
      key: record.key,
      format: record.harness === "codex" ? "toml" : "json",
      installedValue: null,
    };
    const destinationPath = resolveDestination(destinationRoot, record.path);
    const snapshot = backend.readConfig
      ? await backend.readConfig(target, destinationPath)
      : readConfigSnapshot(target, destinationPath);
    const state: PlannedOwnershipState = !snapshot.exists
      ? "owned-missing"
      : snapshot.value !== undefined && hashOwnedValue(snapshot.value) === record.installedValueSha256
        ? "owned-unchanged"
        : "owned-modified";
    addConfigPrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );
    const comparison = restoreData && snapshot.value !== undefined
      ? compareDisplacedValue(record, snapshot.value, restoreData)
      : { state: "missing-restore-data" as const };
    if (comparison.state !== "restorable-displaced") {
      const message = `Displaced ${record.harness} configuration retained at ${destinationPath}#${record.key}: ${comparison.state}.`;
      warnings.push({ code: "modified-owned-content", path: destinationPath, message });
      ownedChanges.push({
        id: record.id,
        artifactType: "config-registration",
        harnesses: [record.harness],
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.installedValueSha256,
        semanticKey: record.key,
        adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
        ownershipState: state,
        preservationReason: comparison.state === "missing-restore-data"
          ? "missing-restore-data"
          : "modified",
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "config",
      path: destinationPath,
      key: record.key,
      existed: true,
      sha256: hashOwnedValue(snapshot.value!),
      value: snapshot.value,
      content: snapshot.content,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "config-registration",
      harnesses: [record.harness],
      destinationPath,
      destinationRelativePath: record.path,
      action: "restore",
      sha256: hashOwnedValue(comparison.value),
      desiredValue: comparison.value,
      semanticKey: record.key,
      adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
      ownershipState: state,
    });
  }
}

async function planExternalDisplacedValues(
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
  restoreData: RestoreData | undefined,
): Promise<void> {
  for (const record of manifest.displacedValues) {
    if (!harnesses.includes(record.harness)) continue;
    const registration = manifest.externalRegistrations.find(
      (candidate) =>
        candidate.harness === record.harness &&
        candidate.path === record.path &&
        candidate.key === record.key,
    );
    if (!registration) continue;
    if (!backend.readExternalRegistration) {
      throw new InstallPreflightError([
        `External registration ${record.key} requires an injected inspection backend.`,
      ]);
    }
    const target: InstallExternalRegistrationTarget = {
      harness: record.harness,
      path: record.path,
      key: record.key,
      installedValue: registration.installedValue,
    };
    const snapshot = await backend.readExternalRegistration(target);
    const state: PlannedOwnershipState = !snapshot.exists
      ? "owned-missing"
      : snapshot.value !== undefined && hashOwnedValue(snapshot.value) === record.installedValueSha256
        ? "owned-unchanged"
        : "owned-modified";
    const destinationPath = resolveDestination(destinationRoot, record.path);
    addExternalRegistrationPrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );
    const comparison = restoreData && snapshot.value !== undefined
      ? compareDisplacedValue(record, snapshot.value, restoreData)
      : { state: "missing-restore-data" as const };
    if (comparison.state !== "restorable-displaced" || typeof comparison.value !== "string") {
      const message =
        `Displaced external registration retained at ${record.key}: ${comparison.state}.`;
      warnings.push({ code: "modified-owned-content", path: record.key, message });
      ownedChanges.push({
        id: registration.id,
        artifactType: "external-registration",
        harnesses: [record.harness],
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.installedValueSha256,
        semanticKey: record.key,
        ownershipState: state,
        preservationReason: comparison.state === "missing-restore-data"
          ? "missing-restore-data"
          : "modified",
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "external-registration",
      path: destinationPath,
      key: record.key,
      existed: true,
      value: snapshot.value,
    });
    ownedChanges.push({
      id: registration.id,
      artifactType: "external-registration",
      harnesses: [record.harness],
      destinationPath,
      destinationRelativePath: record.path,
      action: "restore",
      sha256: hashOwnedValue(comparison.value),
      desiredValue: comparison.value,
      semanticKey: record.key,
      ownershipState: state,
    });
  }
}

async function planStaleOwnedFiles(
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  currentDestinations: Set<string>,
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
): Promise<void> {
  for (const record of manifest.files) {
    if (!record.harnesses.every((harness) => harnesses.includes(harness))) continue;
    const destinationPath = resolveDestination(destinationRoot, record.path);
    if (currentDestinations.has(destinationPath)) continue;
    const snapshot = await readDestination(backend, destinationPath);
    const state = fileOwnershipState(manifest, record.path, snapshot);
    addFilePrecondition(
      destinationRoot,
      record.path,
      snapshot,
      state,
      record.sha256,
      manifest,
      destinationPreconditions,
      preconditionByPath,
    );
    if (state !== "owned-unchanged") {
      const message = `Stale modified owned file retained during update: ${destinationPath}.`;
      warnings.push({ code: "modified-owned-content", path: destinationPath, message });
      ownedChanges.push({
        id: record.id,
        artifactType: record.artifactType,
        harnesses: record.harnesses,
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.sha256,
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "file",
      path: destinationPath,
      existed: true,
      kind: snapshot.kind,
      sha256: snapshot.sha256,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: record.artifactType,
      harnesses: record.harnesses,
      destinationPath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.sha256,
    });
  }
}

async function planStaleOwnedContainersAndRegistrations(
  manifest: OwnershipManifest,
  harnesses: readonly AgentKind[],
  destinationRoot: string,
  sourceDestinations: Set<string>,
  configTargets: readonly InstallConfigTarget[],
  backend: InstallPreflightBackend,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
  ownedChanges: PlannedOwnedChange[],
  rollbackInputs: RollbackInput[],
  warnings: InstallWarning[],
  restoreData: RestoreData | undefined,
): Promise<void> {
  const containsCurrentSource = (relativePath: string): boolean => {
    const absolutePath = resolveDestination(destinationRoot, relativePath);
    return [...sourceDestinations].some(
      (candidate) => candidate === absolutePath || candidate.startsWith(`${absolutePath}${path.sep}`),
    );
  };

  for (const record of manifest.directories) {
    if (!record.harnesses.every((harness) => harnesses.includes(harness))) continue;
    if (containsCurrentSource(record.path)) continue;
    await planOwnedContainerRemoval(
      record.id,
      "directory",
      record.harnesses,
      record.path,
      record.snapshotSha256,
      "directory",
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );
  }
  for (const record of manifest.dependencies) {
    if (!record.harnesses.every((harness) => harnesses.includes(harness))) continue;
    if (containsCurrentSource(record.path)) continue;
    await planOwnedContainerRemoval(
      record.id,
      "dependency",
      record.harnesses,
      record.path,
      record.treeSha256,
      "dependency",
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
    );
  }

  for (const record of manifest.insertedBlocks) {
    if (!harnesses.includes(record.harness)) continue;
    if (containsCurrentSource(record.path)) continue;
    const destinationPath = resolveDestination(destinationRoot, record.path);
    const snapshot = await readDestination(backend, destinationPath);
    const unchanged = snapshot.exists && snapshot.content?.includes(record.block);
    addFilePrecondition(
      destinationRoot,
      record.path,
      snapshot,
      unchanged ? "owned-unchanged" : snapshot.exists ? "owned-modified" : "owned-missing",
      record.blockSha256,
      manifest,
      destinationPreconditions,
      preconditionByPath,
    );
    if (!unchanged) {
      const message = snapshot.exists
        ? `Modified stale owned block retained during update: ${destinationPath}.`
        : `Stale owned block is missing and was not changed: ${destinationPath}.`;
      warnings.push({
        code: snapshot.exists ? "modified-owned-content" : "missing-owned-content",
        path: destinationPath,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: "inserted-block",
        harnesses: [record.harness],
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.blockSha256,
        semanticKey: record.marker,
        adapterKind: "inserted-block",
        warning: message,
      });
      continue;
    }
    rollbackInputs.push({
      type: "inserted-block",
      path: destinationPath,
      existed: true,
      sha256: snapshot.sha256,
      content: snapshot.content,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "inserted-block",
      harnesses: [record.harness],
      destinationPath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.blockSha256,
      semanticKey: record.marker,
      adapterKind: "inserted-block",
    });
  }

  const staleDisplacedKeys = new Set(
    manifest.displacedValues
      .filter((record) =>
        harnesses.includes(record.harness) &&
        !configTargets.some(
          (target) => target.harness === record.harness && target.path === record.path && target.key === record.key,
        ),
      )
      .map((record) => `${record.path}\u0000${record.key}`),
  );
  if (staleDisplacedKeys.size > 0) {
    await planDisplacedValues(
      manifest,
      harnesses,
      destinationRoot,
      backend,
      destinationPreconditions,
      preconditionByPath,
      ownedChanges,
      rollbackInputs,
      warnings,
      restoreData,
      staleDisplacedKeys,
    );
  }

  for (const record of manifest.configRegistrations) {
    if (!harnesses.includes(record.harness)) continue;
    if (configTargets.some((target) => target.harness === record.harness && target.path === record.path && target.key === record.key)) continue;
    if (staleDisplacedKeys.has(`${record.path}\u0000${record.key}`)) continue;
    const target: InstallConfigTarget = {
      harness: record.harness,
      path: record.path,
      key: record.key,
      format: record.harness === "codex" ? "toml" : "json",
      installedValue: record.installedValue,
    };
    const destinationPath = resolveDestination(destinationRoot, record.path);
    const snapshot = backend.readConfig
      ? await backend.readConfig(target, destinationPath)
      : readConfigSnapshot(target, destinationPath);
    const unchanged = snapshot.value !== undefined && hashOwnedValue(snapshot.value) === record.installedValueSha256;
    const ownershipState: PlannedOwnershipState = unchanged
      ? "owned-unchanged"
      : snapshot.exists
        ? "owned-modified"
        : "owned-missing";
    addConfigPrecondition(
      destinationRoot,
      record.path,
      snapshot,
      ownershipState,
      record.installedValueSha256,
      destinationPreconditions,
      preconditionByPath,
    );
    if (!unchanged) {
      const message = snapshot.exists
        ? `Modified stale owned configuration retained during update: ${destinationPath}#${record.key}.`
        : `Stale owned configuration is missing and was not changed: ${destinationPath}#${record.key}.`;
      warnings.push({
        code: snapshot.exists ? "modified-owned-content" : "missing-owned-content",
        path: destinationPath,
        message,
      });
      ownedChanges.push({
        id: record.id,
        artifactType: "config-registration",
        harnesses: [record.harness],
        destinationPath,
        destinationRelativePath: record.path,
        action: "preserve",
        sha256: record.installedValueSha256,
        semanticKey: record.key,
        adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
        ownershipState,
        preservationReason: snapshot.exists ? "modified" : "missing",
        warning: message,
      });
      continue;
    }
    if (snapshot.value === undefined) throw new InstallPreflightError([`Cannot safely remove stale configuration ${destinationPath}#${record.key}.`]);
    rollbackInputs.push({
      type: "config",
      path: destinationPath,
      key: record.key,
      existed: true,
      sha256: hashOwnedValue(snapshot.value),
      value: snapshot.value,
      content: snapshot.content,
    });
    ownedChanges.push({
      id: record.id,
      artifactType: "config-registration",
      harnesses: [record.harness],
      destinationPath,
      destinationRelativePath: record.path,
      action: "remove",
      sha256: record.installedValueSha256,
      semanticKey: record.key,
      adapterKind: record.harness === "codex" ? "codex-toml" : "claude-json",
      ownershipState,
    });
  }
}

async function inspectRequiredParentDirectories(
  changes: readonly PlannedOwnedChange[],
  destinationRoot: string,
  backend: InstallPreflightBackend,
): Promise<RequiredParentDirectory[]> {
  const harnessesByPath = new Map<string, Set<AgentKind>>();
  for (const change of changes) {
    if (change.action !== "create" || change.artifactType === "external-registration") continue;
    let relativePath = path.posix.dirname(change.destinationRelativePath);
    while (relativePath !== ".") {
      const harnesses = harnessesByPath.get(relativePath) ?? new Set<AgentKind>();
      for (const harness of change.harnesses) harnesses.add(harness);
      harnessesByPath.set(relativePath, harnesses);
      relativePath = path.posix.dirname(relativePath);
    }
  }

  const required: RequiredParentDirectory[] = [];
  for (const relativePath of [...harnessesByPath.keys()].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth || left.localeCompare(right);
  })) {
    const absolutePath = resolveDestination(destinationRoot, relativePath);
    const snapshot = await readDestination(backend, absolutePath);
    if (snapshot.exists) {
      if (snapshot.kind !== "directory") {
        throw new InstallPreflightError([
          `Required parent path is not a directory: ${absolutePath}.`,
        ]);
      }
      continue;
    }
    required.push({
      path: absolutePath,
      relativePath,
      harnesses: [...harnessesByPath.get(relativePath)!].sort(
        (left, right) => AGENT_KINDS.indexOf(left) - AGENT_KINDS.indexOf(right),
      ),
      exists: false,
    });
  }
  return required;
}

function addFilePrecondition(
  destinationRoot: string,
  relativePath: string,
  snapshot: DestinationSnapshot,
  state: PlannedOwnershipState,
  expectedSha256: string,
  manifest: OwnershipManifest | undefined,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
): DestinationPrecondition {
  const absolutePath = resolveDestination(destinationRoot, relativePath);
  const existing = preconditionByPath.get(absolutePath);
  if (existing) return existing;
  const record = manifest?.files.find((candidate) => candidate.path === relativePath);
  const precondition: DestinationPrecondition = {
    path: absolutePath,
    relativePath,
    exists: snapshot.exists,
    kind: snapshot.kind,
    sha256: snapshot.sha256,
    snapshotSha256: snapshot.snapshotSha256,
    treeSha256: snapshot.treeSha256,
    entries: snapshot.entries,
    ownership: state,
    expectedSha256: record?.sha256 ?? expectedSha256,
    priorContent: snapshot.content,
  };
  destinationPreconditions.push(precondition);
  preconditionByPath.set(absolutePath, precondition);
  return precondition;
}

function addConfigPrecondition(
  destinationRoot: string,
  relativePath: string,
  snapshot: InstallConfigSnapshot,
  state: PlannedOwnershipState,
  expectedSha256: string | undefined,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
): DestinationPrecondition {
  const absolutePath = resolveDestination(destinationRoot, relativePath);
  const key = `${absolutePath}#config`;
  const existing = preconditionByPath.get(key);
  if (existing) return existing;
  const precondition: DestinationPrecondition = {
    path: absolutePath,
    relativePath,
    exists: snapshot.exists,
    kind: "file",
    sha256: snapshot.sha256,
    snapshotSha256: snapshot.snapshotSha256,
    treeSha256: snapshot.treeSha256,
    entries: snapshot.entries,
    ownership: state,
    expectedSha256,
    priorContent: snapshot.content,
  };
  destinationPreconditions.push(precondition);
  preconditionByPath.set(key, precondition);
  return precondition;
}

function addExternalRegistrationPrecondition(
  destinationRoot: string,
  relativePath: string,
  snapshot: InstallExternalRegistrationSnapshot,
  state: PlannedOwnershipState,
  expectedSha256: string | undefined,
  destinationPreconditions: DestinationPrecondition[],
  preconditionByPath: Map<string, DestinationPrecondition>,
): DestinationPrecondition {
  const absolutePath = resolveDestination(destinationRoot, relativePath);
  const key = `${absolutePath}#external-registration`;
  const existing = preconditionByPath.get(key);
  if (existing) return existing;
  const precondition: DestinationPrecondition = {
    path: absolutePath,
    relativePath,
    exists: snapshot.exists,
    kind: "other",
    sha256: snapshot.value === undefined ? undefined : hashOwnedValue(snapshot.value),
    ownership: state,
    expectedSha256,
  };
  destinationPreconditions.push(precondition);
  preconditionByPath.set(key, precondition);
  return precondition;
}

function fileOwnershipState(
  manifest: OwnershipManifest | undefined,
  relativePath: string,
  snapshot: DestinationSnapshot,
): PlannedOwnershipState {
  if (!manifest) return "unrelated";
  const comparison = compareOwnership(manifest, {
    type: "file",
    path: relativePath,
    exists: snapshot.exists,
    sha256: snapshot.sha256,
  });
  return comparison.state;
}

async function readDestination(
  backend: InstallPreflightBackend,
  absolutePath: string,
): Promise<DestinationSnapshot> {
  if (backend.readDestination) return backend.readDestination(absolutePath);
  if (!existsSync(absolutePath)) return { exists: false };
  const info = lstatSync(absolutePath);
  if (info.isDirectory()) {
    const snapshot = readDirectorySnapshot(absolutePath);
    return {
      exists: true,
      kind: "directory",
      snapshotSha256: snapshot.sha256,
      treeSha256: snapshot.sha256,
      entries: snapshot.entries,
    };
  }
  if (!info.isFile()) return { exists: true, kind: "other" };
  const contentBytes = readFileSync(absolutePath);
  const content = contentBytes.toString("utf8");
  return {
    exists: true,
    kind: "file",
    sha256: createHash("sha256").update(contentBytes).digest("hex"),
    content,
  };
}

function readDirectorySnapshot(directoryPath: string): {
  sha256: string;
  entries: DirectorySnapshotEntry[];
} {
  const snapshot = snapshotFileSystemTree(directoryPath, { allowInternalLinks: true });
  return {
    sha256: snapshot.sha256,
    entries: snapshot.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      sha256: entry.sha256,
      linkTarget: entry.linkTarget,
    })),
  };
}

function readConfigSnapshot(
  target: InstallConfigTarget,
  absolutePath: string,
): InstallConfigSnapshot {
  if (!existsSync(absolutePath)) return { exists: false, parseable: true };
  const content = readFileSync(absolutePath, "utf8");
  try {
    if (target.format === "json") {
      const value = JSON.parse(content) as unknown;
      if (!isJsonValue(value)) throw new Error("JSON value is not supported");
      return {
        exists: true,
        parseable: true,
        value: selectConfigValue(value, target.key),
        content,
        sha256: createHash("sha256").update(content, "utf8").digest("hex"),
      };
    }
    const document = parseToml(content) as unknown;
    const selected = selectConfigValue(document, target.key);
    if (selected !== undefined && !isJsonValue(selected)) {
      throw new Error("unsupported TOML registration value");
    }
    return {
      exists: true,
      parseable: true,
      value: selected,
      content,
      sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    };
  } catch {
    return { exists: true, parseable: false, content };
  }
}

function selectConfigValue(value: unknown, key: string): JsonValue | undefined {
  let current: unknown = value;
  for (const segment of key.split(".")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
    if (current === undefined) return undefined;
  }
  return isJsonValue(current) ? current : undefined;
}

function normalizeDestinationPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  validateSafeRelativePath(normalized);
  return normalized;
}

function resolveDestination(root: string, relativePath: string): string {
  const normalized = normalizeDestinationPath(relativePath);
  validateSafeRelativePath(normalized, root);
  return path.resolve(root, ...normalized.split("/"));
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

async function requireCheck(
  label: string,
  check: () => boolean | void | Promise<boolean | void>,
  failures: string[],
): Promise<void> {
  try {
    if ((await check()) === false) failures.push(`${label} preflight failed.`);
  } catch (error) {
    failures.push(`${label} preflight failed: ${errorMessage(error)}`);
  }
}

function isSupportedNodeVersion(): boolean {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  return (
    major > 22 ||
    (major === 22 && (minor > 22 || (minor === 22 && patch >= 2)))
  );
}

function hasUsableLockfile(checkoutRoot: string): boolean {
  const lockfile = path.join(checkoutRoot, "package-lock.json");
  const dependencyRoot = path.join(checkoutRoot, "node_modules");
  if (!existsSync(lockfile) || !existsSync(dependencyRoot)) return false;
  if (!lstatSync(dependencyRoot).isDirectory()) return false;
  try {
    const value = JSON.parse(readFileSync(lockfile, "utf8")) as unknown;
    return (
      isJsonValue(value) &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof value.lockfileVersion === "number" &&
      value.lockfileVersion >= 1
    );
  } catch {
    return false;
  }
}

function probeExecutable(executable: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(executable, ["--version"], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code: number | null) => resolve(code === 0));
  });
}

async function probeIntegration(harness: AgentKind): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(process.env.HERDR_BIN_PATH || "herdr", ["integration", "status"], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { output += chunk; });
    child.once("error", () => resolve(false));
    child.once("close", (code: number | null) =>
      resolve(code === 0 && new RegExp(`^${harness}:\\s+current\\b`, "mi").test(output)),
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
