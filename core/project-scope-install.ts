import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { ClaudeJsonInstallAdapter } from "./claude-json-install-adapter.ts";
import { CodexTomlInstallAdapter } from "./codex-toml-install-adapter.ts";
import {
  compileExecutableInstallPlan,
} from "./executable-install-plan.ts";
import type {
  ExecutableInstallPlan,
  MetadataResourceObservation,
  ResourceTarget,
  TransitionAdapterContext,
} from "./executable-install-plan.ts";
import {
  FileSystemInstallAdapter,
} from "./filesystem-install-adapter.ts";
import type {
  FileSystemInstallAdapterOptions,
} from "./filesystem-install-adapter.ts";
import { copyFileSystemTree, snapshotFileSystemTree } from "./filesystem-tree.ts";
import {
  ENGINEERING_WORKFLOW_MCP_NAME,
  buildInstallPlan,
  normalizeInstallHarnesses,
} from "./install-plan.ts";
import type {
  InstallConfigTarget,
  InstallOperation,
  InstallPlan,
  InstallPreflightBackend,
  InstallSelection,
  InstallTrustTarget,
} from "./install-plan.ts";
import { executeInstallTransaction } from "./install-transaction.ts";
import type { InstallTransactionResult } from "./install-transaction.ts";
import type { AgentKind, JsonValue } from "./model.ts";
import {
  LEGACY_PROJECT_OWNERSHIP_MANIFEST_PATH,
  PROJECT_TOOLKIT_ROOT,
  inspectLegacyPhase1Manifest,
  parseOwnershipManifest,
  resolveOwnershipPaths,
  validateRestoreData,
  validateSafeRelativePath,
} from "./ownership-manifest.ts";
import type { RestoreData } from "./ownership-manifest.ts";
export const PROJECT_CLAUDE_CONFIG_PATH = ".mcp.json" as const;
export const PROJECT_CODEX_CONFIG_PATH = ".codex/config.toml" as const;
export const PROJECT_DEPENDENCY_PATH = `${PROJECT_TOOLKIT_ROOT}/node_modules` as const;

const PROJECT_MCP_ENTRYPOINT = [
  ".agents",
  "toolkits",
  "kilo-herdr-engineering-workflow",
  "mcp",
  "server.ts",
] as const;

const PROJECT_MCP_BOOTSTRAP = [
  'import{existsSync}from"node:fs";',
  'import path from"node:path";',
  'import{pathToFileURL}from"node:url";',
  "let directory=process.cwd();",
  "for(;;){",
  `const entry=path.join(directory,${PROJECT_MCP_ENTRYPOINT.map((part) => JSON.stringify(part)).join(",")});`,
  "if(existsSync(entry)){await import(pathToFileURL(entry).href);break;}",
  "const parent=path.dirname(directory);",
  'if(parent===directory)throw new Error("Could not find the project engineering workflow MCP entrypoint.");',
  "directory=parent;",
  "}",
].join("");

export interface ProjectScopeConfigPaths {
  readonly claude?: string;
  readonly codex?: string;
}

export interface ProjectScopeInstallRequest {
  readonly operation?: InstallOperation;
  readonly selections?: InstallSelection | readonly InstallSelection[];
  readonly checkoutRoot: string;
  readonly projectRoot: string;
  /** Private persistent storage outside the project for displaced config values. */
  readonly privateRestoreRoot: string;
  readonly force?: boolean;
  readonly skipDependencies?: boolean;
  readonly configPaths?: ProjectScopeConfigPaths;
  readonly trustTargets?: readonly InstallTrustTarget[];
  readonly preflightBackend?: InstallPreflightBackend;
  readonly filesystemOptions?: FileSystemInstallAdapterOptions;
  readonly projectedAt?: string;
  readonly signal?: AbortSignal;
}

export interface ProjectScopeExecutablePlan {
  readonly preflightPlan: InstallPlan;
  readonly executablePlan: ExecutableInstallPlan;
}

export interface ProjectScopeInstallResult extends ProjectScopeExecutablePlan {
  readonly transaction: InstallTransactionResult;
}

/** Builds a portable project transaction without mutating project content. */
export async function buildProjectScopeExecutablePlan(
  request: ProjectScopeInstallRequest,
): Promise<ProjectScopeExecutablePlan> {
  const operation = request.operation ?? "install";
  const checkoutRoot = canonicalDirectory(request.checkoutRoot, "Checkout root");
  const projectRoot = canonicalDirectory(request.projectRoot, "Project root");
  const privateRestoreRoot = canonicalDirectory(
    request.privateRestoreRoot,
    "Private restore-data root",
  );
  const harnesses = normalizeInstallHarnesses(request.selections);
  const signal = request.signal ?? new AbortController().signal;
  throwIfAborted(signal);
  refuseLegacyProjectOwnership(projectRoot);

  const ownershipPaths = resolveOwnershipPaths(
    "project",
    projectRoot,
    privateRestoreRoot,
  );
  const manifestSnapshot = readMetadataSnapshot(
    projectRoot,
    ownershipPaths.manifestPath,
    (source) => parseOwnershipManifest(source, { root: projectRoot }),
  );
  const restoreDataSnapshot = readMetadataSnapshot(
    privateRestoreRoot,
    ownershipPaths.restoreDataPath,
    parseRestoreData,
    true,
  );
  const manifest = manifestSnapshot.value;
  const restoreData = restoreDataSnapshot.value;
  if (restoreData && !manifest) {
    throw new Error(
      `Private restore data exists without an ownership manifest: ${ownershipPaths.restoreDataPath}`,
    );
  }

  const dependencyTargets = operation === "uninstall"
    ? []
    : [{
        path: PROJECT_DEPENDENCY_PATH,
        treeSha256: snapshotFileSystemTree(
          path.join(checkoutRoot, "node_modules"),
          { allowInternalLinks: true },
        ).sha256,
        packageNames: readRuntimePackageNames(checkoutRoot),
        sourceLockfilePath: "package-lock.json",
        installedLockfilePath: `${PROJECT_TOOLKIT_ROOT}/package-lock.json`,
      }];
  const preflightPlan = await buildInstallPlan({
    operation,
    scope: "project",
    selections: request.selections,
    checkoutRoot,
    destinationRoot: projectRoot,
    existingManifest: manifest,
    existingRestoreData: restoreData,
    configTargets: buildConfigTargets(harnesses, request.configPaths),
    dependencyTargets,
    trustTargets: request.trustTargets,
    force: request.force,
    skipDependencies: request.skipDependencies,
    backend: request.preflightBackend,
  });
  throwIfAborted(signal);

  const executablePlan = compileExecutableInstallPlan({
    preflightPlan,
    projectedAt: request.projectedAt ?? new Date().toISOString(),
    ownership: {
      manifest,
      restoreData,
      manifestResource: manifestSnapshot.resource,
      restoreDataResource: restoreDataSnapshot.resource,
    },
  });
  return { preflightPlan, executablePlan };
}

/** Executes one project transaction through the shared filesystem/config adapters. */
export async function executeProjectScopeInstallOperation(
  request: ProjectScopeInstallRequest,
): Promise<ProjectScopeInstallResult> {
  const plans = await buildProjectScopeExecutablePlan(request);
  const dependencySource = path.join(plans.preflightPlan.checkoutRoot, "node_modules");
  const filesystem = new FileSystemInstallAdapter({
    ...request.filesystemOptions,
    prepareDependencyTree: request.filesystemOptions?.prepareDependencyTree ??
      (async ({ outputPath }) => {
        copyFileSystemTree(dependencySource, outputPath, {
          allowInternalLinks: true,
        });
      }),
  });
  const claude = new ClaudeJsonInstallAdapter();
  const codex = new CodexTomlInstallAdapter();
  const transaction = await executeInstallTransaction({
    plan: plans.executablePlan,
    signal: request.signal,
    resolveAdapter: (context) => resolveAdapter(context, {
      filesystem,
      claude,
      codex,
    }),
  });
  return { ...plans, transaction };
}

export function buildProjectMcpRegistration(
  harness: "claude" | "codex",
): JsonValue {
  return {
    command: "node",
    args: [
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      PROJECT_MCP_BOOTSTRAP,
    ],
    env: { WORKFLOW_COORDINATOR_KIND: harness },
  };
}

function buildConfigTargets(
  harnesses: readonly AgentKind[],
  paths: ProjectScopeConfigPaths | undefined,
): InstallConfigTarget[] {
  const targets: InstallConfigTarget[] = [];
  if (harnesses.includes("claude")) {
    targets.push({
      harness: "claude",
      path: normalizeRelativePath(paths?.claude ?? PROJECT_CLAUDE_CONFIG_PATH),
      key: `mcpServers.${ENGINEERING_WORKFLOW_MCP_NAME}`,
      format: "json",
      installedValue: buildProjectMcpRegistration("claude"),
    });
  }
  if (harnesses.includes("codex")) {
    targets.push({
      harness: "codex",
      path: normalizeRelativePath(paths?.codex ?? PROJECT_CODEX_CONFIG_PATH),
      key: `mcp_servers.${ENGINEERING_WORKFLOW_MCP_NAME}`,
      format: "toml",
      installedValue: buildProjectMcpRegistration("codex"),
    });
  }
  return targets;
}

function refuseLegacyProjectOwnership(projectRoot: string): void {
  const legacyPath = path.join(
    projectRoot,
    ...LEGACY_PROJECT_OWNERSHIP_MANIFEST_PATH.split("/"),
  );
  if (!existsSync(legacyPath)) return;
  const inspection = inspectLegacyPhase1Manifest(readFileSync(legacyPath, "utf8"));
  throw new Error(`${inspection.reason} Legacy manifest retained at ${legacyPath}.`);
}

function readRuntimePackageNames(checkoutRoot: string): string[] {
  const packagePath = path.join(checkoutRoot, "package.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Runtime package metadata is not valid JSON: ${errorMessage(error)}`,
    );
  }
  if (!isRecord(value) || !isRecord(value.dependencies)) {
    throw new Error("Runtime package metadata must declare dependencies.");
  }
  const names = Object.keys(value.dependencies).sort();
  if (
    names.length === 0 ||
    !Object.values(value.dependencies).every((version) => typeof version === "string")
  ) {
    throw new Error("Runtime package dependencies are invalid.");
  }
  return names;
}

interface MetadataSnapshot<T> {
  readonly value?: T;
  readonly resource: MetadataResourceObservation;
}

function readMetadataSnapshot<T>(
  root: string,
  filePath: string,
  parse: (source: string) => T,
  requirePrivatePermissions = false,
): MetadataSnapshot<T> {
  const relativePath = relativePathWithin(root, filePath);
  const target = { root, relativePath };
  if (!existsSync(filePath)) {
    return {
      resource: {
        target,
        baseline: { type: "absent" },
        requiredParentDirectories: missingParentTargets(root, relativePath),
      },
    };
  }

  const before = lstatSync(filePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Ownership metadata is not a physical file: ${filePath}`);
  }
  if (
    requirePrivatePermissions && process.platform !== "win32" &&
    (before.mode & 0o077) !== 0
  ) {
    throw new Error(`Restore data permissions are too broad: ${filePath}`);
  }
  const source = readFileSync(filePath);
  const after = lstatSync(filePath);
  if (
    before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`Ownership metadata changed while it was being read: ${filePath}`);
  }
  return {
    value: parse(source.toString("utf8")),
    resource: {
      target,
      baseline: {
        type: "file",
        sha256: createHash("sha256").update(source).digest("hex"),
      },
      requiredParentDirectories: missingParentTargets(root, relativePath),
    },
  };
}

function parseRestoreData(source: string): RestoreData {
  try {
    return validateRestoreData(JSON.parse(source) as unknown);
  } catch (error) {
    throw new Error(`Restore data is not valid JSON: ${errorMessage(error)}`);
  }
}

function missingParentTargets(root: string, relativeFilePath: string): ResourceTarget[] {
  const parent = path.posix.dirname(relativeFilePath);
  if (parent === ".") return [];
  const segments = parent.split("/");
  const targets: ResourceTarget[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    const relativePath = segments.slice(0, index).join("/");
    const absolutePath = path.resolve(root, ...relativePath.split("/"));
    if (!existsSync(absolutePath)) {
      targets.push({ root, relativePath });
      continue;
    }
    const info = lstatSync(absolutePath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Ownership metadata parent is not a physical directory: ${absolutePath}`);
    }
  }
  return targets;
}

function resolveAdapter(
  context: TransitionAdapterContext,
  adapters: {
    filesystem: FileSystemInstallAdapter;
    claude: ClaudeJsonInstallAdapter;
    codex: CodexTomlInstallAdapter;
  },
) {
  if (context.transition.kind === "external-registration") {
    throw new Error("Project installation does not support external registrations.");
  }
  if (context.transition.kind === "opaque-registration") {
    if (context.transition.stage.adapterKind === "claude-json") return adapters.claude;
    if (context.transition.stage.adapterKind === "codex-toml") return adapters.codex;
    throw new Error(
      `Project-scope composition has no adapter for ${context.transition.stage.adapterKind}.`,
    );
  }
  return adapters.filesystem;
}

function canonicalDirectory(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (resolved !== value || !existsSync(resolved)) {
    throw new Error(`${label} must be an existing normalized absolute path: ${value}`);
  }
  const info = lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`${label} must be a physical directory: ${resolved}`);
  }
  return resolved;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  validateSafeRelativePath(normalized);
  return normalized;
}

function relativePathWithin(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  validateSafeRelativePath(relative, root);
  return relative;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
}
