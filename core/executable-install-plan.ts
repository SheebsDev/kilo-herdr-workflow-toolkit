import { createHash } from "node:crypto";
import * as path from "node:path";

import type {
  DestinationPrecondition,
  InstallPlan,
  PlannedOwnedChange,
  RollbackInput,
} from "./install-plan.ts";
import { AGENT_KINDS, isAgentKind, isJsonValue } from "./model.ts";
import type { AgentKind, JsonValue } from "./model.ts";
import {
  OWNERSHIP_MANIFEST_FORMAT,
  OWNERSHIP_SCHEMA_VERSION,
  hashOwnedValue,
  validateOwnershipManifest,
  validateRestoreData,
  validateSafeRelativePath,
} from "./ownership-manifest.ts";
import type {
  ConfigRegistrationRecord,
  DisplacedValueRecord,
  InsertedBlockRecord,
  OwnedDependencyRecord,
  OwnedDirectoryRecord,
  OwnedFileRecord,
  OwnershipManifest,
  PayloadArtifactType,
  ResidualOwnershipRecord,
  RestoreData,
} from "./ownership-manifest.ts";

export const EXECUTABLE_INSTALL_PLAN_FORMAT =
  "kilo-herdr-engineering-workflow.executable-install-plan" as const;
export const EXECUTABLE_INSTALL_PLAN_VERSION = 1 as const;

const MUTATING_ACTIONS = new Set(["create", "replace", "remove", "restore"]);
const METADATA_KINDS = new Set(["restore-data", "ownership-manifest"]);

export interface ResourceTarget {
  readonly root: string;
  readonly relativePath: string;
}

export type ExactResourceState =
  | { readonly type: "absent" }
  | { readonly type: "file"; readonly sha256: string }
  | { readonly type: "directory" }
  | { readonly type: "directory-tree"; readonly sha256: string }
  | { readonly type: "dependency-tree"; readonly sha256: string };

export interface OpaqueSemanticPostimage {
  readonly semanticId: string;
  readonly harness: AgentKind;
  readonly key: string;
  readonly action: "set" | "remove" | "restore";
  readonly valueSha256?: string;
  readonly expectedValueSha256?: string;
}

export interface OpaqueResourcePostimage {
  readonly type: "opaque";
  readonly adapterKind: "claude-json" | "codex-toml" | "inserted-block";
  readonly semantics: readonly OpaqueSemanticPostimage[];
}

export type ResourcePostimage = ExactResourceState | OpaqueResourcePostimage;

export interface OwnershipEffect {
  readonly changeId: string;
  readonly action: "upsert" | "detach" | "retain" | "residual" | "not-adopted";
  readonly recordId?: string;
}

export type RollbackGuard =
  | { readonly type: "exact-postimage" }
  | { readonly type: "created-empty-directory" }
  | {
      readonly type: "adapter-proven-bounded-inverse";
      readonly semanticIds: readonly string[];
    };

interface TransitionBase {
  readonly id: string;
  readonly order: number;
  readonly target: ResourceTarget;
  readonly baseline: ExactResourceState;
  readonly desired: ResourcePostimage;
  readonly mutates: boolean;
  readonly dependsOn: readonly string[];
  readonly logicalChangeIds: readonly string[];
  readonly ownershipEffects: readonly OwnershipEffect[];
  readonly rollbackGuard: RollbackGuard;
}

export interface ParentDirectoryTransition extends TransitionBase {
  readonly kind: "parent-directory";
  readonly baseline: { readonly type: "absent" };
  readonly desired: { readonly type: "directory" };
  readonly stage: { readonly type: "none" };
}

export interface FileTransition extends TransitionBase {
  readonly kind: "file";
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly desired:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly stage:
    | { readonly type: "none" }
    | {
        readonly type: "source-file";
        readonly checkoutRoot: string;
        readonly sourcePath: string;
        readonly sha256: string;
      };
}

export interface DirectoryTreeTransition extends TransitionBase {
  readonly kind: "directory-tree";
  readonly baseline: { readonly type: "directory-tree"; readonly sha256: string };
  readonly desired: { readonly type: "absent" };
  readonly stage: { readonly type: "private-backup" };
}

export interface DependencyTreeTransition extends TransitionBase {
  readonly kind: "dependency-tree";
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "dependency-tree"; readonly sha256: string };
  readonly desired:
    | { readonly type: "absent" }
    | { readonly type: "dependency-tree"; readonly sha256: string };
  readonly stage:
    | { readonly type: "private-backup" }
    | {
        readonly type: "dependency-prepare";
        readonly packageManager: "npm";
        readonly packageNames: readonly string[];
        readonly lockfilePath?: string;
      };
}

export interface OpaqueAdapterChange {
  readonly semanticId: string;
  readonly harness: AgentKind;
  readonly key: string;
  readonly action: "set" | "remove" | "restore";
  readonly desiredValue?: JsonValue;
  readonly expectedValueSha256?: string;
}

export interface OpaqueRegistrationTransition extends TransitionBase {
  readonly kind: "opaque-registration";
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly desired: OpaqueResourcePostimage;
  readonly stage: {
    readonly type: "adapter-prepare";
    readonly adapterKind: OpaqueResourcePostimage["adapterKind"];
    readonly changes: readonly OpaqueAdapterChange[];
  };
}

export interface OwnershipManifestTransition extends TransitionBase {
  readonly kind: "ownership-manifest";
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly desired:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly stage:
    | { readonly type: "none" }
    | { readonly type: "generated-json"; readonly value: OwnershipManifest };
}

export interface RestoreDataTransition extends TransitionBase {
  readonly kind: "restore-data";
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly desired:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly stage:
    | { readonly type: "none" }
    | {
        readonly type: "private-generated-json";
        readonly value: RestoreData;
      };
}

export type InstallTransition =
  | ParentDirectoryTransition
  | FileTransition
  | DirectoryTreeTransition
  | DependencyTreeTransition
  | OpaqueRegistrationTransition
  | OwnershipManifestTransition
  | RestoreDataTransition;

export interface OwnershipProjection {
  readonly manifest: OwnershipManifest | null;
  readonly restoreData: RestoreData | null;
}

export interface ExecutableInstallPlan {
  readonly format: typeof EXECUTABLE_INSTALL_PLAN_FORMAT;
  readonly schemaVersion: typeof EXECUTABLE_INSTALL_PLAN_VERSION;
  readonly operation: InstallPlan["operation"];
  readonly scope: InstallPlan["scope"];
  readonly harnesses: readonly AgentKind[];
  readonly checkoutRoot: string;
  readonly destinationRoot: string;
  readonly resourceRoots: readonly string[];
  readonly projectedAt: string;
  readonly transitions: readonly InstallTransition[];
  readonly projection: OwnershipProjection;
  readonly metadataTransitions: {
    readonly restoreData: string;
    readonly ownershipManifest: string;
  };
  readonly warnings: InstallPlan["warnings"];
}

export interface MetadataResourceObservation {
  readonly target: ResourceTarget;
  readonly baseline:
    | { readonly type: "absent" }
    | { readonly type: "file"; readonly sha256: string };
  readonly requiredParentDirectories: readonly ResourceTarget[];
}

export interface OwnershipCompilationInput {
  readonly manifest?: OwnershipManifest;
  readonly restoreData?: RestoreData;
  readonly manifestResource: MetadataResourceObservation;
  readonly restoreDataResource: MetadataResourceObservation;
}

export interface CompileExecutableInstallPlanRequest {
  readonly preflightPlan: InstallPlan;
  readonly ownership: OwnershipCompilationInput;
  /** A caller-controlled transaction timestamp keeps projection deterministic. */
  readonly projectedAt: string;
}

export interface TransitionObservation {
  readonly transitionId: string;
  readonly state: ResourcePostimage;
  /**
   * Opaque adapters report only the planned semantic identities here. This
   * lets rollback prove a bounded inverse even when unrelated bytes in the
   * shared resource changed after apply.
   */
  readonly semantics?: readonly ObservedOpaqueSemanticState[];
}

export interface ObservedOpaqueSemanticState {
  readonly semanticId: string;
  readonly harness: AgentKind;
  readonly key: string;
  readonly state: "absent" | "value";
  readonly valueSha256?: string;
}

export interface PreparedTransition {
  readonly transitionId: string;
  readonly postimage: ResourcePostimage;
  readonly stagingHandle?: unknown;
  /** Private artifacts retained only when rollback reports residual state. */
  readonly recoveryArtifacts?: readonly string[];
}

export interface TransitionReceipt {
  readonly transitionId: string;
  readonly operation: "apply" | "rollback";
  readonly before: ResourcePostimage;
  readonly after: ResourcePostimage;
  /** Semantic state after the acknowledged operation. */
  readonly semantics?: readonly ObservedOpaqueSemanticState[];
}

export type PreparedTransitionDisposition =
  | "committed"
  | "rolled-back"
  | "residual";

export interface TransitionAdapterContext {
  readonly plan: ExecutableInstallPlan;
  readonly transition: InstallTransition;
}

/**
 * Mutation implementations inspect and prepare before apply. Rollback receives
 * its own signal so cancellation of forward work cannot cancel compensation.
 */
export interface InstallTransitionAdapter {
  inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation>;
  prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition>;
  apply(
    context: TransitionAdapterContext,
    prepared: PreparedTransition,
    signal: AbortSignal,
  ): Promise<TransitionReceipt>;
  rollback(
    context: TransitionAdapterContext,
    receipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt>;
  cleanup(
    context: TransitionAdapterContext,
    prepared: PreparedTransition | undefined,
    disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void>;
}

export function compileExecutableInstallPlan(
  request: CompileExecutableInstallPlanRequest,
): ExecutableInstallPlan {
  const preflight = request.preflightPlan;
  assertInstallPlanHeader(preflight);
  assertIsoTimestamp(request.projectedAt, "Projection timestamp");
  assertMetadataInput(preflight, request.ownership);

  const projectionResult = projectOwnership(
    preflight,
    request.ownership,
    request.projectedAt,
  );
  const transitions = compilePhysicalTransitions(
    preflight,
    request.ownership,
    projectionResult,
  );
  const resourceRoots = uniqueSorted([
    preflight.destinationRoot,
    request.ownership.manifestResource.target.root,
    request.ownership.restoreDataResource.target.root,
  ], compareNativePaths);
  const restoreTransition = transitions.find((transition) => transition.kind === "restore-data")!;
  const manifestTransition = transitions.find((transition) => transition.kind === "ownership-manifest")!;

  const plan: ExecutableInstallPlan = {
    format: EXECUTABLE_INSTALL_PLAN_FORMAT,
    schemaVersion: EXECUTABLE_INSTALL_PLAN_VERSION,
    operation: preflight.operation,
    scope: preflight.scope,
    harnesses: [...preflight.harnesses],
    checkoutRoot: preflight.checkoutRoot,
    destinationRoot: preflight.destinationRoot,
    resourceRoots,
    projectedAt: request.projectedAt,
    transitions,
    projection: {
      manifest: projectionResult.manifest,
      restoreData: projectionResult.restoreData,
    },
    metadataTransitions: {
      restoreData: restoreTransition.id,
      ownershipManifest: manifestTransition.id,
    },
    warnings: cloneJson(preflight.warnings),
  };

  const serializablePlan = cloneJson(plan);
  validateExecutableInstallPlan(serializablePlan);
  return deepFreeze(serializablePlan);
}

export function validateExecutableInstallPlan(value: unknown): ExecutableInstallPlan {
  if (!isRecord(value)) throw new Error("Executable install plan must be an object.");
  if (value.format !== EXECUTABLE_INSTALL_PLAN_FORMAT) {
    throw new Error("Executable install plan has an unsupported format.");
  }
  if (value.schemaVersion !== EXECUTABLE_INSTALL_PLAN_VERSION) {
    throw new Error(
      `Executable install plan schema version ${String(value.schemaVersion)} is unsupported.`,
    );
  }
  if (!isInstallOperation(value.operation) || !isInstallScope(value.scope)) {
    throw new Error("Executable install plan has an invalid operation or scope.");
  }
  assertAgentList(value.harnesses, "Executable install plan harnesses");
  assertCanonicalAbsolutePath(value.checkoutRoot, "Checkout root");
  assertCanonicalAbsolutePath(value.destinationRoot, "Destination root");
  assertIsoTimestamp(value.projectedAt, "Projection timestamp");
  if (!Array.isArray(value.resourceRoots) || value.resourceRoots.length === 0) {
    throw new Error("Executable install plan must declare resource roots.");
  }
  for (const root of value.resourceRoots) assertCanonicalAbsolutePath(root, "Resource root");
  assertUnique(value.resourceRoots.map(normalizeNativeIdentity), "resource roots");
  if (!value.resourceRoots.some((root) => sameNativePath(root, value.destinationRoot as string))) {
    throw new Error("Executable install plan destination root is not declared.");
  }
  if (!Array.isArray(value.transitions) || value.transitions.length < 2) {
    throw new Error("Executable install plan must contain metadata transitions.");
  }

  const transitions = value.transitions as unknown[];
  const transitionIds = new Set<string>();
  const targetIds = new Set<string>();
  const logicalIds = new Set<string>();
  for (const [index, candidate] of transitions.entries()) {
    validateTransition(
      candidate,
      index,
      value.resourceRoots as string[],
      value.checkoutRoot as string,
    );
    const transition = candidate as InstallTransition;
    assertOutsideWorkflowHistory(transition.target, value.destinationRoot as string);
    if (
      !METADATA_KINDS.has(transition.kind) && transition.kind !== "parent-directory" &&
      !isTargetInsideRoot(transition.target, value.destinationRoot as string)
    ) {
      throw new Error(`Transition "${transition.id}" targets outside the destination root.`);
    }
    if (transitionIds.has(transition.id)) {
      throw new Error(`Executable install plan contains duplicate transition ID "${transition.id}".`);
    }
    transitionIds.add(transition.id);
    const targetId = targetIdentity(transition.target);
    if (targetIds.has(targetId)) {
      throw new Error(`Executable install plan contains a target collision at ${formatTarget(transition.target)}.`);
    }
    targetIds.add(targetId);
    for (const logicalId of transition.logicalChangeIds) {
      if (logicalIds.has(logicalId)) {
        throw new Error(`Logical change "${logicalId}" is assigned to multiple transitions.`);
      }
      logicalIds.add(logicalId);
    }
  }

  for (const candidate of transitions) {
    const transition = candidate as InstallTransition;
    for (const dependency of transition.dependsOn) {
      if (!transitionIds.has(dependency)) {
        throw new Error(`Transition "${transition.id}" references missing transition "${dependency}".`);
      }
      const dependencyOrder = (transitions as InstallTransition[]).find(
        (entry) => entry.id === dependency,
      )!.order;
      if (dependencyOrder >= transition.order) {
        throw new Error(`Transition "${transition.id}" has invalid dependency ordering.`);
      }
    }
  }

  validateTargetOverlaps(transitions as InstallTransition[]);
  validateMetadataProjection(value, transitions as InstallTransition[]);
  validateOwnershipEffectProjection(value, transitions as InstallTransition[]);
  if (!Array.isArray(value.warnings)) throw new Error("Executable install plan warnings must be an array.");
  for (const warning of value.warnings) validateInstallWarning(warning);
  return value as unknown as ExecutableInstallPlan;
}

interface ProjectionResult {
  manifest: OwnershipManifest | null;
  restoreData: RestoreData | null;
  effects: Map<string, OwnershipEffect>;
}

function projectOwnership(
  preflight: InstallPlan,
  ownership: OwnershipCompilationInput,
  projectedAt: string,
): ProjectionResult {
  const baseline = ownership.manifest
    ? cloneJson(validateOwnershipManifest(ownership.manifest))
    : undefined;
  const restoreBaseline = ownership.restoreData
    ? cloneJson(validateRestoreData(ownership.restoreData))
    : undefined;
  const files = baseline?.files ?? [];
  const directories = baseline?.directories ?? [];
  const dependencies = baseline?.dependencies ?? [];
  const registrations = baseline?.configRegistrations ?? [];
  const blocks = baseline?.insertedBlocks ?? [];
  const displaced = baseline?.displacedValues ?? [];
  const residuals = baseline?.residualOwnership ?? [];
  const restoreEntries: Record<string, JsonValue> = cloneJson(restoreBaseline?.entries ?? {});
  const effects = new Map<string, OwnershipEffect>();

  assertUnique(preflight.ownedChanges.map((change) => change.id), "logical change IDs");
  for (const change of preflight.ownedChanges) {
    assertPlannedChange(change, preflight);
    const precondition = findPrecondition(preflight, change);
    if (isPayloadArtifact(change.artifactType)) {
      projectFileChange(
        change,
        precondition,
        preflight,
        files,
        residuals,
        effects,
        projectedAt,
      );
      continue;
    }
    if (change.artifactType === "directory") {
      projectDirectoryChange(
        change,
        precondition,
        preflight,
        directories,
        residuals,
        effects,
        projectedAt,
      );
      continue;
    }
    if (change.artifactType === "dependency") {
      projectDependencyChange(
        change,
        precondition,
        preflight,
        dependencies,
        residuals,
        effects,
        projectedAt,
      );
      continue;
    }
    if (change.artifactType === "config-registration") {
      projectRegistrationChange(
        change,
        precondition,
        preflight,
        registrations,
        displaced,
        residuals,
        restoreEntries,
        effects,
        projectedAt,
      );
      continue;
    }
    projectBlockChange(
      change,
      precondition,
      preflight,
      blocks,
      residuals,
      effects,
      projectedAt,
    );
  }

  const referencedRestoreIds = new Set(displaced.map((record) => record.restoreDataId));
  for (const id of Object.keys(restoreEntries)) {
    if (!referencedRestoreIds.has(id)) delete restoreEntries[id];
  }
  sortRecords(files);
  sortRecords(directories);
  sortRecords(dependencies);
  sortRecords(registrations);
  sortRecords(blocks);
  sortRecords(displaced);
  sortRecords(residuals);

  const hasState =
    files.length + directories.length + dependencies.length + registrations.length +
      blocks.length + displaced.length + residuals.length >
    0;
  if (!hasState) return { manifest: null, restoreData: null, effects };

  const recordHarnesses = new Set<AgentKind>();
  for (const record of [...files, ...directories, ...dependencies]) {
    for (const harness of record.harnesses) recordHarnesses.add(harness);
  }
  for (const record of [...registrations, ...blocks, ...displaced]) {
    recordHarnesses.add(record.harness);
  }
  if (recordHarnesses.size === 0) {
    for (const harness of baseline?.harnesses ?? preflight.harnesses) recordHarnesses.add(harness);
  }
  const harnesses = AGENT_KINDS.filter((harness) => recordHarnesses.has(harness));
  const manifestId = baseline?.manifestId ??
    `manifest-${hashText(`${preflight.scope}\0${preflight.destinationRoot}`).slice(0, 32)}`;
  const createdAt = baseline?.createdAt ?? projectedAt;
  let manifest: OwnershipManifest = {
    format: OWNERSHIP_MANIFEST_FORMAT,
    schemaVersion: OWNERSHIP_SCHEMA_VERSION,
    manifestId,
    scope: preflight.scope,
    harnesses,
    createdAt,
    updatedAt: projectedAt,
    files,
    directories,
    dependencies,
    configRegistrations: registrations,
    insertedBlocks: blocks,
    displacedValues: displaced,
    residualOwnership: residuals,
  };
  manifest = validateOwnershipManifest(manifest);
  if (baseline && equalIgnoringUpdatedAt(manifest, baseline)) manifest = baseline;

  let restoreData: RestoreData | null = Object.keys(restoreEntries).length === 0
    ? null
    : validateRestoreData({
        format: "kilo-herdr-engineering-workflow.restore-data",
        schemaVersion: OWNERSHIP_SCHEMA_VERSION,
        entries: sortObject(restoreEntries),
      });
  if (restoreData && restoreBaseline && deepEqual(restoreData, restoreBaseline)) {
    restoreData = restoreBaseline;
  }
  return { manifest, restoreData, effects };
}

function projectFileChange(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  records: OwnedFileRecord[],
  residuals: ResidualOwnershipRecord[],
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
): void {
  const index = records.findIndex((record) => record.path === change.destinationRelativePath);
  const existing = records[index];
  if (change.action === "unchanged" && !existing) {
    effects.set(change.id, { changeId: change.id, action: "not-adopted" });
    return;
  }
  if ((change.action === "create" || change.action === "replace") && !change.sha256) {
    throw new Error(`File change "${change.id}" has no desired hash.`);
  }
  if (change.action === "replace" && !existing && precondition.ownership === "unrelated") {
    throw new Error(
      `Unowned payload ${change.destinationRelativePath} cannot be replaced without a private displaced-resource contract.`,
    );
  }
  if (["create", "replace", "unchanged"].includes(change.action)) {
    const record: OwnedFileRecord = {
      id: existing?.id ?? change.id,
      artifactType: change.artifactType as PayloadArtifactType,
      harnesses: mergeHarnesses(existing?.harnesses ?? [], change.harnesses),
      path: change.destinationRelativePath,
      sha256: change.sha256!,
    };
    replaceAt(records, index, record);
    effects.set(change.id, { changeId: change.id, action: "upsert", recordId: record.id });
    return;
  }
  projectRemovalOrPreservation(
    change,
    precondition,
    preflight,
    existing,
    index,
    records,
    residuals,
    effects,
    projectedAt,
    "file",
  );
}

function projectDirectoryChange(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  records: OwnedDirectoryRecord[],
  residuals: ResidualOwnershipRecord[],
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
): void {
  const index = records.findIndex((record) => record.path === change.destinationRelativePath);
  const existing = records[index];
  if (["create", "replace"].includes(change.action)) {
    throw new Error("Directory-tree creation belongs to a prepared directory adapter plan.");
  }
  projectRemovalOrPreservation(
    change,
    precondition,
    preflight,
    existing,
    index,
    records,
    residuals,
    effects,
    projectedAt,
    "directory",
  );
}

function projectDependencyChange(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  records: OwnedDependencyRecord[],
  residuals: ResidualOwnershipRecord[],
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
): void {
  const index = records.findIndex((record) => record.path === change.destinationRelativePath);
  const existing = records[index];
  if (["create", "replace"].includes(change.action)) {
    const input = requireDependencyInput(change);
    const record: OwnedDependencyRecord = {
      id: existing?.id ?? change.id,
      harnesses: mergeHarnesses(existing?.harnesses ?? [], change.harnesses),
      path: change.destinationRelativePath,
      packageManager: input.packageManager,
      packageNames: [...input.packageNames],
      lockfilePath: input.lockfilePath,
      treeSha256: requireSha256(change.sha256, `Dependency change "${change.id}"`),
    };
    replaceAt(records, index, record);
    effects.set(change.id, { changeId: change.id, action: "upsert", recordId: record.id });
    return;
  }
  projectRemovalOrPreservation(
    change,
    precondition,
    preflight,
    existing,
    index,
    records,
    residuals,
    effects,
    projectedAt,
    "dependency",
  );
}

function projectRegistrationChange(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  records: ConfigRegistrationRecord[],
  displaced: DisplacedValueRecord[],
  residuals: ResidualOwnershipRecord[],
  restoreEntries: Record<string, JsonValue>,
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
): void {
  const key = requireSemanticKey(change);
  const harness = requireSingleHarness(change);
  const index = records.findIndex(
    (record) => record.path === change.destinationRelativePath && record.key === key,
  );
  const existing = records[index];
  const displacedIndex = displaced.findIndex(
    (record) => record.path === change.destinationRelativePath && record.key === key,
  );
  const existingDisplaced = displaced[displacedIndex];
  if (change.action === "unchanged" && !existing) {
    effects.set(change.id, { changeId: change.id, action: "not-adopted" });
    return;
  }
  if (["create", "replace"].includes(change.action)) {
    if (change.desiredValue === undefined) {
      throw new Error(`Registration change "${change.id}" has no desired value.`);
    }
    const installedValueSha256 = hashOwnedValue(change.desiredValue);
    const record: ConfigRegistrationRecord = {
      id: existing?.id ?? change.id,
      harness,
      path: change.destinationRelativePath,
      key,
      installedValue: cloneJson(change.desiredValue),
      installedValueSha256,
    };
    replaceAt(records, index, record);
    if (change.action === "replace" && !existing && change.ownershipState === "unrelated") {
      const prior = findConfigRollback(preflight.rollbackInputs, change, key);
      if (prior?.value === undefined) {
        throw new Error(`Forced registration "${change.id}" has no exact displaced value.`);
      }
      const restoreDataId = `${change.id}-restore`;
      const displacedRecord: DisplacedValueRecord = {
        id: `${change.id}-displaced`,
        harness,
        path: change.destinationRelativePath,
        key,
        restoreDataId,
        originalValueSha256: hashOwnedValue(prior.value),
        installedValueSha256,
        valueKind: typeof prior.value === "string" ? "text" : "json",
        secret: true,
      };
      replaceAt(displaced, displacedIndex, displacedRecord);
      restoreEntries[restoreDataId] = cloneJson(prior.value);
    } else if (existingDisplaced) {
      displaced[displacedIndex] = {
        ...existingDisplaced,
        installedValueSha256,
      };
    }
    effects.set(change.id, { changeId: change.id, action: "upsert", recordId: record.id });
    return;
  }
  if (change.action === "restore" || change.action === "remove") {
    if (index >= 0) records.splice(index, 1);
    removeDisplacedAt(displaced, displacedIndex, restoreEntries);
    effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing?.id });
    return;
  }
  if (preflight.operation !== "uninstall" || !existing) {
    effects.set(change.id, { changeId: change.id, action: "retain", recordId: existing?.id });
    return;
  }
  records.splice(index, 1);
  removeDisplacedAt(displaced, displacedIndex, restoreEntries);
  if (
    precondition.exists &&
    (change.ownershipState === "owned-modified" || change.preservationReason === "missing-restore-data")
  ) {
    upsertResidual(
      residuals,
      existing.id,
      "config-registration",
      existing.path,
      change.preservationReason === "missing-restore-data" ? "missing-restore-data" : "modified",
      change.sha256,
      precondition.sha256,
      projectedAt,
    );
    effects.set(change.id, { changeId: change.id, action: "residual", recordId: existing.id });
  } else {
    effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing.id });
  }
}

function projectBlockChange(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  records: InsertedBlockRecord[],
  residuals: ResidualOwnershipRecord[],
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
): void {
  const marker = requireSemanticKey(change);
  const index = records.findIndex(
    (record) => record.path === change.destinationRelativePath && record.marker === marker,
  );
  const existing = records[index];
  if (["create", "replace"].includes(change.action)) {
    if (typeof change.desiredValue !== "string") {
      throw new Error(`Inserted block "${change.id}" has no exact desired text.`);
    }
    const record: InsertedBlockRecord = {
      id: existing?.id ?? change.id,
      harness: requireSingleHarness(change),
      path: change.destinationRelativePath,
      marker,
      block: change.desiredValue,
      blockSha256: hashOwnedValue(change.desiredValue),
    };
    replaceAt(records, index, record);
    effects.set(change.id, { changeId: change.id, action: "upsert", recordId: record.id });
    return;
  }
  if (change.action === "remove") {
    if (index >= 0) records.splice(index, 1);
    effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing?.id });
    return;
  }
  if (preflight.operation === "uninstall" && existing) {
    records.splice(index, 1);
    if (precondition.exists && precondition.ownership === "owned-modified") {
      upsertResidual(
        residuals,
        existing.id,
        "inserted-block",
        existing.path,
        "modified",
        change.sha256,
        precondition.sha256,
        projectedAt,
      );
      effects.set(change.id, { changeId: change.id, action: "residual", recordId: existing.id });
    } else {
      effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing.id });
    }
    return;
  }
  effects.set(change.id, { changeId: change.id, action: "retain", recordId: existing?.id });
}

function projectRemovalOrPreservation<
  T extends OwnedFileRecord | OwnedDirectoryRecord | OwnedDependencyRecord,
>(
  change: PlannedOwnedChange,
  precondition: DestinationPrecondition,
  preflight: InstallPlan,
  existing: T | undefined,
  index: number,
  records: T[],
  residuals: ResidualOwnershipRecord[],
  effects: Map<string, OwnershipEffect>,
  projectedAt: string,
  artifactType: "file" | "directory" | "dependency",
): void {
  if (!existing) {
    effects.set(change.id, { changeId: change.id, action: "not-adopted" });
    return;
  }
  if (change.action === "remove") {
    const remaining = detachSelectedHarnesses(existing.harnesses, preflight.harnesses);
    if (remaining.length === 0) records.splice(index, 1);
    else records[index] = { ...existing, harnesses: remaining };
    effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing.id });
    return;
  }
  if (preflight.operation !== "uninstall") {
    effects.set(change.id, { changeId: change.id, action: "retain", recordId: existing.id });
    return;
  }
  const remaining = detachSelectedHarnesses(existing.harnesses, preflight.harnesses);
  if (remaining.length === 0) records.splice(index, 1);
  else records[index] = { ...existing, harnesses: remaining };
  if (precondition.exists && precondition.ownership === "owned-modified") {
    upsertResidual(
      residuals,
      existing.id,
      artifactType,
      existing.path,
      "modified",
      change.sha256,
      observedHash(precondition, artifactType),
      projectedAt,
    );
    effects.set(change.id, { changeId: change.id, action: "residual", recordId: existing.id });
  } else {
    effects.set(change.id, { changeId: change.id, action: "detach", recordId: existing.id });
  }
}

function compilePhysicalTransitions(
  preflight: InstallPlan,
  ownership: OwnershipCompilationInput,
  projection: ProjectionResult,
): InstallTransition[] {
  const drafts: Array<Omit<InstallTransition, "order">> = [];
  const parentTargets = [
    ...(preflight.requiredParentDirectories ?? []).map((parent) =>
      targetWithin(preflight.destinationRoot, parent.relativePath)
    ),
    ...(projection.manifest
      ? ownership.manifestResource.requiredParentDirectories.map(normalizeTarget)
      : []),
    ...(projection.restoreData
      ? ownership.restoreDataResource.requiredParentDirectories.map(normalizeTarget)
      : []),
  ];
  const uniqueParents = new Map(parentTargets.map((target) => [targetIdentity(target), target]));
  for (const target of [...uniqueParents.values()].sort(compareTargetsByDepth)) {
    drafts.push({
      id: transitionId("parent-directory", target),
      kind: "parent-directory",
      target,
      baseline: { type: "absent" },
      desired: { type: "directory" },
      mutates: true,
      dependsOn: parentDependencies(target, drafts),
      logicalChangeIds: [],
      ownershipEffects: [],
      rollbackGuard: { type: "created-empty-directory" },
      stage: { type: "none" },
    } as Omit<ParentDirectoryTransition, "order">);
  }

  const mutating = preflight.ownedChanges.filter((change) => MUTATING_ACTIONS.has(change.action));
  const containerChanges = mutating
    .filter(
      (change) =>
        (change.artifactType === "directory" || change.artifactType === "dependency") &&
        change.action === "remove",
    )
    .sort((left, right) =>
      left.destinationRelativePath.split("/").length - right.destinationRelativePath.split("/").length ||
      left.destinationRelativePath.localeCompare(right.destinationRelativePath),
    );
  const outerContainers: PlannedOwnedChange[] = [];
  for (const change of containerChanges) {
    if (!outerContainers.some((outer) => isStrictRelativeAncestor(outer.destinationRelativePath, change.destinationRelativePath))) {
      outerContainers.push(change);
    }
  }
  const absorbed = new Set<string>();
  for (const container of outerContainers) {
    const nested = preflight.ownedChanges.filter(
      (change) =>
        change.id === container.id ||
        isStrictRelativeAncestor(container.destinationRelativePath, change.destinationRelativePath),
    );
    if (nested.some((change) => change.action !== "remove")) {
      throw new Error(`Removing ${container.destinationRelativePath} overlaps a non-removal transition.`);
    }
    assertNoRetainedProjectionUnder(container.destinationRelativePath, projection.manifest);
    for (const change of nested) absorbed.add(change.id);
    const precondition = findPrecondition(preflight, container);
    const isDependency = container.artifactType === "dependency";
    const sha256 = isDependency ? precondition.treeSha256 : precondition.snapshotSha256;
    if (!sha256) throw new Error(`Container "${container.id}" has no exact baseline fingerprint.`);
    const target = targetWithin(preflight.destinationRoot, container.destinationRelativePath);
    drafts.push({
      id: transitionId(isDependency ? "dependency-tree" : "directory-tree", target),
      kind: isDependency ? "dependency-tree" : "directory-tree",
      target,
      baseline: { type: isDependency ? "dependency-tree" : "directory-tree", sha256 },
      desired: { type: "absent" },
      mutates: true,
      dependsOn: [],
      logicalChangeIds: nested.map((change) => change.id).sort(),
      ownershipEffects: effectsFor(nested, projection.effects),
      rollbackGuard: { type: "exact-postimage" },
      stage: { type: "private-backup" },
    } as Omit<DirectoryTreeTransition | DependencyTreeTransition, "order">);
  }

  for (const change of mutating) {
    if (change.artifactType === "directory" && change.action !== "remove") {
      throw new Error(`Directory-tree transition "${change.id}" has unsupported action ${change.action}.`);
    }
    if (
      absorbed.has(change.id) || change.artifactType !== "dependency" ||
      (change.action !== "create" && change.action !== "replace")
    ) {
      continue;
    }
    const input = requireDependencyInput(change);
    const target = targetWithin(preflight.destinationRoot, change.destinationRelativePath);
    const precondition = findPrecondition(preflight, change);
    const baseline = dependencyBaseline(precondition, change.id);
    const desired = {
      type: "dependency-tree" as const,
      sha256: requireSha256(change.sha256, `Dependency change "${change.id}"`),
    };
    drafts.push({
      id: transitionId("dependency-tree", target),
      kind: "dependency-tree",
      target,
      baseline,
      desired,
      mutates: !resourceStatesEqual(baseline, desired),
      dependsOn: parentDependencies(target, drafts),
      logicalChangeIds: [change.id],
      ownershipEffects: effectsFor([change], projection.effects),
      rollbackGuard: { type: "exact-postimage" },
      stage: {
        type: "dependency-prepare",
        packageManager: input.packageManager,
        packageNames: [...input.packageNames],
        lockfilePath: input.lockfilePath,
      },
    } as Omit<DependencyTreeTransition, "order">);
  }

  for (const change of mutating) {
    if (absorbed.has(change.id) || !isPayloadArtifact(change.artifactType)) continue;
    const target = targetWithin(preflight.destinationRoot, change.destinationRelativePath);
    const precondition = findPrecondition(preflight, change);
    const baseline = fileBaseline(precondition, change.id);
    const desired = change.action === "remove"
      ? { type: "absent" as const }
      : { type: "file" as const, sha256: requireSha256(change.sha256, `File change "${change.id}"`) };
    if (desired.type === "absent") {
      assertNoRetainedProjectionUnder(change.destinationRelativePath, projection.manifest);
    }
    const source = preflight.sourceInventory.find(
      (entry) => entry.destinationRelativePath === change.destinationRelativePath,
    );
    if (desired.type === "file" && (!source || source.sha256 !== desired.sha256)) {
      throw new Error(`File change "${change.id}" has no matching staged source.`);
    }
    drafts.push({
      id: transitionId("file", target),
      kind: "file",
      target,
      baseline,
      desired,
      mutates: !resourceStatesEqual(baseline, desired),
      dependsOn: parentDependencies(target, drafts),
      logicalChangeIds: [change.id],
      ownershipEffects: effectsFor([change], projection.effects),
      rollbackGuard: { type: "exact-postimage" },
      stage: desired.type === "file"
        ? {
            type: "source-file",
            checkoutRoot: preflight.checkoutRoot,
            sourcePath: source!.sourcePath,
            sha256: desired.sha256,
          }
        : { type: "none" },
    } as Omit<FileTransition, "order">);
  }

  const opaqueGroups = new Map<string, PlannedOwnedChange[]>();
  for (const change of mutating) {
    if (absorbed.has(change.id) || (change.artifactType !== "config-registration" && change.artifactType !== "inserted-block")) continue;
    const adapterKind = requireAdapterKind(change);
    const key = `${normalizeNativeIdentity(change.destinationPath)}\0${adapterKind}`;
    const conflicting = [...opaqueGroups.keys()].find(
      (candidate) => candidate.split("\0")[0] === normalizeNativeIdentity(change.destinationPath) && candidate !== key,
    );
    if (conflicting) {
      throw new Error(`Physical resource ${change.destinationPath} requires conflicting opaque adapters.`);
    }
    const group = opaqueGroups.get(key) ?? [];
    group.push(change);
    opaqueGroups.set(key, group);
  }
  for (const changes of [...opaqueGroups.values()].sort((left, right) =>
    left[0].destinationRelativePath.localeCompare(right[0].destinationRelativePath),
  )) {
    const first = changes[0];
    const target = targetWithin(preflight.destinationRoot, first.destinationRelativePath);
    const precondition = findPrecondition(preflight, first);
    const baseline = fileBaseline(precondition, first.id);
    const adapterKind = requireAdapterKind(first);
    const adapterChanges = changes.map((change) =>
      toOpaqueAdapterChange(change, preflight.rollbackInputs)
    ).sort((left, right) =>
      `${left.key}\0${left.semanticId}`.localeCompare(`${right.key}\0${right.semanticId}`),
    );
    const semantics = adapterChanges.map((change) => ({
      semanticId: change.semanticId,
      harness: change.harness,
      key: change.key,
      action: change.action,
      valueSha256: change.desiredValue === undefined ? undefined : hashOwnedValue(change.desiredValue),
      expectedValueSha256: change.expectedValueSha256,
    }));
    drafts.push({
      id: transitionId("opaque-registration", target),
      kind: "opaque-registration",
      target,
      baseline,
      desired: { type: "opaque", adapterKind, semantics },
      mutates: true,
      dependsOn: parentDependencies(target, drafts),
      logicalChangeIds: changes.map((change) => change.id).sort(),
      ownershipEffects: effectsFor(changes, projection.effects),
      rollbackGuard: {
        type: "adapter-proven-bounded-inverse",
        semanticIds: semantics.map((semantic) => semantic.semanticId),
      },
      stage: { type: "adapter-prepare", adapterKind, changes: adapterChanges },
    } as Omit<OpaqueRegistrationTransition, "order">);
  }

  const physicalIds = drafts.filter((draft) => draft.mutates).map((draft) => draft.id);
  const restoreTarget = normalizeTarget(ownership.restoreDataResource.target);
  const restoreDesired = projection.restoreData
    ? { type: "file" as const, sha256: hashSerializedJson(projection.restoreData) }
    : { type: "absent" as const };
  const restoreId = transitionId("restore-data", restoreTarget);
  drafts.push({
    id: restoreId,
    kind: "restore-data",
    target: restoreTarget,
    baseline: cloneJson(ownership.restoreDataResource.baseline),
    desired: restoreDesired,
    mutates: !resourceStatesEqual(ownership.restoreDataResource.baseline, restoreDesired),
    dependsOn: [...physicalIds],
    logicalChangeIds: [],
    ownershipEffects: [],
    rollbackGuard: { type: "exact-postimage" },
    stage: projection.restoreData
      ? { type: "private-generated-json", value: projection.restoreData }
      : { type: "none" },
  } as Omit<RestoreDataTransition, "order">);

  const manifestTarget = normalizeTarget(ownership.manifestResource.target);
  const manifestDesired = projection.manifest
    ? { type: "file" as const, sha256: hashSerializedJson(projection.manifest) }
    : { type: "absent" as const };
  drafts.push({
    id: transitionId("ownership-manifest", manifestTarget),
    kind: "ownership-manifest",
    target: manifestTarget,
    baseline: cloneJson(ownership.manifestResource.baseline),
    desired: manifestDesired,
    mutates: !resourceStatesEqual(ownership.manifestResource.baseline, manifestDesired),
    dependsOn: uniqueSorted([...physicalIds, restoreId]),
    logicalChangeIds: [],
    ownershipEffects: [],
    rollbackGuard: { type: "exact-postimage" },
    stage: projection.manifest
      ? { type: "generated-json", value: projection.manifest }
      : { type: "none" },
  } as Omit<OwnershipManifestTransition, "order">);

  return drafts.map((draft, order) => ({ ...draft, order } as InstallTransition));
}

function validateTransition(
  value: unknown,
  expectedOrder: number,
  resourceRoots: readonly string[],
  checkoutRoot: string,
): void {
  if (!isRecord(value)) throw new Error("Install transition must be an object.");
  if (!isSafeId(value.id)) throw new Error("Install transition has an invalid ID.");
  if (value.order !== expectedOrder) throw new Error(`Transition "${String(value.id)}" has invalid order.`);
  if (!isTransitionKind(value.kind)) throw new Error(`Transition "${String(value.id)}" has an invalid kind.`);
  validateTarget(value.target, resourceRoots);
  validateExactState(value.baseline, "baseline");
  validatePostimage(value.desired);
  if (typeof value.mutates !== "boolean") throw new Error(`Transition "${value.id}" has invalid mutation state.`);
  assertStringArray(value.dependsOn, `Transition "${value.id}" dependencies`, true);
  assertStringArray(value.logicalChangeIds, `Transition "${value.id}" logical changes`, true);
  assertUnique(value.dependsOn as string[], `transition "${value.id}" dependencies`);
  assertUnique(value.logicalChangeIds as string[], `transition "${value.id}" logical changes`);
  if (!Array.isArray(value.ownershipEffects)) throw new Error(`Transition "${value.id}" has invalid ownership effects.`);
  const effectIds: string[] = [];
  for (const effect of value.ownershipEffects) {
    validateOwnershipEffect(effect);
    effectIds.push((effect as OwnershipEffect).changeId);
  }
  assertUnique(effectIds, `transition "${value.id}" ownership effects`);
  if (
    effectIds.length !== (value.logicalChangeIds as string[]).length ||
    effectIds.some((id) => !(value.logicalChangeIds as string[]).includes(id))
  ) {
    throw new Error(`Transition "${value.id}" ownership effects do not match its logical changes.`);
  }
  validateRollbackGuard(value.rollbackGuard);
  validateTransitionVariant(value as unknown as InstallTransition, checkoutRoot);
}

function validateTransitionVariant(
  transition: InstallTransition,
  checkoutRoot: string,
): void {
  if (transition.kind === "parent-directory") {
    if (transition.baseline.type !== "absent" || transition.desired.type !== "directory" || transition.stage.type !== "none") {
      throw new Error(`Parent transition "${transition.id}" has an invalid state.`);
    }
    if (!transition.mutates) throw new Error(`Parent transition "${transition.id}" must mutate.`);
    if (
      transition.logicalChangeIds.length !== 0 || transition.ownershipEffects.length !== 0 ||
      transition.rollbackGuard.type !== "created-empty-directory"
    ) {
      throw new Error(`Parent transition "${transition.id}" has an invalid ownership or rollback contract.`);
    }
    return;
  }
  if (transition.kind === "file") {
    if (!isAbsentOrFile(transition.baseline) || !isAbsentOrFile(transition.desired)) {
      throw new Error(`File transition "${transition.id}" has an invalid state.`);
    }
    if (transition.desired.type === "file") {
      if (transition.stage.type !== "source-file" || transition.stage.sha256 !== transition.desired.sha256) {
        throw new Error(`File transition "${transition.id}" has invalid staging input.`);
      }
      assertCanonicalAbsolutePath(transition.stage.checkoutRoot, "Staging checkout root");
      if (!sameNativePath(transition.stage.checkoutRoot, checkoutRoot)) {
        throw new Error(`File transition "${transition.id}" stages outside the plan checkout root.`);
      }
      validateSafeRelativePath(transition.stage.sourcePath);
    } else if (transition.stage.type !== "none") {
      throw new Error(`File removal "${transition.id}" must not stage a source file.`);
    }
    if (transition.mutates === resourceStatesEqual(transition.baseline, transition.desired)) {
      throw new Error(`File transition "${transition.id}" has an inconsistent mutation flag.`);
    }
    if (transition.logicalChangeIds.length === 0 || transition.rollbackGuard.type !== "exact-postimage") {
      throw new Error(`File transition "${transition.id}" has an invalid ownership or rollback contract.`);
    }
    assertEffectActions(
      transition,
      transition.desired.type === "absent" ? "detach" : "upsert",
    );
    return;
  }
  if (transition.kind === "directory-tree") {
    if (transition.baseline.type !== "directory-tree" || transition.desired.type !== "absent" || transition.stage.type !== "private-backup") {
      throw new Error(`Directory-tree transition "${transition.id}" has an invalid state.`);
    }
    if (!transition.mutates) throw new Error(`Directory-tree transition "${transition.id}" must mutate.`);
    if (transition.logicalChangeIds.length === 0 || transition.rollbackGuard.type !== "exact-postimage") {
      throw new Error(`Directory-tree transition "${transition.id}" has an invalid ownership or rollback contract.`);
    }
    assertEffectActions(transition, "detach");
    return;
  }
  if (transition.kind === "dependency-tree") {
    if (
      !isAbsentOrDependencyTree(transition.baseline) ||
      !isAbsentOrDependencyTree(transition.desired)
    ) {
      throw new Error(`Dependency-tree transition "${transition.id}" has an invalid state.`);
    }
    if (transition.desired.type === "absent") {
      if (transition.baseline.type !== "dependency-tree" || transition.stage.type !== "private-backup") {
        throw new Error(`Dependency-tree removal "${transition.id}" has invalid staging.`);
      }
    } else {
      if (
        transition.stage.type !== "dependency-prepare" ||
        transition.stage.packageManager !== "npm" ||
        !Array.isArray(transition.stage.packageNames) ||
        transition.stage.packageNames.length === 0 ||
        !transition.stage.packageNames.every(
          (name) =>
            typeof name === "string" &&
            /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name),
        ) || new Set(transition.stage.packageNames).size !== transition.stage.packageNames.length
      ) {
        throw new Error(`Dependency-tree transition "${transition.id}" has invalid package policy.`);
      }
      if (transition.stage.lockfilePath !== undefined) {
        validateSafeRelativePath(transition.stage.lockfilePath);
      }
    }
    if (transition.mutates === resourceStatesEqual(transition.baseline, transition.desired)) {
      throw new Error(`Dependency-tree transition "${transition.id}" has an inconsistent mutation flag.`);
    }
    if (transition.logicalChangeIds.length === 0 || transition.rollbackGuard.type !== "exact-postimage") {
      throw new Error(`Dependency-tree transition "${transition.id}" has an invalid ownership or rollback contract.`);
    }
    assertEffectActions(
      transition,
      transition.desired.type === "absent" ? "detach" : "upsert",
    );
    return;
  }
  if (transition.kind === "opaque-registration") {
    if (!isAbsentOrFile(transition.baseline) || transition.desired.type !== "opaque") {
      throw new Error(`Opaque transition "${transition.id}" has an invalid state.`);
    }
    if (transition.stage.type !== "adapter-prepare" || transition.stage.adapterKind !== transition.desired.adapterKind) {
      throw new Error(`Opaque transition "${transition.id}" has invalid adapter input.`);
    }
    if (!Array.isArray(transition.stage.changes) || transition.stage.changes.length === 0) {
      throw new Error(`Opaque transition "${transition.id}" has no logical changes.`);
    }
    const semanticIds = transition.desired.semantics.map((semantic) => semantic.semanticId);
    assertUnique(semanticIds, `opaque transition "${transition.id}" semantic identities`);
    for (const change of transition.stage.changes) validateOpaqueAdapterChange(change);
    const stagedIds = transition.stage.changes.map((change) => change.semanticId);
    assertUnique(stagedIds, `opaque transition "${transition.id}" staged semantic identities`);
    if (
      !transition.mutates || stagedIds.length !== semanticIds.length ||
      stagedIds.some((id) => !semanticIds.includes(id)) ||
      semanticIds.some((id) => !stagedIds.includes(id)) ||
      stagedIds.some((id) => !transition.logicalChangeIds.includes(id))
    ) {
      throw new Error(`Opaque transition "${transition.id}" has inconsistent semantic identities.`);
    }
    for (const semantic of transition.desired.semantics) {
      const staged = transition.stage.changes.find(
        (change) => change.semanticId === semantic.semanticId,
      )!;
      const stagedValueSha256 = staged.desiredValue === undefined
        ? undefined
        : hashOwnedValue(staged.desiredValue);
      if (
        staged.harness !== semantic.harness || staged.key !== semantic.key ||
        staged.action !== semantic.action || stagedValueSha256 !== semantic.valueSha256 ||
        staged.expectedValueSha256 !== semantic.expectedValueSha256
      ) {
        throw new Error(
          `Opaque transition "${transition.id}" staged change "${semantic.semanticId}" does not match its postimage.`,
        );
      }
      const effect = transition.ownershipEffects.find(
        (candidate) => candidate.changeId === semantic.semanticId,
      )!;
      const expectedEffect = semantic.action === "set" ? "upsert" : "detach";
      if (effect.action !== expectedEffect) {
        throw new Error(
          `Opaque transition "${transition.id}" ownership effect for "${semantic.semanticId}" does not match its postimage.`,
        );
      }
    }
    if (
      transition.rollbackGuard.type !== "adapter-proven-bounded-inverse" ||
      transition.rollbackGuard.semanticIds.length !== semanticIds.length ||
      transition.rollbackGuard.semanticIds.some((id) => !semanticIds.includes(id))
    ) {
      throw new Error(`Opaque transition "${transition.id}" has an invalid rollback contract.`);
    }
    return;
  }
  if (!isAbsentOrFile(transition.baseline) || !isAbsentOrFile(transition.desired)) {
    throw new Error(`Metadata transition "${transition.id}" has an invalid state.`);
  }
  if (
    transition.logicalChangeIds.length !== 0 || transition.ownershipEffects.length !== 0 ||
    transition.rollbackGuard.type !== "exact-postimage"
  ) {
    throw new Error(`Metadata transition "${transition.id}" has an invalid ownership or rollback contract.`);
  }
  if (transition.desired.type === "absent") {
    if (transition.stage.type !== "none") throw new Error(`Metadata deletion "${transition.id}" must not stage content.`);
    if (transition.mutates === resourceStatesEqual(transition.baseline, transition.desired)) {
      throw new Error(`Metadata transition "${transition.id}" has an inconsistent mutation flag.`);
    }
    return;
  }
  if (transition.kind === "ownership-manifest") {
    if (transition.stage.type !== "generated-json") throw new Error("Ownership manifest transition has invalid staging.");
    validateOwnershipManifest(transition.stage.value);
    if (hashSerializedJson(transition.stage.value) !== transition.desired.sha256) {
      throw new Error("Ownership manifest postimage hash does not match its projection.");
    }
  } else {
    if (transition.stage.type !== "private-generated-json") throw new Error("Restore-data transition has invalid staging.");
    validateRestoreData(transition.stage.value);
    if (hashSerializedJson(transition.stage.value) !== transition.desired.sha256) {
      throw new Error("Restore-data postimage hash does not match its projection.");
    }
  }
  if (transition.mutates === resourceStatesEqual(transition.baseline, transition.desired)) {
    throw new Error(`Metadata transition "${transition.id}" has an inconsistent mutation flag.`);
  }
}

function validateMetadataProjection(
  value: Record<string, unknown>,
  transitions: InstallTransition[],
): void {
  if (!isRecord(value.metadataTransitions) || !isRecord(value.projection)) {
    throw new Error("Executable install plan has invalid metadata projection.");
  }
  const restoreId = value.metadataTransitions.restoreData;
  const manifestId = value.metadataTransitions.ownershipManifest;
  if (typeof restoreId !== "string" || typeof manifestId !== "string") {
    throw new Error("Executable install plan has invalid metadata references.");
  }
  const restore = transitions.find((transition) => transition.id === restoreId);
  const manifest = transitions.find((transition) => transition.id === manifestId);
  if (restore?.kind !== "restore-data" || manifest?.kind !== "ownership-manifest") {
    throw new Error("Executable install plan metadata references are missing or invalid.");
  }
  if (
    value.scope === "project" && typeof value.destinationRoot === "string" &&
    isTargetInsideRoot(restore.target, value.destinationRoot)
  ) {
    throw new Error("Project restore data must be outside the project destination root.");
  }
  if (
    typeof value.destinationRoot === "string" &&
    !isTargetInsideRoot(manifest.target, value.destinationRoot)
  ) {
    throw new Error("Ownership manifest must be inside the destination root.");
  }
  if (restore.order !== transitions.length - 2 || manifest.order !== transitions.length - 1) {
    throw new Error("Metadata transitions must be the final ordered transitions.");
  }
  if (!manifest.dependsOn.includes(restore.id)) {
    throw new Error("Ownership manifest transition must depend on restore data.");
  }
  const mutatingPhysicalIds = transitions
    .filter((transition) => !METADATA_KINDS.has(transition.kind) && transition.mutates)
    .map((transition) => transition.id);
  for (const id of mutatingPhysicalIds) {
    if (!restore.dependsOn.includes(id) || !manifest.dependsOn.includes(id)) {
      throw new Error("Metadata transitions must depend on every mutating physical resource.");
    }
  }
  let projectedManifest: OwnershipManifest | null;
  let projectedRestore: RestoreData | null;
  if (value.projection.manifest === null) {
    projectedManifest = null;
    if (manifest.desired.type !== "absent") throw new Error("Manifest deletion does not match projection.");
  } else {
    projectedManifest = validateOwnershipManifest(value.projection.manifest);
    if (projectedManifest.scope !== value.scope) {
      throw new Error("Ownership manifest projection scope does not match the executable plan.");
    }
    if (manifest.desired.type !== "file" || hashSerializedJson(projectedManifest) !== manifest.desired.sha256) {
      throw new Error("Ownership manifest transition does not match projection.");
    }
    if (manifest.stage.type !== "generated-json" || !deepEqual(manifest.stage.value, projectedManifest)) {
      throw new Error("Ownership manifest staged value does not match projection.");
    }
  }
  if (value.projection.restoreData === null) {
    projectedRestore = null;
    if (restore.desired.type !== "absent") throw new Error("Restore-data deletion does not match projection.");
  } else {
    projectedRestore = validateRestoreData(value.projection.restoreData);
    if (restore.desired.type !== "file" || hashSerializedJson(projectedRestore) !== restore.desired.sha256) {
      throw new Error("Restore-data transition does not match projection.");
    }
    if (restore.stage.type !== "private-generated-json" || !deepEqual(restore.stage.value, projectedRestore)) {
      throw new Error("Restore-data staged value does not match projection.");
    }
  }
  if (!projectedManifest && projectedRestore) {
    throw new Error("Restore data cannot remain without an ownership manifest.");
  }
  if (projectedManifest?.displacedValues.length && !projectedRestore) {
    throw new Error("Every displaced ownership value requires exact private restore data.");
  }
  if (projectedRestore && projectedManifest) {
    const referencedIds = new Map(
      projectedManifest.displacedValues.map((record) => [record.restoreDataId, record]),
    );
    for (const [id, entry] of Object.entries(projectedRestore.entries)) {
      const record = referencedIds.get(id);
      if (!record || hashOwnedValue(entry) !== record.originalValueSha256) {
        throw new Error(`Restore-data entry "${id}" is not an exact projected displaced value.`);
      }
    }
    for (const record of projectedManifest.displacedValues) {
      const entry = projectedRestore.entries[record.restoreDataId];
      if (entry === undefined || hashOwnedValue(entry) !== record.originalValueSha256) {
        throw new Error(
          `Displaced ownership value "${record.id}" is missing exact private restore data.`,
        );
      }
    }
  }
}

function validateInstallWarning(value: unknown): void {
  if (!isRecord(value)) throw new Error("Executable install plan warning must be an object.");
  if (
    ![
      "modified-owned-content",
      "conflict-forced",
      "shared-content-retained",
      "missing-owned-content",
      "trust-required",
    ].includes(String(value.code)) || typeof value.message !== "string" || !value.message
  ) {
    throw new Error("Executable install plan warning is invalid.");
  }
  if (value.path !== undefined && typeof value.path !== "string") {
    throw new Error("Executable install plan warning path is invalid.");
  }
}

function validateOwnershipEffectProjection(
  value: Record<string, unknown>,
  transitions: InstallTransition[],
): void {
  const projection = value.projection as Record<string, unknown>;
  const manifest = projection.manifest === null
    ? null
    : validateOwnershipManifest(projection.manifest);
  const records = new Map<
    string,
    {
      type: "file" | "directory" | "dependency" | "opaque";
      path: string;
      sha256: string;
      key?: string;
      harness?: AgentKind;
    }
  >();
  for (const record of manifest?.files ?? []) {
    records.set(record.id, { type: "file", path: record.path, sha256: record.sha256 });
  }
  for (const record of manifest?.directories ?? []) {
    records.set(record.id, {
      type: "directory",
      path: record.path,
      sha256: record.snapshotSha256,
    });
  }
  for (const record of manifest?.dependencies ?? []) {
    records.set(record.id, {
      type: "dependency",
      path: record.path,
      sha256: record.treeSha256,
    });
  }
  for (const record of manifest?.configRegistrations ?? []) {
    records.set(record.id, {
      type: "opaque",
      path: record.path,
      sha256: record.installedValueSha256,
      key: record.key,
      harness: record.harness,
    });
  }
  for (const record of manifest?.insertedBlocks ?? []) {
    records.set(record.id, {
      type: "opaque",
      path: record.path,
      sha256: record.blockSha256,
      key: record.marker,
      harness: record.harness,
    });
  }
  const residualSourceIds = new Set(
    (manifest?.residualOwnership ?? []).map((record) => record.sourceId),
  );

  for (const transition of transitions) {
    if (
      (transition.kind === "file" || transition.kind === "directory-tree" ||
        transition.kind === "dependency-tree") &&
      transition.desired.type === "absent"
    ) {
      assertNoRetainedProjectionUnder(
        relativeTargetPath(value.destinationRoot as string, transition.target),
        manifest,
      );
    }
    for (const effect of transition.ownershipEffects) {
      if (effect.action === "not-adopted") {
        if (effect.recordId !== undefined) {
          throw new Error(`Not-adopted ownership effect "${effect.changeId}" must not name a record.`);
        }
        continue;
      }
      if (effect.action === "residual") {
        if (!effect.recordId || !residualSourceIds.has(effect.recordId)) {
          throw new Error(`Residual ownership effect "${effect.changeId}" is missing from projection.`);
        }
        continue;
      }
      const record = effect.recordId ? records.get(effect.recordId) : undefined;
      if ((effect.action === "upsert" || effect.action === "retain") && !record) {
        throw new Error(`Ownership effect "${effect.changeId}" is missing from projection.`);
      }
      if (!record || METADATA_KINDS.has(transition.kind) || transition.kind === "parent-directory") {
        continue;
      }
      const recordPath = path.resolve(
        value.destinationRoot as string,
        ...record.path.split("/"),
      );
      const targetPath = resolveTargetPath(transition.target);
      const targetMatches = sameNativePath(recordPath, targetPath) ||
        ((transition.kind === "directory-tree" || transition.kind === "dependency-tree") &&
          isStrictNativeAncestor(targetPath, recordPath));
      if (!targetMatches) {
        throw new Error(`Ownership effect "${effect.changeId}" does not match its physical target.`);
      }
      if (
        effect.action === "upsert" &&
        ((transition.kind === "file" && record.type !== "file") ||
          (transition.kind === "dependency-tree" && record.type !== "dependency") ||
          (transition.kind === "opaque-registration" && record.type !== "opaque"))
      ) {
        throw new Error(`Ownership effect "${effect.changeId}" has an incompatible record type.`);
      }
      if (effect.action === "upsert" && transition.kind === "file") {
        if (transition.desired.type !== "file" || record.sha256 !== transition.desired.sha256) {
          throw new Error(`Ownership effect "${effect.changeId}" does not match the file postimage.`);
        }
      }
      if (effect.action === "upsert" && transition.kind === "dependency-tree") {
        if (
          transition.desired.type !== "dependency-tree" ||
          record.sha256 !== transition.desired.sha256
        ) {
          throw new Error(`Ownership effect "${effect.changeId}" does not match the dependency postimage.`);
        }
      }
      if (effect.action === "upsert" && transition.kind === "opaque-registration") {
        const semantic = transition.desired.semantics.find(
          (candidate) => candidate.semanticId === effect.changeId,
        );
        if (
          !semantic || semantic.action === "remove" || record.sha256 !== semantic.valueSha256 ||
          record.key !== semantic.key || record.harness !== semantic.harness
        ) {
          throw new Error(`Ownership effect "${effect.changeId}" does not match the opaque postimage.`);
        }
      }
    }
  }
}

function validateTargetOverlaps(transitions: InstallTransition[]): void {
  for (let index = 0; index < transitions.length; index += 1) {
    for (let otherIndex = index + 1; otherIndex < transitions.length; otherIndex += 1) {
      const left = transitions[index];
      const right = transitions[otherIndex];
      const leftAncestor = isStrictNativeAncestor(
        resolveTargetPath(left.target),
        resolveTargetPath(right.target),
      );
      const rightAncestor = isStrictNativeAncestor(
        resolveTargetPath(right.target),
        resolveTargetPath(left.target),
      );
      if (!leftAncestor && !rightAncestor) continue;
      const ancestor = leftAncestor ? left : right;
      const descendant = leftAncestor ? right : left;
      if (ancestor.kind !== "parent-directory") {
        throw new Error(
          `Ambiguous overlapping transitions target ${formatTarget(ancestor.target)} and ${formatTarget(descendant.target)}.`,
        );
      }
      if (!descendant.dependsOn.includes(ancestor.id)) {
        throw new Error(`Transition "${descendant.id}" does not depend on parent "${ancestor.id}".`);
      }
    }
  }
}

function assertInstallPlanHeader(plan: InstallPlan): void {
  if (!isRecord(plan) || !isInstallOperation(plan.operation) || !isInstallScope(plan.scope)) {
    throw new Error("Preflight install plan has an invalid operation or scope.");
  }
  assertAgentList(plan.harnesses, "Preflight install plan harnesses");
  assertCanonicalAbsolutePath(plan.checkoutRoot, "Checkout root");
  assertCanonicalAbsolutePath(plan.destinationRoot, "Destination root");
  if (!Array.isArray(plan.sourceInventory) || !Array.isArray(plan.destinationPreconditions) || !Array.isArray(plan.ownedChanges)) {
    throw new Error("Preflight install plan is missing executable observations.");
  }
}

function assertMetadataInput(plan: InstallPlan, ownership: OwnershipCompilationInput): void {
  if (!isRecord(ownership)) throw new Error("Ownership compilation input must be an object.");
  validateMetadataObservation(ownership.manifestResource, "ownership manifest");
  validateMetadataObservation(ownership.restoreDataResource, "restore data");
  if (!isTargetInsideRoot(ownership.manifestResource.target, plan.destinationRoot)) {
    throw new Error("Ownership manifest must be inside the destination root.");
  }
  if (
    plan.scope === "project" &&
    isTargetInsideRoot(ownership.restoreDataResource.target, plan.destinationRoot)
  ) {
    throw new Error("Project restore data must be outside the project destination root.");
  }
  if (ownership.manifest) {
    const manifest = validateOwnershipManifest(ownership.manifest);
    if (manifest.scope !== plan.scope) throw new Error("Ownership baseline scope does not match preflight plan.");
    if (ownership.manifestResource.baseline.type === "absent") {
      throw new Error("Ownership manifest baseline exists but its resource is marked absent.");
    }
  } else if (ownership.manifestResource.baseline.type !== "absent") {
    throw new Error("Ownership manifest resource exists without a validated baseline manifest.");
  }
  if (ownership.restoreData) {
    validateRestoreData(ownership.restoreData);
    if (ownership.restoreDataResource.baseline.type === "absent") {
      throw new Error("Restore-data baseline exists but its resource is marked absent.");
    }
  } else if (ownership.restoreDataResource.baseline.type !== "absent") {
    throw new Error("Restore-data resource exists without validated private data.");
  }
}

function validateMetadataObservation(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`Missing ${label} resource observation.`);
  validateTarget(value.target, undefined);
  if (!isAbsentOrFile(value.baseline)) throw new Error(`${label} baseline must be absent or an exact file hash.`);
  if (!Array.isArray(value.requiredParentDirectories)) {
    throw new Error(`${label} resource must declare required parent directories.`);
  }
  const target = value.target as unknown as ResourceTarget;
  const parentIds = new Set<string>();
  for (const candidate of value.requiredParentDirectories) {
    validateTarget(candidate, undefined);
    const parent = candidate as ResourceTarget;
    if (
      !sameNativePath(parent.root, target.root) ||
      !isStrictRelativeAncestor(parent.relativePath, target.relativePath)
    ) {
      throw new Error(`${label} has a required directory that is not its parent.`);
    }
    const identity = targetIdentity(parent);
    if (parentIds.has(identity)) throw new Error(`${label} has duplicate required parent directories.`);
    parentIds.add(identity);
  }
}

function assertPlannedChange(change: PlannedOwnedChange, preflight: InstallPlan): void {
  if (!isSafeId(change.id)) throw new Error("Preflight change has an invalid semantic identity.");
  validateSafeRelativePath(change.destinationRelativePath);
  const expected = path.resolve(preflight.destinationRoot, ...change.destinationRelativePath.split("/"));
  if (!sameNativePath(expected, change.destinationPath)) {
    throw new Error(`Preflight change "${change.id}" has an inconsistent destination.`);
  }
  assertAgentList(change.harnesses, `Change "${change.id}" harnesses`);
  if (!change.harnesses.every((harness) => preflight.harnesses.includes(harness) || preflight.operation === "uninstall" || preflight.operation === "update")) {
    throw new Error(`Change "${change.id}" names an unselected harness.`);
  }
  if (
    change.artifactType === "config-registration" &&
    !["unrelated", "owned-missing", "owned-unchanged", "owned-modified"].includes(
      String(change.ownershipState),
    )
  ) {
    throw new Error(`Configuration change "${change.id}" has no semantic ownership state.`);
  }
}

function findPrecondition(plan: InstallPlan, change: PlannedOwnedChange): DestinationPrecondition {
  const matches = plan.destinationPreconditions.filter((candidate) =>
    sameNativePath(candidate.path, change.destinationPath),
  );
  if (matches.length === 0) throw new Error(`Change "${change.id}" has no physical-resource baseline.`);
  const first = matches[0];
  for (const candidate of matches.slice(1)) {
    if (
      candidate.exists !== first.exists || candidate.kind !== first.kind ||
      candidate.sha256 !== first.sha256 || candidate.snapshotSha256 !== first.snapshotSha256 ||
      candidate.treeSha256 !== first.treeSha256
    ) {
      throw new Error(`Physical resource ${change.destinationPath} has conflicting baselines.`);
    }
  }
  return first;
}

function findConfigRollback(
  rollbackInputs: readonly RollbackInput[],
  change: PlannedOwnedChange,
  key: string,
): Extract<RollbackInput, { type: "config" }> | undefined {
  return rollbackInputs.find(
    (input): input is Extract<RollbackInput, { type: "config" }> =>
      input.type === "config" && sameNativePath(input.path, change.destinationPath) && input.key === key,
  );
}

function fileBaseline(
  precondition: DestinationPrecondition,
  changeId: string,
): { type: "absent" } | { type: "file"; sha256: string } {
  if (!precondition.exists) return { type: "absent" };
  if (precondition.kind !== "file" || !precondition.sha256) {
    throw new Error(`Change "${changeId}" has no exact file baseline.`);
  }
  return { type: "file", sha256: precondition.sha256 };
}

function dependencyBaseline(
  precondition: DestinationPrecondition,
  changeId: string,
): { type: "absent" } | { type: "dependency-tree"; sha256: string } {
  if (!precondition.exists) return { type: "absent" };
  if (precondition.kind !== "directory" || !precondition.treeSha256) {
    throw new Error(`Dependency change "${changeId}" has no exact tree baseline.`);
  }
  return { type: "dependency-tree", sha256: precondition.treeSha256 };
}

function assertNoRetainedProjectionUnder(
  relativePath: string,
  manifest: OwnershipManifest | null,
): void {
  if (!manifest) return;
  const retained = [
    ...manifest.files,
    ...manifest.directories,
    ...manifest.dependencies,
    ...manifest.configRegistrations,
    ...manifest.insertedBlocks,
    ...manifest.displacedValues,
    ...manifest.residualOwnership,
  ].find(
    (record) =>
      normalizeRelativeIdentity(record.path) === normalizeRelativeIdentity(relativePath) ||
      isStrictRelativeAncestor(relativePath, record.path),
  );
  if (retained) {
    throw new Error(
      `Removing ${relativePath} would delete retained ownership record "${retained.id}" at ${retained.path}.`,
    );
  }
}

function toOpaqueAdapterChange(
  change: PlannedOwnedChange,
  rollbackInputs: readonly RollbackInput[],
): OpaqueAdapterChange {
  const action = change.action === "create" || change.action === "replace"
    ? "set"
    : change.action === "restore"
      ? "restore"
      : "remove";
  let expectedValueSha256 = change.sha256;
  if (change.artifactType === "config-registration") {
    const key = requireSemanticKey(change);
    const rollback = findConfigRollback(rollbackInputs, change, key);
    if (!rollback) {
      throw new Error(`Opaque config change "${change.id}" has no exact rollback input.`);
    }
    expectedValueSha256 = rollback.sha256;
  }
  return {
    semanticId: change.id,
    harness: requireSingleHarness(change),
    key: requireSemanticKey(change),
    action,
    desiredValue: change.desiredValue === undefined ? undefined : cloneJson(change.desiredValue),
    expectedValueSha256,
  };
}

function validateOpaqueAdapterChange(value: unknown): void {
  if (!isRecord(value) || !isSafeId(value.semanticId) || !isAgentKind(value.harness)) {
    throw new Error("Opaque adapter change has invalid identity fields.");
  }
  if (typeof value.key !== "string" || !value.key || /[\u0000-\u001f\u007f]/.test(value.key)) {
    throw new Error(`Opaque adapter change "${value.semanticId}" has an invalid key.`);
  }
  if (!["set", "remove", "restore"].includes(String(value.action))) {
    throw new Error(`Opaque adapter change "${value.semanticId}" has an invalid action.`);
  }
  if (value.desiredValue !== undefined && !isJsonValue(value.desiredValue)) {
    throw new Error(`Opaque adapter change "${value.semanticId}" has an invalid desired value.`);
  }
  if (value.expectedValueSha256 !== undefined) assertSha256(value.expectedValueSha256, "Opaque expected value");
}

function validateOwnershipEffect(value: unknown): void {
  if (!isRecord(value) || !isSafeId(value.changeId)) throw new Error("Ownership effect has an invalid change ID.");
  if (!["upsert", "detach", "retain", "residual", "not-adopted"].includes(String(value.action))) {
    throw new Error(`Ownership effect for "${value.changeId}" has an invalid action.`);
  }
  if (value.recordId !== undefined && !isSafeId(value.recordId)) {
    throw new Error(`Ownership effect for "${value.changeId}" has an invalid record ID.`);
  }
}

function assertEffectActions(
  transition: InstallTransition,
  expected: OwnershipEffect["action"],
): void {
  if (transition.ownershipEffects.some((effect) => effect.action !== expected)) {
    throw new Error(
      `Transition "${transition.id}" ownership effects do not match its postimage.`,
    );
  }
}

function validateRollbackGuard(value: unknown): void {
  if (!isRecord(value) || !["exact-postimage", "created-empty-directory", "adapter-proven-bounded-inverse"].includes(String(value.type))) {
    throw new Error("Install transition has an invalid rollback guard.");
  }
  if (value.type === "adapter-proven-bounded-inverse") {
    assertStringArray(value.semanticIds, "Rollback semantic IDs", false);
    assertUnique(value.semanticIds as string[], "rollback semantic IDs");
  }
}

function validateTarget(value: unknown, resourceRoots: readonly string[] | undefined): void {
  if (!isRecord(value)) throw new Error("Resource target must be an object.");
  assertCanonicalAbsolutePath(value.root, "Resource target root");
  validateSafeRelativePath(value.relativePath);
  if (resourceRoots && !resourceRoots.some((root) => sameNativePath(root, value.root as string))) {
    throw new Error(`Resource target root is not declared: ${String(value.root)}.`);
  }
  const resolved = path.resolve(value.root as string, ...(value.relativePath as string).split("/"));
  const relative = path.relative(value.root as string, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Resource target escapes its declared root.");
  }
}

function validateExactState(value: unknown, label: string): void {
  if (!isRecord(value) || !["absent", "file", "directory", "directory-tree", "dependency-tree"].includes(String(value.type))) {
    throw new Error(`Resource ${label} has an invalid type.`);
  }
  if (["file", "directory-tree", "dependency-tree"].includes(String(value.type))) {
    assertSha256(value.sha256, `Resource ${label}`);
  }
}

function validatePostimage(value: unknown): void {
  if (isRecord(value) && value.type === "opaque") {
    if (!["claude-json", "codex-toml", "inserted-block"].includes(String(value.adapterKind))) {
      throw new Error("Opaque postimage has an invalid adapter kind.");
    }
    if (!Array.isArray(value.semantics) || value.semantics.length === 0) {
      throw new Error("Opaque postimage must contain semantic targets.");
    }
    for (const semantic of value.semantics) {
      if (!isRecord(semantic) || !isSafeId(semantic.semanticId) || !isAgentKind(semantic.harness)) {
        throw new Error("Opaque postimage has an invalid semantic target.");
      }
      if (typeof semantic.key !== "string" || !semantic.key || !["set", "remove", "restore"].includes(String(semantic.action))) {
        throw new Error(`Opaque semantic target "${semantic.semanticId}" is invalid.`);
      }
      if (semantic.valueSha256 !== undefined) assertSha256(semantic.valueSha256, "Opaque semantic value");
      if (semantic.expectedValueSha256 !== undefined) {
        assertSha256(semantic.expectedValueSha256, "Opaque semantic expected value");
      }
    }
    return;
  }
  validateExactState(value, "postimage");
}

function normalizeTarget(target: ResourceTarget): ResourceTarget {
  validateTarget(target, undefined);
  return { root: target.root, relativePath: target.relativePath };
}

function targetWithin(root: string, relativePath: string): ResourceTarget {
  validateSafeRelativePath(relativePath);
  return { root, relativePath };
}

function targetIdentity(target: ResourceTarget): string {
  return normalizeNativeIdentity(resolveTargetPath(target));
}

function formatTarget(target: ResourceTarget): string {
  return resolveTargetPath(target);
}

function resolveTargetPath(target: ResourceTarget): string {
  return path.resolve(target.root, ...target.relativePath.split("/"));
}

function relativeTargetPath(destinationRoot: string, target: ResourceTarget): string {
  const relative = path.relative(destinationRoot, resolveTargetPath(target));
  const normalized = relative.split(path.sep).join("/");
  validateSafeRelativePath(normalized);
  return normalized;
}

function isTargetInsideRoot(target: ResourceTarget, root: string): boolean {
  const absoluteTarget = path.resolve(target.root, ...target.relativePath.split("/"));
  const relative = path.relative(root, absoluteTarget);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertOutsideWorkflowHistory(target: ResourceTarget, destinationRoot: string): void {
  if (!isTargetInsideRoot(target, destinationRoot)) return;
  const absoluteTarget = path.resolve(target.root, ...target.relativePath.split("/"));
  const relative = path.relative(destinationRoot, absoluteTarget).split(path.sep).join("/");
  validateSafeRelativePath(relative);
}

function transitionId(kind: InstallTransition["kind"], target: ResourceTarget): string {
  return `${kind}-${hashText(targetIdentity(target)).slice(0, 24)}`;
}

function parentDependencies(
  target: ResourceTarget,
  drafts: Array<Omit<InstallTransition, "order">>,
): string[] {
  return drafts
    .filter(
      (draft) =>
        draft.kind === "parent-directory" &&
        isStrictNativeAncestor(resolveTargetPath(draft.target), resolveTargetPath(target)),
    )
    .map((draft) => draft.id);
}

function effectsFor(
  changes: readonly PlannedOwnedChange[],
  effects: ReadonlyMap<string, OwnershipEffect>,
): OwnershipEffect[] {
  return changes.map((change) => {
    const effect = effects.get(change.id);
    if (!effect) throw new Error(`Logical change "${change.id}" has no ownership projection.`);
    return effect;
  });
}

function upsertResidual(
  records: ResidualOwnershipRecord[],
  sourceId: string,
  artifactType: ResidualOwnershipRecord["artifactType"],
  relativePath: string,
  reason: ResidualOwnershipRecord["reason"],
  expectedSha256: string | undefined,
  observedSha256: string | undefined,
  projectedAt: string,
): void {
  const id = `${sourceId}-residual`;
  const index = records.findIndex((record) => record.id === id);
  const record: ResidualOwnershipRecord = {
    id,
    sourceId,
    artifactType,
    path: relativePath,
    reason,
    expectedSha256,
    observedSha256,
    retainedAt: records[index]?.retainedAt ?? projectedAt,
  };
  replaceAt(records, index, record);
}

function removeDisplacedAt(
  records: DisplacedValueRecord[],
  index: number,
  restoreEntries: Record<string, JsonValue>,
): void {
  if (index < 0) return;
  delete restoreEntries[records[index].restoreDataId];
  records.splice(index, 1);
}

function observedHash(
  precondition: DestinationPrecondition,
  type: "file" | "directory" | "dependency",
): string | undefined {
  return type === "file"
    ? precondition.sha256
    : type === "directory"
      ? precondition.snapshotSha256
      : precondition.treeSha256;
}

function replaceAt<T>(values: T[], index: number, value: T): void {
  if (index < 0) values.push(value);
  else values[index] = value;
}

function requireSingleHarness(change: PlannedOwnedChange): AgentKind {
  if (change.harnesses.length !== 1) {
    throw new Error(`Logical change "${change.id}" must name exactly one harness.`);
  }
  return change.harnesses[0];
}

function requireSemanticKey(change: PlannedOwnedChange): string {
  if (!change.semanticKey || /[\u0000-\u001f\u007f]/.test(change.semanticKey)) {
    throw new Error(`Logical change "${change.id}" has no valid semantic key.`);
  }
  return change.semanticKey;
}

function requireAdapterKind(change: PlannedOwnedChange): OpaqueResourcePostimage["adapterKind"] {
  if (!change.adapterKind) throw new Error(`Logical change "${change.id}" has no adapter kind.`);
  return change.adapterKind;
}

function requireDependencyInput(
  change: PlannedOwnedChange,
): NonNullable<PlannedOwnedChange["dependencyInput"]> {
  const input = change.dependencyInput;
  if (
    !input || input.packageManager !== "npm" || !Array.isArray(input.packageNames) ||
    input.packageNames.length === 0 ||
    !input.packageNames.every(
      (name) =>
        typeof name === "string" &&
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name),
    ) || new Set(input.packageNames).size !== input.packageNames.length
  ) {
    throw new Error(`Dependency change "${change.id}" has invalid package policy input.`);
  }
  if (input.lockfilePath !== undefined) validateSafeRelativePath(input.lockfilePath);
  return input;
}

function requireSha256(value: unknown, label: string): string {
  assertSha256(value, label);
  return value as string;
}

function isPayloadArtifact(value: PlannedOwnedChange["artifactType"]): value is PayloadArtifactType {
  return [
    "shared-runtime",
    "mcp-entrypoint",
    "launcher",
    "kilo-adapter",
    "canonical-skill",
    "reviewer-skill",
  ].includes(value);
}

function mergeHarnesses(left: readonly AgentKind[], right: readonly AgentKind[]): AgentKind[] {
  const values = new Set([...left, ...right]);
  return AGENT_KINDS.filter((harness) => values.has(harness));
}

function detachSelectedHarnesses(
  current: readonly AgentKind[],
  selected: readonly AgentKind[],
): AgentKind[] {
  return current.filter((harness) => !selected.includes(harness));
}

function compareTargetsByDepth(left: ResourceTarget, right: ResourceTarget): number {
  return compareNativePaths(left.root, right.root) ||
    left.relativePath.split("/").length - right.relativePath.split("/").length ||
    left.relativePath.localeCompare(right.relativePath);
}

function isStrictRelativeAncestor(parentPath: string, childPath: string): boolean {
  const parentIdentity = normalizeRelativeIdentity(parentPath);
  const childIdentity = normalizeRelativeIdentity(childPath);
  return childIdentity.startsWith(`${parentIdentity}/`);
}

function isStrictNativeAncestor(parentPath: string, childPath: string): boolean {
  const relative = path.relative(
    normalizeNativeIdentity(parentPath),
    normalizeNativeIdentity(childPath),
  );
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
}

function normalizeRelativeIdentity(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function normalizeNativeIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameNativePath(left: string, right: string): boolean {
  return normalizeNativeIdentity(left) === normalizeNativeIdentity(right);
}

function compareNativePaths(left: string, right: string): number {
  return normalizeNativeIdentity(left).localeCompare(normalizeNativeIdentity(right));
}

function resourceStatesEqual(left: ResourcePostimage, right: ResourcePostimage): boolean {
  return deepEqual(left, right);
}

function serializeJson(value: OwnershipManifest | RestoreData): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function hashSerializedJson(value: OwnershipManifest | RestoreData): string {
  return createHash("sha256").update(serializeJson(value), "utf8").digest("hex");
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function equalIgnoringUpdatedAt(left: OwnershipManifest, right: OwnershipManifest): boolean {
  return deepEqual({ ...left, updatedAt: right.updatedAt }, right);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortRecords<T extends { id: string }>(records: T[]): void {
  records.sort((left, right) => left.id.localeCompare(right.id));
}

function sortObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function uniqueSorted<T>(values: readonly T[], compare?: (left: T, right: T) => number): T[] {
  const result = [...new Set(values)];
  if (compare) result.sort(compare);
  else (result as unknown as string[]).sort();
  return result;
}

function assertCanonicalAbsolutePath(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a normalized absolute path.`);
  }
}

function assertAgentList(value: unknown, label: string): asserts value is AgentKind[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isAgentKind) || new Set(value).size !== value.length) {
    throw new Error(`${label} must contain unique supported harnesses.`);
  }
}

function assertStringArray(value: unknown, label: string, allowEmpty: boolean): asserts value is string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every((entry) => typeof entry === "string" && isSafeId(entry))) {
    throw new Error(`${label} must contain valid identities.`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Executable install plan contains duplicate ${label}.`);
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 hash.`);
  }
}

function assertIsoTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
}

function isSafeId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9._-]{0,127}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstallOperation(value: unknown): value is InstallPlan["operation"] {
  return value === "install" || value === "update" || value === "uninstall";
}

function isInstallScope(value: unknown): value is InstallPlan["scope"] {
  return value === "user" || value === "project";
}

function isTransitionKind(value: unknown): value is InstallTransition["kind"] {
  return [
    "parent-directory",
    "file",
    "directory-tree",
    "dependency-tree",
    "opaque-registration",
    "ownership-manifest",
    "restore-data",
  ].includes(String(value));
}

function isAbsentOrFile(
  value: unknown,
): value is { type: "absent" } | { type: "file"; sha256: string } {
  if (!isRecord(value)) return false;
  if (value.type === "absent") return true;
  return value.type === "file" && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}

function isAbsentOrDependencyTree(
  value: unknown,
): value is { type: "absent" } | { type: "dependency-tree"; sha256: string } {
  if (!isRecord(value)) return false;
  if (value.type === "absent") return true;
  return value.type === "dependency-tree" && typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
