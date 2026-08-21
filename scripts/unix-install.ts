import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultProfilePath,
  executeUnixInstallOperation,
} from "../core/unix-installer.ts";
import type { UnixInstallRequest } from "../core/unix-installer.ts";
import type { InstallSelection } from "../core/install-plan.ts";

interface CliArguments extends UnixInstallRequest {
  readonly skipChecks: boolean;
}

class CliUsageError extends Error {}

const command = process.argv[2];

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  main().catch((error) => {
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = error instanceof CliUsageError ? 2 : 1;
  });
}

async function main(): Promise<void> {
  if (command !== "install" && command !== "uninstall") {
    throw new CliUsageError("The Unix installer command must be install or uninstall.");
  }
  if (process.argv.slice(3).some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(`${usage(command)}\n`);
    return;
  }
  const args = parseArguments(process.argv.slice(3), command);
  if (command === "install" && !args.skipDependencies) {
    await runRepositoryCommand(args.checkoutRoot, ["ci"], "npm ci");
  }
  if (command === "install" && !args.skipChecks) {
    await runRepositoryCommand(args.checkoutRoot, ["test"], "npm test");
  }

  const result = await executeUnixInstallOperation(args);
  process.stdout.write(
    `${command === "install" ? "Committed" : "Completed"} ${args.scope} ${args.operation ?? "install"} for ${result.preflightPlan.harnesses.join(", ")}.\n`,
  );
  for (const warning of result.transaction.warnings) {
    process.stderr.write(`Warning: ${warning.message}\n`);
  }
}

function parseArguments(
  argv: readonly string[],
  commandName: "install" | "uninstall",
): CliArguments {
  let scope: "user" | "project" = "user";
  let checkoutRoot = defaultCheckoutRoot();
  let homeRoot = process.env.HOME;
  let projectRoot: string | undefined;
  let privateRestoreRoot: string | undefined;
  let profilePath: string | undefined;
  let force = false;
  let skipDependencies = false;
  let skipChecks = false;
  let update = false;
  const selections: InstallSelection[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new CliUsageError(`${argument} requires a value.`);
      index += 1;
      return argv[index];
    };
    switch (argument) {
      case "--scope": {
        const value = next();
        if (value === "global" || value === "user") scope = "user";
        else if (value === "project") scope = "project";
        else throw new CliUsageError("Scope must be global, user, or project.");
        break;
      }
      case "--checkout": {
        checkoutRoot = next();
        break;
      }
      case "--home": homeRoot = next(); break;
      case "--project": projectRoot = next(); break;
      case "--private-restore-root": privateRestoreRoot = next(); break;
      case "--profile": profilePath = next(); break;
      case "--harness": {
        const value = next();
        if (value !== "kilo" && value !== "claude" && value !== "codex" && value !== "all") {
          throw new CliUsageError(`Unsupported harness "${value}". Choose kilo, claude, codex, or all.`);
        }
        selections.push(value);
        break;
      }
      case "--force": force = true; break;
      case "--skip-dependencies": skipDependencies = true; break;
      case "--skip-checks": skipChecks = true; break;
      case "--update": update = true; break;
      case "--help":
      case "-h": break;
      default: throw new CliUsageError(`Unknown option ${argument}.\n${usage(commandName)}`);
    }
  }

  if (!homeRoot) throw new CliUsageError("A user home is required; pass --home PATH.");
  if (scope === "project" && !projectRoot) throw new CliUsageError("Project scope requires --project PATH.");
  if (commandName === "uninstall" && update) throw new CliUsageError("--update is valid only for install.");
  if (commandName === "uninstall" && skipChecks) throw new CliUsageError("--skip-checks is valid only for install.");

  return {
    operation: commandName === "uninstall" ? "uninstall" : update ? "update" : "install",
    scope,
    selections: selections.length > 0 ? selections : undefined,
    checkoutRoot: path.resolve(checkoutRoot),
    homeRoot: path.resolve(homeRoot),
    projectRoot: projectRoot ? path.resolve(projectRoot) : undefined,
    privateRestoreRoot: privateRestoreRoot ? path.resolve(privateRestoreRoot) : undefined,
    profilePath: path.resolve(profilePath ?? defaultProfilePath(path.resolve(homeRoot))),
    force,
    skipDependencies,
    skipChecks,
  };
}

export function defaultCheckoutRoot(): string {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

function usage(commandName: "install" | "uninstall"): string {
  const common = "[--scope global|user|project] [--checkout PATH] [--home PATH] [--project PATH] [--private-restore-root PATH] [--profile PATH] [--harness kilo|claude|codex|all]... [--force]";
  return commandName === "install"
    ? `Usage: unix-install ${common} [--update] [--skip-dependencies] [--skip-checks]
Omit --harness for the Kilo-only default. Selections are repeatable; all expands to kilo, claude, and codex.
User examples: --harness kilo, --harness claude, --harness codex, --harness all.
Project example: --scope project --project PATH --harness all.
--profile selects the owned shell-profile registration for user Kilo installs. Project installs may require trust in the selected harness.
Preflight checks CLIs, Node, npm, Herdr, integrations, configs, conflicts, and staging before destination mutation. --force is explicit and only used when the shared transaction can restore displaced content.`
    : `Usage: unix-install ${common}
Omit --harness to remove the Kilo-only user installation. Use --harness kilo, claude, codex, or all for selected uninstall.
Project example: --scope project --project PATH --harness all. Modified or shared owned content is retained and reported; unrelated profile and harness configuration is preserved.`;
}

async function runRepositoryCommand(
  checkoutRoot: string,
  arguments_: readonly string[],
  label: string,
): Promise<void> {
  const result = await runFile("npm", arguments_, checkoutRoot);
  if (result.code !== 0) throw new Error(`${label} failed with exit code ${result.code}.\n${result.stderr || result.stdout}`);
}

function runFile(
  executable: string,
  args: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd });
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

function formatError(error: unknown): string {
  if (error instanceof CliUsageError) return error.message;
  if (error && typeof error === "object" && "details" in error) {
    const details = (error as { details?: { rollback?: { residuals?: readonly unknown[] } } }).details;
    if ((details?.rollback?.residuals?.length ?? 0) > 0) {
      return `${error instanceof Error ? error.message : String(error)}\nResidual state was retained; inspect the transaction report before retrying.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
