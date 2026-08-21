import { spawn } from "node:child_process";

import {
  isAgentKind,
  isWorkerKind,
} from "./model.ts";
import type {
  AgentKind,
  EnforcementMetadata,
  WorkerKind,
} from "./model.ts";

export type WorkerCapability = "tests" | "review-only";
export type PromptTransport = "herdr-prompt" | "kilo-windows-prompt-file";

export interface WorkerLaunchConfiguration {
  readonly herdrKind: AgentKind;
  readonly executable: string;
  readonly installCommand: string;
  readonly launchArguments: readonly string[];
  readonly promptTransport: PromptTransport;
  readonly capabilityProfile: string;
  readonly enforcement: EnforcementMetadata;
}

export type WorkerAgentSelection = Record<WorkerKind, AgentKind>;

export interface WorkerPreflightDependencies {
  readonly isExecutableAvailable?: (
    agentKind: AgentKind,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly readIntegrationStatus?: (signal?: AbortSignal) => Promise<string>;
}

export interface TrustedWorkerProfile {
  readonly agentKind: AgentKind;
  readonly herdrKind: AgentKind;
  readonly executable: string;
  readonly installCommand: string;
  readonly capabilities: Readonly<
    Record<
      WorkerCapability,
      Omit<
        WorkerLaunchConfiguration,
        "herdrKind" | "executable" | "installCommand" | "promptTransport"
      >
    >
  >;
}

export const TRUSTED_WORKER_PROFILES: Readonly<
  Record<AgentKind, TrustedWorkerProfile>
> = {
  kilo: {
    agentKind: "kilo",
    herdrKind: "kilo",
    executable: "kilo",
    installCommand: "Install Kilo Code and ensure the \"kilo\" command is on PATH.",
    capabilities: {
      tests: {
        launchArguments: ["--agent", "code"],
        capabilityProfile: "kilo-default",
        enforcement: {
          profile: "kilo-default",
          strength: "moderate",
          allowsWrites: true,
        },
      },
      "review-only": {
        launchArguments: ["--agent", "code"],
        capabilityProfile: "kilo-review-prompt-checkpoint",
        enforcement: {
          profile: "kilo-review-prompt-checkpoint",
          strength: "weak",
          allowsWrites: true,
        },
      },
    },
  },
  claude: {
    agentKind: "claude",
    herdrKind: "claude",
    executable: "claude",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    capabilities: {
      tests: {
        launchArguments: [],
        capabilityProfile: "claude-default",
        enforcement: {
          profile: "claude-default",
          strength: "moderate",
          allowsWrites: true,
        },
      },
      "review-only": {
        launchArguments: ["--permission-mode", "plan"],
        capabilityProfile: "claude-plan",
        enforcement: {
          profile: "claude-plan",
          strength: "strong",
          allowsWrites: false,
        },
      },
    },
  },
  codex: {
    agentKind: "codex",
    herdrKind: "codex",
    executable: "codex",
    installCommand: "npm install -g @openai/codex",
    capabilities: {
      tests: {
        launchArguments: [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "never",
        ],
        capabilityProfile: "codex-workspace-write",
        enforcement: {
          profile: "codex-workspace-write",
          strength: "strong",
          allowsWrites: true,
        },
      },
      "review-only": {
        launchArguments: [
          "--sandbox",
          "read-only",
          "--ask-for-approval",
          "never",
        ],
        capabilityProfile: "codex-read-only",
        enforcement: {
          profile: "codex-read-only",
          strength: "strong",
          allowsWrites: false,
        },
      },
    },
  },
};

export function getWorkerCapability(kind: WorkerKind): WorkerCapability {
  return kind === "tests" ? "tests" : "review-only";
}

export function resolveWorkerAgents(
  value: unknown,
): WorkerAgentSelection {
  const selections: WorkerAgentSelection = {
    tests: "kilo",
    "code-review": "kilo",
    readability: "kilo",
  };

  if (value === undefined) {
    return selections;
  }

  if (!isRecord(value)) {
    throw new Error("workerAgents must be an object with built-in worker roles.");
  }

  for (const [roleId, agentKind] of Object.entries(value)) {
    if (!isWorkerKind(roleId)) {
      throw new Error(`Unsupported workflow worker role "${roleId}".`);
    }
    if (!isAgentKind(agentKind)) {
      throw new Error(
        `Unsupported workflow worker agent kind for ${roleId}: "${String(agentKind)}".`,
      );
    }

    selections[roleId] = agentKind;
  }

  return selections;
}

export async function preflightWorkerSelections(
  selections: WorkerAgentSelection,
  signal?: AbortSignal,
  dependencies: WorkerPreflightDependencies = {},
): Promise<void> {
  const agentKinds = [...new Set(Object.values(selections))];
  const isExecutableAvailable =
    dependencies.isExecutableAvailable ?? isWorkerExecutableAvailable;
  const readIntegrationStatus =
    dependencies.readIntegrationStatus ?? readHerdrIntegrationStatus;

  let integrationStatus: Map<string, IntegrationStatus> | undefined;
  for (const agentKind of agentKinds) {
    if (!(await isExecutableAvailable(agentKind, signal))) {
      const profile = getTrustedWorkerProfile(agentKind);
      throw new Error(
        `The ${agentKind} worker executable "${profile.executable}" is unavailable. ${profile.installCommand}`,
      );
    }

    if (agentKind === "claude" || agentKind === "codex") {
      integrationStatus ??= parseIntegrationStatus(
        await readIntegrationStatus(signal),
      );
      if (integrationStatus.get(agentKind) !== "current") {
        throw new Error(
          `The Herdr ${agentKind} integration is missing or not current. Run "herdr integration install ${agentKind}" and retry.`,
        );
      }
    }
  }
}

export function getTrustedWorkerProfile(
  agentKind: AgentKind,
): TrustedWorkerProfile {
  if (!isAgentKind(agentKind)) {
    throw new Error(`Unsupported workflow worker agent kind "${agentKind}".`);
  }

  return TRUSTED_WORKER_PROFILES[agentKind];
}

export function getWorkerLaunchConfiguration(
  agentKind: AgentKind,
  kind: WorkerKind,
  platform = process.platform,
): WorkerLaunchConfiguration {
  if (!isAgentKind(agentKind)) {
    throw new Error(`Unsupported workflow worker agent kind "${agentKind}".`);
  }
  if (!isWorkerKind(kind)) {
    throw new Error(`Unsupported workflow worker role "${kind}".`);
  }

  const profile = TRUSTED_WORKER_PROFILES[agentKind];
  const capability = profile.capabilities[getWorkerCapability(kind)];

  return {
    herdrKind: profile.herdrKind,
    executable: profile.executable,
    installCommand: profile.installCommand,
    launchArguments: [...capability.launchArguments],
    promptTransport:
      agentKind === "kilo" && platform === "win32"
        ? "kilo-windows-prompt-file"
        : "herdr-prompt",
    capabilityProfile: capability.capabilityProfile,
    enforcement: { ...capability.enforcement },
  };
}

export async function preflightWorkerExecutable(
  agentKind: AgentKind,
  signal?: AbortSignal,
): Promise<void> {
  const profile = getTrustedWorkerProfile(agentKind);
  const available = await isWorkerExecutableAvailable(agentKind, signal);

  if (!available) {
    throw new Error(
      `The ${agentKind} worker executable "${profile.executable}" is unavailable. ${profile.installCommand}`,
    );
  }
}

export async function isWorkerExecutableAvailable(
  agentKind: AgentKind,
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  const profile = getTrustedWorkerProfile(agentKind);
  const probeExecutable =
    process.platform === "win32" ? "where.exe" : profile.executable;
  const probeArguments =
    process.platform === "win32" ? [profile.executable] : ["--version"];

  return new Promise((resolve, reject) => {
    const child = spawn(probeExecutable, probeArguments, {
      stdio: "ignore",
      windowsHide: true,
      signal,
    });
    let settled = false;
    const finish = (available: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(available);
    };

    child.once("error", (error) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }

      finish(false);
    });
    child.once("close", (code) => finish(code === 0));
  });
}

export type IntegrationStatus = "current" | "outdated" | "not-installed";

export function parseIntegrationStatus(
  output: string,
): Map<string, IntegrationStatus> {
  const statuses = new Map<string, IntegrationStatus>();

  for (const line of output.split(/\r?\n/)) {
    const match = line
      .trim()
      .match(/^([a-z][a-z0-9-]*):\s+(current|outdated|not installed)\b/i);
    if (!match) {
      continue;
    }

    const status = match[2].toLowerCase();
    statuses.set(
      match[1].toLowerCase(),
      status === "current"
        ? "current"
        : status === "outdated"
          ? "outdated"
          : "not-installed",
    );
  }

  return statuses;
}

async function readHerdrIntegrationStatus(
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.HERDR_BIN_PATH || "herdr",
      ["integration", "status"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal,
      },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      error ? reject(error) : resolve(stdout.trim());
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) {
        finish();
      } else {
        finish(
          new Error(
            [
              `Herdr integration status exited with code ${code}.`,
              stderr.trim(),
            ]
              .filter(Boolean)
              .join("\n"),
          ),
        );
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
