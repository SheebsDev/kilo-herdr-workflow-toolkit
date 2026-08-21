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
  ExternalRegistrationInstallAdapter,
} from "./external-registration-install-adapter.ts";
import type {
  ExternalRegistrationBackend,
} from "./external-registration-install-adapter.ts";
import {
  FileSystemInstallAdapter,
} from "./filesystem-install-adapter.ts";
import type {
  FileSystemInstallAdapterOptions,
} from "./filesystem-install-adapter.ts";
import {
  buildInstallPlan,
  normalizeInstallHarnesses,
} from "./install-plan.ts";
import type {
  InstallConfigTarget,
  InstallOperation,
  InstallPlan,
  InstallPreflightBackend,
  InstallSelection,
} from "./install-plan.ts";
import {
  executeInstallTransaction,
} from "./install-transaction.ts";
import type { InstallTransactionResult } from "./install-transaction.ts";
import type { AgentKind, JsonValue } from "./model.ts";
import {
  parseOwnershipManifest,
  resolveOwnershipPaths,
  validateRestoreData,
  validateSafeRelativePath,
} from "./ownership-manifest.ts";
import type { RestoreData } from "./ownership-manifest.ts";

export const ENGINEERING_WORKFLOW_MCP_NAME = "engineering-workflow" as const;
export const KILO_CONFIG_REGISTRATION_KEY = "KILO_CONFIG_DIR" as const;
export const USER_CLAUDE_CONFIG_PATH = ".claude.json" as const;
export const USER_CODEX_CONFIG_PATH = ".codex/config.toml" as const;
export const USER_KILO_REGISTRATION_PATH =
  ".config/kilo-herdr-engineering-workflow/external-registrations/KILO_CONFIG_DIR" as const;

export interface UserScopeConfigPaths {
  readonly claude?: string;
  readonly codex?: string;
}

export interface UserScopeInstallRequest {
  readonly operation?: InstallOperation;
  readonly selections?: InstallSelection | readonly InstallSelection[];
  readonly checkoutRoot: string;
  readonly homeRoot: string;
  readonly force?: boolean;
  readonly skipDependencies?: boolean;
  readonly nodeExecutable?: string;
  readonly configPaths?: UserScopeConfigPaths;
  readonly preflightBackend?: InstallPreflightBackend;
  readonly externalRegistrationBackend?: ExternalRegistrationBackend;
  readonly filesystemOptions?: FileSystemInstallAdapterOptions;
  readonly projectedAt?: string;
  readonly signal?: AbortSignal;
}

export interface UserScopeExecutablePlan {
  readonly preflightPlan: InstallPlan;
  readonly executablePlan: ExecutableInstallPlan;
}

export interface UserScopeInstallResult extends UserScopeExecutablePlan {
  readonly transaction: InstallTransactionResult;
}

/** Builds a complete user-scope transaction without mutating user state. */
export async function buildUserScopeExecutablePlan(
  request: UserScopeInstallRequest,
): Promise<UserScopeExecutablePlan> {
  const operation = request.operation ?? "install";
  const checkoutRoot = canonicalDirectory(request.checkoutRoot, "Checkout root");
  const homeRoot = canonicalDirectory(request.homeRoot, "User home root");
  const harnesses = normalizeInstallHarnesses(request.selections);
  const signal = request.signal ?? new AbortController().signal;
  throwIfAborted(signal);

  const ownershipPaths = resolveOwnershipPaths("user", homeRoot);
  const manifestSnapshot = readMetadataSnapshot(
    homeRoot,
    ownershipPaths.manifestPath,
    (source) => parseOwnershipManifest(source, { root: homeRoot }),
  );
  const restoreDataSnapshot = readMetadataSnapshot(
    homeRoot,
    ownershipPaths.restoreDataPath,
    parseRestoreData,
    true,
  );
  const manifest = manifestSnapshot.value;
  const restoreData = restoreDataSnapshot.value;
  if (restoreData && !manifest) {
    throw new Error(`Private restore data exists without an ownership manifest: ${ownershipPaths.restoreDataPath}`);
  }

  const externalRegistrationTargets = harnesses.includes("kilo")
    ? [{
        harness: "kilo" as const,
        path: USER_KILO_REGISTRATION_PATH,
        key: KILO_CONFIG_REGISTRATION_KEY,
        installedValue: checkoutRoot,
      }]
    : [];
  if (externalRegistrationTargets.length > 0 && operation !== "uninstall" && !request.externalRegistrationBackend) {
    throw new Error(
      "Kilo user installation requires an injected external-registration backend; platform environment/profile mutation is not performed by core.",
    );
  }

  const configTargets = buildConfigTargets(
    harnesses,
    checkoutRoot,
    request.nodeExecutable ?? process.execPath,
    request.configPaths,
  );
  const backend: InstallPreflightBackend = {
    ...request.preflightBackend,
    readExternalRegistration: request.externalRegistrationBackend
      ? async (target) => {
          const value = await request.externalRegistrationBackend!.read(target.key, signal);
          return value === undefined ? { exists: false } : { exists: true, value };
        }
      : request.preflightBackend?.readExternalRegistration,
  };
  const preflightPlan = await buildInstallPlan({
    operation,
    scope: "user",
    selections: request.selections,
    checkoutRoot,
    destinationRoot: homeRoot,
    existingManifest: manifest,
    existingRestoreData: restoreData,
    configTargets,
    externalRegistrationTargets,
    force: request.force,
    skipDependencies: request.skipDependencies,
    backend,
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

/** Executes one transaction with filesystem, config, and injected external adapters. */
export async function executeUserScopeInstallOperation(
  request: UserScopeInstallRequest,
): Promise<UserScopeInstallResult> {
  const plans = await buildUserScopeExecutablePlan(request);
  const filesystem = new FileSystemInstallAdapter(request.filesystemOptions);
  const claude = new ClaudeJsonInstallAdapter();
  const codex = new CodexTomlInstallAdapter();
  const external = request.externalRegistrationBackend
    ? new ExternalRegistrationInstallAdapter(request.externalRegistrationBackend)
    : undefined;
  const transaction = await executeInstallTransaction({
    plan: plans.executablePlan,
    signal: request.signal,
    resolveAdapter: (context) => resolveAdapter(context, {
      filesystem,
      claude,
      codex,
      external,
    }),
  });
  return { ...plans, transaction };
}

export function buildUserMcpRegistration(
  harness: "claude" | "codex",
  checkoutRoot: string,
  nodeExecutable = process.execPath,
): JsonValue {
  const canonicalCheckout = path.resolve(checkoutRoot);
  const canonicalNode = path.resolve(nodeExecutable);
  if (!path.isAbsolute(nodeExecutable) || canonicalNode !== nodeExecutable) {
    throw new Error("The user-scope MCP Node executable must be a normalized absolute path.");
  }
  return {
    command: canonicalNode,
    args: [
      "--experimental-strip-types",
      path.join(canonicalCheckout, "mcp", "server.ts"),
    ],
    env: { WORKFLOW_COORDINATOR_KIND: harness },
  };
}

function buildConfigTargets(
  harnesses: readonly AgentKind[],
  checkoutRoot: string,
  nodeExecutable: string,
  paths: UserScopeConfigPaths | undefined,
): InstallConfigTarget[] {
  const targets: InstallConfigTarget[] = [];
  if (harnesses.includes("claude")) {
    targets.push({
      harness: "claude",
      path: normalizeRelativePath(paths?.claude ?? USER_CLAUDE_CONFIG_PATH),
      key: `mcpServers.${ENGINEERING_WORKFLOW_MCP_NAME}`,
      format: "json",
      installedValue: buildUserMcpRegistration("claude", checkoutRoot, nodeExecutable),
    });
  }
  if (harnesses.includes("codex")) {
    targets.push({
      harness: "codex",
      path: normalizeRelativePath(paths?.codex ?? USER_CODEX_CONFIG_PATH),
      key: `mcp_servers.${ENGINEERING_WORKFLOW_MCP_NAME}`,
      format: "toml",
      installedValue: buildUserMcpRegistration("codex", checkoutRoot, nodeExecutable),
    });
  }
  return targets;
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
  if (requirePrivatePermissions && process.platform !== "win32" && (before.mode & 0o077) !== 0) {
    throw new Error(`Restore data permissions are too broad: ${filePath}`);
  }
  const source = readFileSync(filePath);
  const after = lstatSync(filePath);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
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
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `Restore data is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateRestoreData(value);
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
    external?: ExternalRegistrationInstallAdapter;
  },
) {
  if (context.transition.kind === "external-registration") {
    if (!adapters.external) {
      throw new Error("The executable plan requires an external-registration backend.");
    }
    return adapters.external;
  }
  if (context.transition.kind === "opaque-registration") {
    if (context.transition.stage.adapterKind === "claude-json") return adapters.claude;
    if (context.transition.stage.adapterKind === "codex-toml") return adapters.codex;
    throw new Error(
      `User-scope composition has no adapter for ${context.transition.stage.adapterKind}.`,
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

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
}
