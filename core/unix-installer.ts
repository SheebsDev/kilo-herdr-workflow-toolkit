import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import * as path from "node:path";

import {
  executeProjectScopeInstallOperation,
} from "./project-scope-install.ts";
import type {
  ProjectScopeInstallRequest,
  ProjectScopeInstallResult,
} from "./project-scope-install.ts";
import type { InstallOperation, InstallSelection } from "./install-plan.ts";
import type { InstallPreflightBackend } from "./install-plan.ts";
import { normalizeInstallHarnesses } from "./install-plan.ts";
import {
  executeUserScopeInstallOperation,
} from "./user-scope-install.ts";
import type {
  UserScopeInstallRequest,
  UserScopeInstallResult,
} from "./user-scope-install.ts";

export interface UnixInstallRequest {
  readonly operation?: InstallOperation;
  readonly scope: "user" | "project";
  readonly selections?: InstallSelection | readonly InstallSelection[];
  readonly checkoutRoot: string;
  readonly homeRoot: string;
  readonly projectRoot?: string;
  readonly privateRestoreRoot?: string;
  readonly profilePath?: string;
  readonly force?: boolean;
  readonly skipDependencies?: boolean;
  readonly preflightBackend?: InstallPreflightBackend;
  readonly environment?: Readonly<Pick<NodeJS.ProcessEnv, "KILO_CONFIG_DIR" | "XDG_CONFIG_HOME">>;
  readonly signal?: AbortSignal;
}

export type UnixInstallResult = UserScopeInstallResult | ProjectScopeInstallResult;

export async function executeUnixInstallOperation(
  request: UnixInstallRequest,
): Promise<UnixInstallResult> {
  validateKiloDiscoveryConflicts(request);

  if (request.scope === "user") {
    const userRequest: UserScopeInstallRequest = {
      operation: request.operation,
      selections: request.selections,
      checkoutRoot: request.checkoutRoot,
      homeRoot: request.homeRoot,
      profilePath: request.profilePath,
      force: request.force,
      skipDependencies: request.skipDependencies,
      preflightBackend: request.preflightBackend,
      signal: request.signal,
    };
    return executeUserScopeInstallOperation(userRequest);
  }

  if (!request.projectRoot) throw new Error("Project scope requires a project root.");
  const privateRestoreRoot = request.privateRestoreRoot ?? defaultProjectRestoreRoot(
    request.homeRoot,
    request.projectRoot,
  );
  const createdRestoreRoot = request.privateRestoreRoot === undefined;
  if (createdRestoreRoot) await mkdir(privateRestoreRoot, { recursive: true });
  try {
    const projectRequest: ProjectScopeInstallRequest = {
      operation: request.operation,
      selections: request.selections,
      checkoutRoot: request.checkoutRoot,
      projectRoot: request.projectRoot,
      privateRestoreRoot,
      force: request.force,
      skipDependencies: request.skipDependencies,
      preflightBackend: request.preflightBackend,
      signal: request.signal,
    };
    return await executeProjectScopeInstallOperation(projectRequest);
  } finally {
    if (createdRestoreRoot) {
      await rm(privateRestoreRoot, { recursive: false, force: true }).catch(() => undefined);
    }
  }
}

export function defaultProjectRestoreRoot(homeRoot: string, projectRoot: string): string {
  const projectId = createHash("sha256")
    .update(path.resolve(projectRoot), "utf8")
    .digest("hex")
    .slice(0, 32);
  return path.join(
    path.resolve(homeRoot),
    ".config",
    "kilo-herdr-engineering-workflow",
    "project-restore-data",
    projectId,
  );
}

function validateKiloDiscoveryConflicts(request: UnixInstallRequest): void {
  if ((request.operation ?? "install") === "uninstall") return;
  if (!normalizeInstallHarnesses(request.selections).includes("kilo")) return;
  if (request.force) return;

  const checkoutRoot = path.resolve(request.checkoutRoot);
  const environment = request.environment ?? process.env;
  const registration = environment.KILO_CONFIG_DIR;
  if (registration && !samePath(registration, checkoutRoot)) {
    throw new Error(
      `KILO_CONFIG_DIR already points to '${registration}'. Re-run with --force only after deciding to replace that registration.`,
    );
  }

  const roots = [
    path.join(request.homeRoot, ".config", "kilo"),
    path.join(request.homeRoot, ".kilo"),
    path.join(request.homeRoot, ".kilocode"),
  ];
  if (environment.XDG_CONFIG_HOME) roots.push(path.join(environment.XDG_CONFIG_HOME, "kilo"));
  const conflicts = roots.flatMap((root) => {
    if (samePath(root, checkoutRoot) || !existsSync(root)) return [];
    return ["plugin", "plugins"].flatMap((directory) =>
      ["ts", "js"].flatMap((extension) => {
        const candidate = path.join(root, directory, `workflow.${extension}`);
        return existsSync(candidate) ? [candidate] : [];
      }),
    );
  });
  if (conflicts.length > 0) {
    throw new Error(
      `Existing workflow plugins would register duplicate tools: ${conflicts.join(", ")}. Re-run with --force only after resolving the duplication.`,
    );
  }

  if (request.scope === "project") {
    const profile = request.profilePath ?? defaultProfilePath(request.homeRoot);
    if (existsSync(profile) && readFileSync(profile, "utf8").includes(PROFILE_START)) {
      throw new Error(
        `Project installation would load the global workflow registration from ${profile}. Uninstall the global workflow first.`,
      );
    }
  }
}

export function defaultProfilePath(homeRoot: string): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("/zsh") || shell === "zsh") return path.join(homeRoot, ".zshrc");
  if (shell.endsWith("/bash") || shell === "bash") return path.join(homeRoot, ".bashrc");
  return path.join(homeRoot, ".profile");
}

const PROFILE_START = "# >>> kilo-herdr-engineering-workflow >>>";

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}
