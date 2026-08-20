import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const SHARED_MODULES = [
  "model.ts",
  "herdr-command.ts",
  "coordinator-notifier.ts",
  "supervisor.ts",
  "run-store.ts",
  "skill-loader.ts",
  "source-checkpoint.ts",
  "worker-profile.ts",
  "worker-service.ts",
  "workflow-service.ts",
  "workflow-contracts.ts",
  "mcp-project-context.ts",
  "ownership-manifest.ts",
  "install-plan.ts",
  "executable-install-plan.ts",
] as const;

test("host-neutral workflow modules load without Kilo plugin imports", async () => {
  for (const moduleName of SHARED_MODULES) {
    const modulePath = new URL(`./${moduleName}`, import.meta.url);
    const source = await readFile(modulePath, "utf8");

    assert.doesNotMatch(source, /@kilocode\/plugin/);
    await import(modulePath.href);
  }
});

test("skills and the launcher resolve from a copied toolkit layout", async () => {
  const payloadRoot = await mkdtemp(path.join(tmpdir(), "workflow-payload-"));
  const coreRoot = path.join(payloadRoot, "core");

  try {
    await mkdir(coreRoot, { recursive: true });
    await mkdir(path.join(payloadRoot, "skills", "fixture"), {
      recursive: true,
    });
    await mkdir(path.join(payloadRoot, "launcher"), { recursive: true });

    for (const moduleName of [
      "model.ts",
      "herdr-command.ts",
      "skill-loader.ts",
      "worker-profile.ts",
      "worker-service.ts",
    ]) {
      await copyFile(
        new URL(`./${moduleName}`, import.meta.url),
        path.join(coreRoot, moduleName),
      );
    }
    await copyFile(
      new URL("../skills/test-verification/SKILL.md", import.meta.url),
      path.join(payloadRoot, "skills", "fixture", "SKILL.md"),
    );

    const cacheBust = `?payload=${Date.now()}`;
    const copiedSkillLoader = await import(
      `${pathToFileURL(path.join(coreRoot, "skill-loader.ts"))}${cacheBust}`
    );
    const copiedWorkerService = await import(
      `${pathToFileURL(path.join(coreRoot, "worker-service.ts"))}${cacheBust}`
    );

    assert.equal(
      copiedSkillLoader.resolveBundledSkillPath("fixture"),
      path.join(payloadRoot, "skills", "fixture", "SKILL.md"),
    );
    assert.ok(copiedSkillLoader.loadBundledSkill("fixture").body.length > 0);
    assert.equal(
      copiedWorkerService.resolveWorkflowLauncherDirectory(),
      path.join(payloadRoot, "launcher"),
    );
  } finally {
    await rm(payloadRoot, { force: true, recursive: true });
  }
});
