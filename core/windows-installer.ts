import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

import {
  executeProjectScopeInstallOperation,
} from "./project-scope-install.ts";
import type {
  ProjectScopeInstallRequest,
  ProjectScopeInstallResult,
} from "./project-scope-install.ts";
import type {
  ExternalRegistrationBackend,
  ExternalRegistrationReplaceRequest,
} from "./external-registration-install-adapter.ts";
import {
  executeUserScopeInstallOperation,
} from "./user-scope-install.ts";
import type {
  UserScopeInstallRequest,
  UserScopeInstallResult,
} from "./user-scope-install.ts";
import type {
  InstallOperation,
  InstallSelection,
} from "./install-plan.ts";
import { normalizeInstallHarnesses } from "./install-plan.ts";

export interface WindowsInstallRequest {
  readonly operation?: InstallOperation;
  readonly scope: "user" | "project";
  readonly selections?: InstallSelection | readonly InstallSelection[];
  readonly checkoutRoot: string;
  readonly homeRoot: string;
  readonly projectRoot?: string;
  readonly privateRestoreRoot?: string;
  readonly force?: boolean;
  readonly skipDependencies?: boolean;
  readonly nodeExecutable?: string;
  readonly environmentStorePath?: string;
  readonly signal?: AbortSignal;
}

export type WindowsInstallResult = UserScopeInstallResult | ProjectScopeInstallResult;

/**
 * Executes the Windows entrypoint through the host-neutral installation
 * transactions. The private project restore directory is created only as a
 * transaction support directory and is removed again when it remains empty.
 */
export async function executeWindowsInstallOperation(
  request: WindowsInstallRequest,
): Promise<WindowsInstallResult> {
  validateKiloDiscoveryConflicts(request);

  if (request.scope === "user") {
    const external = createWindowsEnvironmentBackend(request.environmentStorePath);
    const userRequest: UserScopeInstallRequest = {
      operation: request.operation,
      selections: request.selections,
      checkoutRoot: request.checkoutRoot,
      homeRoot: request.homeRoot,
      force: request.force,
      skipDependencies: request.skipDependencies,
      nodeExecutable: request.nodeExecutable,
      externalRegistrationBackend: external,
      signal: request.signal,
    };
    return executeUserScopeInstallOperation(userRequest);
  }

  if (!request.projectRoot) {
    throw new Error("Project scope requires a project root.");
  }

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
      signal: request.signal,
    };
    return await executeProjectScopeInstallOperation(projectRequest);
  } finally {
    if (createdRestoreRoot) {
      await rm(privateRestoreRoot, { recursive: false, force: true }).catch(() => undefined);
    }
  }
}

function validateKiloDiscoveryConflicts(request: WindowsInstallRequest): void {
  if ((request.operation ?? "install") === "uninstall") return;
  if (!normalizeInstallHarnesses(request.selections).includes("kilo")) return;
  if (request.force) return;

  const checkoutRoot = path.resolve(request.checkoutRoot);
  const processRegistration = process.env.KILO_CONFIG_DIR;
  if (
    processRegistration &&
    !samePath(processRegistration, checkoutRoot)
  ) {
    throw new Error(
      `KILO_CONFIG_DIR already points to '${processRegistration}'. Re-run with --force only after deciding to replace that registration.`,
    );
  }

  const roots = [
    path.join(request.homeRoot, ".config", "kilo"),
    path.join(request.homeRoot, ".kilo"),
    path.join(request.homeRoot, ".kilocode"),
  ];
  if (process.env.XDG_CONFIG_HOME) roots.push(path.join(process.env.XDG_CONFIG_HOME, "kilo"));
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
}

export function defaultProjectRestoreRoot(
  homeRoot: string,
  projectRoot: string,
): string {
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

/**
 * Uses a JSON file when supplied by tests, otherwise uses HKCU's Environment
 * registry key without invoking a shell. The file format is a string map so
 * unrelated user variables are preserved.
 */
export function createWindowsEnvironmentBackend(
  storePath?: string,
): ExternalRegistrationBackend {
  return storePath
    ? new JsonEnvironmentBackend(path.resolve(storePath))
    : new RegistryEnvironmentBackend();
}

class JsonEnvironmentBackend implements ExternalRegistrationBackend {
  private readonly storePath: string;

  constructor(storePath: string) {
    this.storePath = storePath;
  }

  async read(key: string): Promise<string | undefined> {
    const values = await this.readValues();
    return values[key];
  }

  async replace(request: ExternalRegistrationReplaceRequest): Promise<void> {
    const values = await this.readValues();
    if (values[request.key] !== request.expectedValue) {
      throw new Error(`Concurrent user environment change for ${request.key}.`);
    }
    if (request.value === undefined) delete values[request.key];
    else values[request.key] = request.value;

    const temporaryPath = `${this.storePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(values, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.storePath);
  }

  private async readValues(): Promise<Record<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as unknown;
      if (!isStringMap(parsed)) throw new Error("must be a string map");
      return { ...parsed };
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return {};
      throw new Error(`Environment store is not valid JSON: ${errorMessage(error)}`);
    }
  }
}

class RegistryEnvironmentBackend implements ExternalRegistrationBackend {
  async read(key: string): Promise<string | undefined> {
    if (process.platform !== "win32") {
      throw new Error("Windows user environment access requires Windows or -EnvironmentStorePath.");
    }
    const result = await runFile("reg.exe", ["query", "HKCU\\Environment", "/v", key]);
    if (result.code !== 0) return undefined;
    const line = result.stdout.split(/\r?\n/).find((candidate) =>
      new RegExp(`^\\s+${escapeRegExp(key)}\\s+REG_`, "i").test(candidate),
    );
    if (!line) return undefined;
    const match = line.match(/^\s+\S+\s+REG_\S+\s+(.*)$/i);
    return match?.[1]?.trim();
  }

  async replace(request: ExternalRegistrationReplaceRequest): Promise<void> {
    const current = await this.read(request.key);
    if (current !== request.expectedValue) {
      throw new Error(`Concurrent user environment change for ${request.key}.`);
    }
    const args = request.value === undefined
      ? ["delete", "HKCU\\Environment", "/v", request.key, "/f"]
      : [
          "add",
          "HKCU\\Environment",
          "/v",
          request.key,
          "/t",
          "REG_SZ",
          "/d",
          request.value,
          "/f",
        ];
    const result = await runFile("reg.exe", args);
    if (result.code !== 0) {
      throw new Error(`User environment update failed: ${result.stderr.trim() || result.stdout.trim()}`);
    }
  }
}

function runFile(
  executable: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function samePath(left: string, right: string): boolean {
  const first = path.resolve(left);
  const second = path.resolve(right);
  return process.platform === "win32"
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
