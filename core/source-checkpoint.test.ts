import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  captureSourceCheckpoint,
  SourceCheckpointError,
  sourceCheckpointsEqual,
} from "./source-checkpoint.ts";

const execFileAsync = promisify(execFile);

test("tracked checkpoints are stable and ignore untracked and ignored files", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "initial"]);

    const first = await captureSourceCheckpoint(projectRoot);
    const second = await captureSourceCheckpoint(projectRoot);
    assert.equal(sourceCheckpointsEqual(first, second), true);

    await writeFile(path.join(projectRoot, "untracked.txt"), "untracked\n");
    await writeFile(path.join(projectRoot, "ignored.txt"), "ignored\n");
    const withArtifacts = await captureSourceCheckpoint(projectRoot);
    assert.equal(sourceCheckpointsEqual(first, withArtifacts), true);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("an unborn repository records an absent HEAD without losing diff state", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "tracked.txt"]);

    const checkpoint = await captureSourceCheckpoint(projectRoot);
    const second = await captureSourceCheckpoint(projectRoot);
    assert.equal(checkpoint.headId, undefined);
    assert.equal(checkpoint.stagedDiffSha256, second.stagedDiffSha256);
    assert.equal(checkpoint.unstagedTrackedDiffSha256, second.unstagedTrackedDiffSha256);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("a malformed detached HEAD fails checkpoint capture", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "tracked.txt"]);
    await git(projectRoot, ["commit", "-m", "initial"]);
    await writeFile(
      path.join(projectRoot, ".git", "HEAD"),
      "not-a-real-ref\n",
    );

    await assert.rejects(
      captureSourceCheckpoint(projectRoot),
      (error: unknown) =>
        error instanceof SourceCheckpointError &&
        error.message.includes("tracked source checkpoint"),
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("a symbolic HEAD with a corrupt branch ref fails checkpoint capture", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "tracked.txt"]);
    await git(projectRoot, ["commit", "-m", "initial"]);
    await git(projectRoot, ["checkout", "-b", "main"]);
    await writeFile(
      path.join(projectRoot, ".git", "refs", "heads", "main"),
      `${"0".repeat(40)}\n`,
    );

    await assert.rejects(
      captureSourceCheckpoint(projectRoot),
      (error: unknown) =>
        error instanceof SourceCheckpointError &&
        error.message.includes("tracked source checkpoint"),
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("staged, unstaged, staging-transition, and HEAD changes are detected", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "initial"]);
    const clean = await captureSourceCheckpoint(projectRoot);

    await writeFile(path.join(projectRoot, "tracked.txt"), "unstaged\n");
    const unstaged = await captureSourceCheckpoint(projectRoot);
    assert.notEqual(unstaged.unstagedTrackedDiffSha256, clean.unstagedTrackedDiffSha256);
    assert.equal(unstaged.stagedDiffSha256, clean.stagedDiffSha256);

    await git(projectRoot, ["add", "tracked.txt"]);
    const staged = await captureSourceCheckpoint(projectRoot);
    assert.notEqual(staged.stagedDiffSha256, clean.stagedDiffSha256);
    assert.notEqual(staged.unstagedTrackedDiffSha256, unstaged.unstagedTrackedDiffSha256);
    assert.equal(sourceCheckpointsEqual(unstaged, staged), false);

    await writeFile(path.join(projectRoot, "tracked.txt"), "committed\n");
    await git(projectRoot, ["add", "tracked.txt"]);
    await git(projectRoot, ["commit", "-m", "second"]);
    const newHead = await captureSourceCheckpoint(projectRoot);
    assert.notEqual(newHead.headId, clean.headId);
    assert.equal(newHead.stagedDiffSha256, clean.stagedDiffSha256);
    assert.equal(newHead.unstagedTrackedDiffSha256, clean.unstagedTrackedDiffSha256);
    assert.equal(sourceCheckpointsEqual(clean, newHead), false);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("binary tracked changes are hashed from the complete diff output", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "data.bin"), Buffer.from([0, 1, 2, 255]));
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "binary"]);
    const clean = await captureSourceCheckpoint(projectRoot);

    await writeFile(path.join(projectRoot, "data.bin"), Buffer.from([0, 1, 3, 255]));
    const changed = await captureSourceCheckpoint(projectRoot);
    assert.notEqual(changed.unstagedTrackedDiffSha256, clean.unstagedTrackedDiffSha256);
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("external diff configuration cannot run during checkpoint capture", async () => {
  const projectRoot = await createRepository();

  try {
    await writeFile(path.join(projectRoot, "tracked.txt"), "initial\n");
    await git(projectRoot, ["add", "."]);
    await git(projectRoot, ["commit", "-m", "initial"]);
    await git(projectRoot, ["config", "diff.external", "command-that-must-not-run"]);
    await writeFile(path.join(projectRoot, "tracked.txt"), "changed\n");

    await assert.doesNotReject(captureSourceCheckpoint(projectRoot));
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

test("capture failures are distinct and actionable", async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-failure-"));

  try {
    await assert.rejects(
      captureSourceCheckpoint(projectRoot),
      (error: unknown) =>
        error instanceof SourceCheckpointError &&
        error.message.includes("tracked source checkpoint") &&
        error.message.includes("Git exited"),
    );
  } finally {
    await rm(projectRoot, { force: true, recursive: true });
  }
});

async function createRepository(): Promise<string> {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "workflow-checkpoint-"));
  await git(projectRoot, ["init"]);
  await git(projectRoot, ["config", "user.email", "workflow@example.test"]);
  await git(projectRoot, ["config", "user.name", "Workflow Test"]);
  return projectRoot;
}

async function git(projectRoot: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, {
    cwd: projectRoot,
    windowsHide: true,
  });
}
