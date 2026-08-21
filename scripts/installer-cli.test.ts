import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const CASES = [
  {
    name: "harness help",
    arguments: ["install", "--help"],
    code: 0,
    stream: "stdout",
    fragments: [/kilo\|claude\|codex\|all/, /Kilo-only default/],
  },
  {
    name: "invalid harness",
    arguments: ["install", "--harness", "unknown"],
    code: 2,
    stream: "stderr",
    fragments: [/Unsupported harness/],
  },
] as const;

test("installer entrypoints expose harness help and reject invalid harnesses", async () => {
  for (const script of ["unix-install.ts", "windows-install.ts"]) {
    for (const case_ of CASES) {
      const result = await run(script, ...case_.arguments);
      assert.equal(result.code, case_.code, `${script} ${case_.name}: ${result.stderr}`);
      for (const fragment of case_.fragments) {
        assert.match(result[case_.stream], fragment);
      }
    }
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
