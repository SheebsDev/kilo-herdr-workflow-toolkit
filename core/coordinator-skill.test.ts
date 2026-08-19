import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const skillPath = path.join(repositoryRoot, "skills", "implement-task", "SKILL.md");
const commandPath = path.join(repositoryRoot, "command", "implement-task.md");

test("canonical implement-task skill has valid metadata and coordinator rules", () => {
  const source = readFileSync(skillPath, "utf8");
  const { frontmatter, body } = splitFrontmatter(source);

  assert.equal(frontmatter.name, "implement-task");
  assert.match(frontmatter.description ?? "", /Kilo, Claude Code, or Codex/);
  assert.match(body, /`workflow_start`/);
  for (const operation of [
    "workflow_status",
    "workflow_send",
    "workflow_stop",
    "workflow_retry",
  ]) {
    assert.match(body, new RegExp("`" + operation + "`"));
  }
  assert.match(body, /exact Herdr pane/);
  assert.match(body, /Notifications are persisted\s+before delivery/);
  assert.match(body, /same coordinator kind in the same Herdr pane/);
  assert.match(body, /Closing the active Kilo, Claude Code, or Codex\s+host pauses/);
  assert.match(body, /exact `runId`/);
  assert.match(body, /do not poll `workflow_status`/);
  assert.match(body, /skills\/test-verification\/SKILL\.md/);
});

test("Kilo implement-task command is a thin canonical-skill entrypoint", () => {
  const command = readFileSync(commandPath, "utf8");
  const { frontmatter, body } = splitFrontmatter(command);

  assert.equal(frontmatter.agent, "code");
  assert.match(body, /canonical `implement-task` Agent Skill/);
  assert.match(body, /skills\/implement-task\/SKILL\.md/);
  assert.doesNotMatch(body, /workflow_(?:start|status|send|stop|retry)/);
  assert.doesNotMatch(body, /^##?\s+\d+\./m);
  assert.ok(body.trim().split(/\r?\n/).length <= 8);
});

test("reviewer skills remain independently discoverable and are not duplicated in the command", () => {
  const command = readFileSync(commandPath, "utf8");

  for (const skillId of ["test-verification", "code-review", "readability-review"]) {
    const reviewerSkill = path.join(repositoryRoot, "skills", skillId, "SKILL.md");
    const source = readFileSync(reviewerSkill, "utf8");
    assert.match(source, new RegExp(`^name: ${skillId}$`, "m"));
    assert.match(source, /# (?:Test Verification|Code Review|Human Readability Review)/);
    assert.doesNotMatch(command, new RegExp(`skills/${skillId}/SKILL\\.md`));
  }
});

function splitFrontmatter(source: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  assert.equal(lines[0], "---");
  const closingIndex = lines.indexOf("---", 1);
  assert.ok(closingIndex > 0);

  const frontmatter: Record<string, string> = {};
  for (const line of lines.slice(1, closingIndex)) {
    const separator = line.indexOf(":");
    assert.ok(separator > 0);
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^"|"$/g, "");
    frontmatter[key] = value;
  }

  return {
    frontmatter,
    body: lines.slice(closingIndex + 1).join("\n").trim(),
  };
}
