import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  MCP_COORDINATOR_KIND_ENV,
  resolveGitProjectRoot,
  resolveMcpProjectContext,
} from "./mcp-project-context.ts";

const execFile = promisify(execFileCallback);

test("resolves Claude and cwd launches to the same canonical root", async () => {
  const repository = await createRepository("mcp context with spaces");
  try {
    const nested = path.join(repository, "packages", "nested");
    await mkdir(nested, { recursive: true });

    const claude = await resolveMcpProjectContext({
      cwd: nested,
      env: herdrEnvironment({
        CLAUDE_PROJECT_DIR: nested,
        [MCP_COORDINATOR_KIND_ENV]: "claude",
      }),
    });
    const codex = await resolveMcpProjectContext({
      cwd: nested,
      env: herdrEnvironment({
        [MCP_COORDINATOR_KIND_ENV]: "codex",
      }),
    });

    assert.equal(claude.projectRoot, repository);
    assert.equal(codex.projectRoot, repository);
    assert.equal(claude.origin.coordinatorKind, "claude");
    assert.equal(codex.origin.coordinatorKind, "codex");
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("canonicalizes a symlinked repository launch", async () => {
  const repository = await createRepository("mcp context symlink target");
  const parent = await mkdtemp(path.join(tmpdir(), "mcp-context-link-"));
  const linked = path.join(parent, "linked repository");

  try {
    await mkdir(path.join(repository, "nested"), { recursive: true });
    await symlink(
      repository,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    const context = await resolveMcpProjectContext({
      cwd: path.join(linked, "nested"),
      env: herdrEnvironment({ [MCP_COORDINATOR_KIND_ENV]: "codex" }),
    });

    assert.equal(context.projectRoot, repository);
  } finally {
    await rm(parent, { force: true, recursive: true });
    await rm(repository, { force: true, recursive: true });
  }
});

test("rejects a configured repository that disagrees with cwd", async () => {
  const first = await createRepository("mcp context first");
  const second = await createRepository("mcp context second");
  try {
    await assert.rejects(
      resolveMcpProjectContext({
        cwd: second,
        env: herdrEnvironment({
          CLAUDE_PROJECT_DIR: first,
          [MCP_COORDINATOR_KIND_ENV]: "claude",
        }),
      }),
      /different Git repositories.*Start the MCP server from the intended repository/,
    );
  } finally {
    await rm(first, { force: true, recursive: true });
    await rm(second, { force: true, recursive: true });
  }
});

test("rejects non-repositories before constructing context", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-context-not-git-"));
  try {
    await assert.rejects(
      resolveMcpProjectContext({
        cwd: directory,
        env: herdrEnvironment({ [MCP_COORDINATOR_KIND_ENV]: "kilo" }),
      }),
      /not inside a usable Git repository.*Run this MCP server from a Git repository/,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects missing and malformed Herdr context for every coordinator kind", async () => {
  const repository = await createRepository("mcp context Herdr");
  try {
    for (const coordinatorKind of ["kilo", "claude", "codex"] as const) {
      const base = herdrEnvironment({
        [MCP_COORDINATOR_KIND_ENV]: coordinatorKind,
      });
      for (const name of [
        "HERDR_ENV",
        "HERDR_SOCKET_PATH",
        "HERDR_PANE_ID",
        "HERDR_WORKSPACE_ID",
        MCP_COORDINATOR_KIND_ENV,
      ]) {
        const missing = { ...base };
        delete missing[name];
        await assert.rejects(
          resolveMcpProjectContext({ cwd: repository, env: missing }),
          new RegExp(name),
        );
      }
    }

    await assert.rejects(
      resolveMcpProjectContext({
        cwd: repository,
        env: herdrEnvironment({
          [MCP_COORDINATOR_KIND_ENV]: "unknown",
        }),
      }),
      /must be one of kilo, claude, or codex/,
    );
    await assert.rejects(
      resolveMcpProjectContext({
        cwd: repository,
        env: herdrEnvironment({ HERDR_PANE_ID: "pane\ninvalid" }),
      }),
      /HERDR_PANE_ID.*control characters.*malformed/,
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

test("does not invoke Git when context resolution is already cancelled", async () => {
  const repository = await createRepository("mcp context cancellation");
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  try {
    await assert.rejects(
      resolveGitProjectRoot(repository, "test path", controller.signal),
      /cancelled/,
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

async function createRepository(label: string): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), `${label}-`));
  await execFile("git", ["init", "--quiet", repository], {
    windowsHide: true,
  });
  return await realpath(repository);
}

function herdrEnvironment(
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "workflow-socket",
    HERDR_PANE_ID: "pane-origin",
    HERDR_WORKSPACE_ID: "workspace-origin",
    [MCP_COORDINATOR_KIND_ENV]: "claude",
    ...overrides,
  };
}
