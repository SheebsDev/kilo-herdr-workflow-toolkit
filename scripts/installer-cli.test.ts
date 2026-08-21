import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

test("Unix and Windows installer entrypoints expose the same harness help", async () => {
  for (const script of ["unix-install.ts", "windows-install.ts"]) {
    const result = await run(script, "install", "--help");
    assert.equal(result.code, 0, `${script}: ${result.stderr}`);
    assert.match(result.stdout, /kilo\|claude\|codex\|all/);
    assert.match(result.stdout, /Kilo-only default/);
  }
});

test("installer entrypoints reject invalid harnesses before any install work", async () => {
  for (const script of ["unix-install.ts", "windows-install.ts"]) {
    const result = await run(script, "install", "--harness", "unknown");
    assert.equal(result.code, 2, `${script}: ${result.stderr}`);
    assert.match(result.stderr, /Unsupported harness/);
  }
});

function run(
  script: string,
  ...arguments_: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", path.join(ROOT, "scripts", script), ...arguments_],
      { cwd: ROOT, env: { ...process.env, KILO_CONFIG_DIR: undefined }, windowsHide: true },
    );
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
