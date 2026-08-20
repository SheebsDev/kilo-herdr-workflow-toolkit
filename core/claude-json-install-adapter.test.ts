import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { ClaudeJsonInstallAdapter } from "./claude-json-install-adapter.ts";
import type {
  ExecutableInstallPlan,
  OpaqueRegistrationTransition,
  TransitionAdapterContext,
} from "./executable-install-plan.ts";
import type { JsonValue } from "./model.ts";
import { hashOwnedValue } from "./ownership-manifest.ts";

test("Claude JSON adapter changes one registration and preserves unrelated data", async () => {
  const fixture = await createFixture();
  const baseline = '{"unrelated":{"keep":true},"mcpServers":{"other":{"command":"other"}}}\n';
  const targetPath = path.join(fixture.root, "claude.json");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: undefined,
    desiredValue: { command: "node", args: ["mcp/server.ts"] },
  });
  const adapter = new ClaudeJsonInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    const after = await adapter.inspect(context, signal());

    assert.equal(receipt.operation, "apply");
    assert.equal(after.semantics?.[0].valueSha256, hashOwnedValue(transition.stage.changes[0].desiredValue!));
    assert.equal(receipt.semantics?.[0].valueSha256, hashOwnedValue(transition.stage.changes[0].desiredValue!));
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      unrelated: { keep: true },
      mcpServers: {
        other: { command: "other" },
        "engineering-workflow": { command: "node", args: ["mcp/server.ts"] },
      },
    });
    await adapter.cleanup(context, prepared, "committed", signal());
  } finally {
    await fixture.cleanup();
  }
});

test("Claude JSON adapter rejects malformed configuration before mutation", async () => {
  const fixture = await createFixture();
  const targetPath = path.join(fixture.root, "claude.json");
  await writeFile(targetPath, '{"mcpServers":\n', "utf8");
  const transition = createTransition(targetPath, "ignored", {
    action: "set",
    expectedValue: undefined,
    desiredValue: { command: "node" },
  });
  const adapter = new ClaudeJsonInstallAdapter();
  const context = createContext(transition);

  try {
    await assert.rejects(adapter.inspect(context, signal()), /not valid JSON/);
    assert.equal(await readFile(targetPath, "utf8"), '{"mcpServers":\n');
  } finally {
    await fixture.cleanup();
  }
});

test("Claude JSON adapter rejects a concurrent full-resource edit", async () => {
  const fixture = await createFixture();
  const baseline = '{"mcpServers":{}}\n';
  const targetPath = path.join(fixture.root, "claude.json");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: undefined,
    desiredValue: { command: "node" },
  });
  const adapter = new ClaudeJsonInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    await writeFile(targetPath, '{"userEdit":true,"mcpServers":{}}\n', "utf8");
    await assert.rejects(adapter.apply(context, prepared, signal()), /changed before apply/);
    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      userEdit: true,
      mcpServers: {},
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Claude JSON rollback restores the entry while retaining unrelated edits", async () => {
  const fixture = await createFixture();
  const original = { command: "previous", args: ["old-server.ts"] };
  const baseline = JSON.stringify({ unrelated: { before: true }, mcpServers: { "engineering-workflow": original } }) + "\n";
  const targetPath = path.join(fixture.root, "claude.json");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: original,
    desiredValue: { command: "node", args: ["server.ts"] },
  });
  const adapter = new ClaudeJsonInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    await writeFile(
      targetPath,
      JSON.stringify({
        unrelated: { before: true, after: "user edit" },
        mcpServers: { "engineering-workflow": transition.stage.changes[0].desiredValue },
      }) + "\n",
      "utf8",
    );
    await adapter.rollback(context, receipt, signal());

    assert.deepEqual(JSON.parse(await readFile(targetPath, "utf8")), {
      unrelated: { before: true, after: "user edit" },
      mcpServers: { "engineering-workflow": original },
    });
  } finally {
    await fixture.cleanup();
  }
});

test("Claude JSON rollback refuses to overwrite a user-modified registration", async () => {
  const fixture = await createFixture();
  const baseline = '{"unrelated":true,"mcpServers":{}}\n';
  const targetPath = path.join(fixture.root, "claude.json");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: undefined,
    desiredValue: { command: "node" },
  });
  const adapter = new ClaudeJsonInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    const modified = '{"unrelated":true,"mcpServers":{"engineering-workflow":{"command":"user"}}}\n';
    await writeFile(targetPath, modified, "utf8");
    await assert.rejects(adapter.rollback(context, receipt, signal()), /modified before rollback/);
    assert.equal(await readFile(targetPath, "utf8"), modified);
  } finally {
    await fixture.cleanup();
  }
});

function createTransition(
  targetPath: string,
  baselineContent: string,
  change: {
    action: "set" | "remove" | "restore";
    expectedValue: JsonValue | undefined;
    desiredValue?: JsonValue;
  },
): OpaqueRegistrationTransition {
  const expectedValueSha256 = change.expectedValue === undefined
    ? undefined
    : hashOwnedValue(change.expectedValue);
  const desiredValue = change.desiredValue;
  const semantic = {
    semanticId: "claude-registration",
    harness: "claude" as const,
    key: "mcpServers.engineering-workflow",
    action: change.action === "remove" ? "remove" as const : "set" as const,
    valueSha256: change.action === "remove" ? undefined : hashOwnedValue(desiredValue),
    expectedValueSha256,
  };
  return {
    id: "claude-registration-transition",
    order: 0,
    kind: "opaque-registration",
    target: { root: path.dirname(targetPath), relativePath: path.basename(targetPath) },
    baseline: baselineContent === "" ? { type: "absent" } : { type: "file", sha256: sha256(baselineContent) },
    desired: { type: "opaque", adapterKind: "claude-json", semantics: [semantic] },
    mutates: true,
    dependsOn: [],
    logicalChangeIds: ["claude-registration"],
    ownershipEffects: [{ changeId: "claude-registration", action: change.action === "remove" ? "detach" : "upsert" }],
    rollbackGuard: { type: "adapter-proven-bounded-inverse", semanticIds: ["claude-registration"] },
    stage: {
      type: "adapter-prepare",
      adapterKind: "claude-json",
      changes: [{
        semanticId: "claude-registration",
        harness: "claude",
        key: "mcpServers.engineering-workflow",
        action: change.action,
        desiredValue,
        expectedValueSha256,
      }],
    },
  };
}

function createContext(transition: OpaqueRegistrationTransition): TransitionAdapterContext {
  return { transition, plan: {} as ExecutableInstallPlan };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function createFixture(): Promise<{ root: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "claude-json-adapter-"));
  await mkdir(root, { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
