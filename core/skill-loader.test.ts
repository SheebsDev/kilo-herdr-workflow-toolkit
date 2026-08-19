import assert from "node:assert/strict";
import test from "node:test";

import {
  createSkillSnapshot,
  loadBundledSkill,
  MAX_BUNDLED_SKILL_BYTES,
  resolveBundledSkillPath,
} from "./skill-loader.ts";
import { buildWorkerPrompt } from "./worker-service.ts";
import { createRun } from "./run-store.ts";
import type { ProjectContext } from "./workflow-contracts.ts";

function context(workspaceId: string, paneId: string, sessionId: string): ProjectContext {
  return {
    projectRoot: process.cwd(),
    origin: {
      workspaceId,
      paneId,
      coordinatorKind: "kilo",
      sessionId,
    },
    signal: new AbortController().signal,
    hostSession: { sessionId },
  };
}

test("bundled skills load all built-in methodologies without frontmatter", () => {
  const expected = {
    tests: "test-verification",
    "code-review": "code-review",
    readability: "readability-review",
  } as const;

  const run = createRun({
    task: "Load authoritative worker methodologies",
    context: context("workspace-skills", "pane-skills", "session-skills"),
  });

  for (const [kind, skillId] of Object.entries(expected)) {
    const skill = loadBundledSkill(skillId);
    const definition = run.workers[kind].definition;

    assert.ok(definition);
    assert.equal(definition.skill.id, skillId);
    assert.equal(definition.skill.body, skill.body);
    assert.equal(definition.skill.hash, skill.hash);
    assert.ok(!skill.body.startsWith("---"));
    assert.match(skill.hash, /^[0-9a-f]{64}$/);
  }
});

test("worker prompts inject each persisted skill body exactly once", () => {
  const run = createRun({
    task: "Build authoritative worker prompts",
    taskCardPath: ".kilo/plans/phase-1/TASK-003.md",
    context: context("workspace-prompts", "pane-prompts", "session-prompts"),
  });

  for (const kind of ["tests", "code-review", "readability"] as const) {
    const body = run.workers[kind].definition!.skill.body;
    const prompt = buildWorkerPrompt(run, kind, "Inspect the retry evidence.");

    assert.equal(prompt.split(body).length - 1, 1);
    assert.match(prompt, new RegExp(`engineering workflow ${run.id}`));
    assert.match(prompt, /Build authoritative worker prompts/);
    assert.match(prompt, /\.kilo\/plans\/phase-1\/TASK-003\.md/);
    assert.match(prompt, /ADDITIONAL INSTRUCTION FOR THIS ATTEMPT/);
    assert.match(prompt, /Inspect the retry evidence\./);
    assert.doesNotMatch(prompt, /Independently verify the implementation\./);
    assert.doesNotMatch(prompt, /Perform an independent engineering review\./);
    assert.doesNotMatch(prompt, /Review the implementation specifically as a human code reviewer\./);
  }
});

test("skill loading strips frontmatter and hashes the normalized body", () => {
  const snapshot = createSkillSnapshot(
    "test-fixture",
    "---\r\nname: fixture\r\n---\r\n\r\nReview the change.\r\n",
  );

  assert.equal(snapshot.body, "Review the change.");
  assert.equal(snapshot.id, "test-fixture");
  assert.match(snapshot.hash, /^[0-9a-f]{64}$/);
});

test("skill loading rejects missing, malformed, frontmatter-only, and oversized content", () => {
  assert.throws(
    () => loadBundledSkill("missing-skill"),
    /was not found under the toolkit skills directory/,
  );
  assert.throws(
    () => createSkillSnapshot("malformed", "---\nname: malformed\n"),
    /malformed frontmatter.*closing delimiter is missing/,
  );
  assert.throws(
    () => createSkillSnapshot("empty", "---\nname: empty\n---\n\n"),
    /contains no methodology body/,
  );
  assert.throws(
    () => createSkillSnapshot("large", "x".repeat(MAX_BUNDLED_SKILL_BYTES + 1)),
    /is too large/,
  );
});

test("bundled skill paths cannot be redirected outside the toolkit directory", () => {
  assert.throws(
    () => resolveBundledSkillPath("../outside"),
    /Invalid bundled skill ID/,
  );
  assert.throws(
    () => resolveBundledSkillPath("test-verification/SKILL"),
    /Invalid bundled skill ID/,
  );
});
