import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import type { SkillSnapshot } from "./model.ts";

export const MAX_BUNDLED_SKILL_BYTES = 128 * 1024;

const TOOLKIT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const BUNDLED_SKILLS_ROOT = path.join(TOOLKIT_ROOT, "skills");

export function loadBundledSkill(skillId: string): SkillSnapshot {
  const skillPath = resolveBundledSkillPath(skillId);
  const size = statFileSize(skillPath, skillId);

  if (size > MAX_BUNDLED_SKILL_BYTES) {
    throw new Error(
      `Bundled skill "${skillId}" is too large; it must be at most ${MAX_BUNDLED_SKILL_BYTES} bytes.`,
    );
  }

  let source: string;
  try {
    source = readFileSync(skillPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not load bundled skill "${skillId}" from ${skillPath}: ${errorMessage(error)}`,
    );
  }

  return createSkillSnapshot(skillId, source);
}

export function resolveBundledSkillPath(skillId: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(skillId)) {
    throw new Error(`Invalid bundled skill ID "${skillId}".`);
  }

  const skillPath = path.join(BUNDLED_SKILLS_ROOT, skillId, "SKILL.md");

  let toolkitRoot: string;
  let skillsRoot: string;
  let resolvedSkillPath: string;
  try {
    toolkitRoot = realpathSync(TOOLKIT_ROOT);
    skillsRoot = realpathSync(BUNDLED_SKILLS_ROOT);
    resolvedSkillPath = realpathSync(skillPath);
  } catch (error) {
    throw new Error(
      `Bundled skill "${skillId}" was not found under the toolkit skills directory: ${errorMessage(error)}`,
    );
  }

  if (
    !isPathInside(toolkitRoot, skillsRoot) ||
    !isPathInside(skillsRoot, resolvedSkillPath)
  ) {
    throw new Error(
      `Refusing to load bundled skill "${skillId}" outside the toolkit skills directory.`,
    );
  }

  return resolvedSkillPath;
}

export function createSkillSnapshot(
  skillId: string,
  source: string,
): SkillSnapshot {
  if (Buffer.byteLength(source, "utf8") > MAX_BUNDLED_SKILL_BYTES) {
    throw new Error(
      `Bundled skill "${skillId}" is too large; it must be at most ${MAX_BUNDLED_SKILL_BYTES} bytes.`,
    );
  }

  const body = stripFrontmatter(skillId, source);

  return {
    id: skillId,
    hash: createHash("sha256").update(body, "utf8").digest("hex"),
    body,
  };
}

function stripFrontmatter(skillId: string, source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  if (lines[0] === "---") {
    const closingIndex = lines.indexOf("---", 1);

    if (closingIndex < 0) {
      throw new Error(
        `Bundled skill "${skillId}" has malformed frontmatter: its closing delimiter is missing.`,
      );
    }

    lines.splice(0, closingIndex + 1);
  }

  const body = lines.join("\n").trim();
  if (!body) {
    throw new Error(`Bundled skill "${skillId}" contains no methodology body.`);
  }

  return body;
}

function statFileSize(skillPath: string, skillId: string): number {
  try {
    const fileStat = statSync(skillPath);
    if (!fileStat.isFile()) {
      throw new Error("the path is not a regular file");
    }

    return fileStat.size;
  } catch (error) {
    throw new Error(
      `Could not load bundled skill "${skillId}" from ${skillPath}: ${errorMessage(error)}`,
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);

  return !(
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
