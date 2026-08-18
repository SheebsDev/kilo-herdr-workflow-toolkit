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
  const profile = getTrustedWorkerProfile(agentKind);
  const probeExecutable =
    process.platform === "win32" ? "where.exe" : profile.executable;
  const probeArguments =
    process.platform === "win32" ? [profile.executable] : ["--version"];

  return new Promise((resolve) => {
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

    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}
