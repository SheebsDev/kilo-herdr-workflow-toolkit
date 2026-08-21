import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import { CodexTomlInstallAdapter } from "./codex-toml-install-adapter.ts";
import type {
  ExecutableInstallPlan,
  OpaqueRegistrationTransition,
  TransitionAdapterContext,
} from "./executable-install-plan.ts";
import type { JsonValue } from "./model.ts";
import { hashOwnedValue } from "./ownership-manifest.ts";

test("Codex TOML adapter changes one table and preserves unrelated bytes", async () => {
  const fixture = await createFixture();
  const baseline = [
    "# preserve this comment",
    "[mcp_servers.\"other\"]",
    "command = \"other\" # preserve this setting",
    "",
    "[mcp_servers.\"engineering-workflow\"]",
    "# replace only this registration",
    "command = \"old\"",
    "args = [\"old-server.ts\"]",
    "",
    "[profiles.default]",
    "model = \"gpt-5\"",
    "",
  ].join("\n");
  const targetPath = path.join(fixture.root, "config.toml");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: { command: "old", args: ["old-server.ts"] },
    desiredValue: { command: "node", args: ["mcp/server.ts"] },
  });
  const adapter = new CodexTomlInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());

    assert.equal(receipt.operation, "apply");
    assert.equal(
      receipt.semantics?.[0].valueSha256,
      hashOwnedValue(transition.stage.changes[0].desiredValue!),
    );
    assert.equal(
      await readFile(targetPath, "utf8"),
      [
        "# preserve this comment",
        "[mcp_servers.\"other\"]",
        "command = \"other\" # preserve this setting",
        "",
        "[mcp_servers.\"engineering-workflow\"]",
        "command = \"node\"",
        "args = [\"mcp/server.ts\"]",
        "",
        "[profiles.default]",
        "model = \"gpt-5\"",
        "",
      ].join("\n"),
    );
    await adapter.cleanup(context, prepared, "committed", signal());
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML adapter preserves suffix comments after an EOF table", async () => {
  const fixture = await createFixture();
  const baseline = [
    "[mcp_servers.engineering-workflow]",
    "command = \"old\"",
    "",
    "# trailing user comment",
    "",
  ].join("\n");
  const targetPath = path.join(fixture.root, "config.toml");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: { command: "old" },
    desiredValue: { command: "new" },
  });
  const adapter = new CodexTomlInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    await adapter.apply(context, prepared, signal());
    const result = await readFile(targetPath, "utf8");
    assert.match(result, /command = "new"/);
    assert.match(result, /# trailing user comment/);
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML adapter accepts quoted and dotted registration forms", async () => {
  const fixture = await createFixture();
  const forms = [
    'mcp_servers."engineering-workflow" = { command = "old", args = ["old"] }\n',
    'mcp_servers."engineering-workflow".command = "old"\nmcp_servers.engineering-workflow.args = ["old"]\n',
  ];

  try {
    for (const baseline of forms) {
      const targetPath = path.join(fixture.root, `config-${forms.indexOf(baseline)}.toml`);
      await writeFile(targetPath, baseline, "utf8");
      const transition = createTransition(targetPath, baseline, {
        action: "set",
        expectedValue: { command: "old", args: ["old"] },
        desiredValue: { command: "node", args: ["new"] },
      });
      const adapter = new CodexTomlInstallAdapter();
      const context = createContext(transition);
      const observation = await adapter.inspect(context, signal());
      const prepared = await adapter.prepare(context, observation, signal());
      await adapter.apply(context, prepared, signal());
      const result = await readFile(targetPath, "utf8");
      assert.match(result, /command = "node"/);
      assert.match(result, /args = \["new"\]/);
      await adapter.cleanup(context, prepared, "committed", signal());
    }
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML rollback restores only the registration after unrelated edits", async () => {
  const fixture = await createFixture();
  const baseline = [
    "[mcp_servers.engineering-workflow]",
    "command = \"old\"",
    "args = [\"old\"]",
    "",
    "[profiles.default]",
    "model = \"gpt-5\"",
    "",
  ].join("\n");
  const targetPath = path.join(fixture.root, "config.toml");
  await writeFile(targetPath, baseline, "utf8");
  const transition = createTransition(targetPath, baseline, {
    action: "set",
    expectedValue: { command: "old", args: ["old"] },
    desiredValue: { command: "node", args: ["new"] },
  });
  const adapter = new CodexTomlInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    await writeFile(
      targetPath,
      (await readFile(targetPath, "utf8")).replace('model = "gpt-5"', 'model = "user-edited"'),
      "utf8",
    );
    await adapter.rollback(context, receipt, signal());
    const restored = await readFile(targetPath, "utf8");
    assert.match(restored, /command = "old"/);
    assert.match(restored, /args = \["old"\]/);
    assert.match(restored, /model = "user-edited"/);
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML rollback removes a newly created empty configuration", async () => {
  const fixture = await createFixture();
  const targetPath = path.join(fixture.root, "new-config.toml");
  const transition = createTransition(targetPath, undefined, {
    action: "set",
    expectedValue: undefined,
    desiredValue: { command: "node" },
  });
  const adapter = new CodexTomlInstallAdapter();
  const context = createContext(transition);

  try {
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    assert.equal(await readFile(targetPath, "utf8"), '[mcp_servers.engineering-workflow]\ncommand = "node"\n');
    await adapter.rollback(context, receipt, signal());
    await assert.rejects(readFile(targetPath, "utf8"), { code: "ENOENT" });
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML adapter rejects malformed, ambiguous, and modified registrations", async () => {
  const fixture = await createFixture();
  try {
    const malformedPath = path.join(fixture.root, "malformed.toml");
    await writeFile(malformedPath, "[mcp_servers.engineering-workflow\n", "utf8");
    const malformed = createTransition(malformedPath, undefined, {
      action: "set",
      expectedValue: undefined,
      desiredValue: { command: "node" },
    });
    await assert.rejects(
      new CodexTomlInstallAdapter().inspect(createContext(malformed), signal()),
      /not valid TOML/,
    );

    const ambiguousPath = path.join(fixture.root, "ambiguous.toml");
    await writeFile(
      ambiguousPath,
      "[mcp_servers.engineering-workflow]\ncommand = \"old\"\n[mcp_servers.\"engineering-workflow\"]\nargs = []\n",
      "utf8",
    );
    const ambiguous = createTransition(ambiguousPath, undefined, {
      action: "set",
      expectedValue: { command: "old", args: [] },
      desiredValue: { command: "node" },
    });
    await assert.rejects(
      new CodexTomlInstallAdapter().inspect(createContext(ambiguous), signal()),
      /ambiguous duplicate definitions|duplicate key|redefine existing key/i,
    );

    const modifiedPath = path.join(fixture.root, "modified.toml");
    const baseline = "[mcp_servers.engineering-workflow]\ncommand = \"old\"\n";
    await writeFile(modifiedPath, baseline, "utf8");
    const modified = createTransition(modifiedPath, baseline, {
      action: "set",
      expectedValue: { command: "old" },
      desiredValue: { command: "node" },
    });
    const adapter = new CodexTomlInstallAdapter();
    const context = createContext(modified);
    const observation = await adapter.inspect(context, signal());
    const prepared = await adapter.prepare(context, observation, signal());
    const receipt = await adapter.apply(context, prepared, signal());
    await writeFile(modifiedPath, "[mcp_servers.engineering-workflow]\ncommand = \"user\"\n", "utf8");
    await assert.rejects(adapter.rollback(context, receipt, signal()), /modified before rollback/);
  } finally {
    await fixture.cleanup();
  }
});

test("Codex TOML adapter refuses unsafe multiline shapes", async () => {
  const fixture = await createFixture();
  try {
    const rootInlinePath = path.join(fixture.root, "root-inline.toml");
    const rootInline = "mcp_servers = {}\n";
    await writeFile(rootInlinePath, rootInline, "utf8");
    const rootInlineTransition = createTransition(rootInlinePath, rootInline, {
      action: "set",
      expectedValue: undefined,
      desiredValue: { command: "node" },
    });
    const rootInlineAdapter = new CodexTomlInstallAdapter();
    await assert.rejects(
      rootInlineAdapter.inspect(createContext(rootInlineTransition), signal()),
      /unsupported TOML representation/,
    );
    assert.equal(await readFile(rootInlinePath, "utf8"), rootInline);

    const descendantPath = path.join(fixture.root, "descendant.toml");
    const descendant = [
      "[mcp_servers.engineering-workflow]",
      "command = \"old\"",
      "[mcp_servers.engineering-workflow.env]",
      "KEY = \"value\"",
      "",
    ].join("\n");
    await writeFile(descendantPath, descendant, "utf8");
    const descendantTransition = createTransition(descendantPath, descendant, {
      action: "set",
      expectedValue: { command: "old", env: { KEY: "value" } },
      desiredValue: { command: "node" },
    });
    const descendantAdapter = new CodexTomlInstallAdapter();
    await assert.rejects(
      descendantAdapter.inspect(createContext(descendantTransition), signal()),
      /unsupported descendant table/,
    );
    assert.equal(await readFile(descendantPath, "utf8"), descendant);

    const multilinePath = path.join(fixture.root, "multiline.toml");
    const multiline = [
      'mcp_servers.engineering-workflow.args = [',
      '  "old",',
      "]",
      'mcp_servers.engineering-workflow.command = "old"',
      "",
    ].join("\n");
    await writeFile(multilinePath, multiline, "utf8");
    const multilineTransition = createTransition(multilinePath, multiline, {
      action: "set",
      expectedValue: { command: "old", args: ["old"] },
      desiredValue: { command: "node", args: ["new"] },
    });
    const multilineAdapter = new CodexTomlInstallAdapter();
    await assert.rejects(
      multilineAdapter.inspect(createContext(multilineTransition), signal()),
      /unsupported multiline value/,
    );
    assert.equal(await readFile(multilinePath, "utf8"), multiline);
  } finally {
    await fixture.cleanup();
  }
});

function createTransition(
  targetPath: string,
  baselineContent: string | undefined,
  change: {
    action: "set" | "remove" | "restore";
    expectedValue: JsonValue | undefined;
    desiredValue?: JsonValue;
  },
): OpaqueRegistrationTransition {
  const expectedValueSha256 = change.expectedValue === undefined
    ? undefined
    : hashOwnedValue(change.expectedValue);
  const semantic = {
    semanticId: "codex-registration",
    harness: "codex" as const,
    key: "mcp_servers.engineering-workflow",
    action: change.action === "remove" ? "remove" as const : "set" as const,
    valueSha256: change.action === "remove" ? undefined : hashOwnedValue(change.desiredValue!),
    expectedValueSha256,
  };
  return {
    id: `codex-registration-${Math.random().toString(16).slice(2)}`,
    order: 0,
    kind: "opaque-registration",
    target: { root: path.dirname(targetPath), relativePath: path.basename(targetPath) },
    baseline: baselineContent === undefined
      ? { type: "absent" }
      : { type: "file", sha256: sha256(baselineContent) },
    desired: { type: "opaque", adapterKind: "codex-toml", semantics: [semantic] },
    mutates: true,
    dependsOn: [],
    logicalChangeIds: ["codex-registration"],
    ownershipEffects: [{ changeId: "codex-registration", action: change.action === "remove" ? "detach" : "upsert" }],
    rollbackGuard: { type: "adapter-proven-bounded-inverse", semanticIds: ["codex-registration"] },
    stage: {
      type: "adapter-prepare",
      adapterKind: "codex-toml",
      changes: [{
        semanticId: "codex-registration",
        harness: "codex",
        key: "mcp_servers.engineering-workflow",
        action: change.action,
        desiredValue: change.desiredValue,
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
  const root = await mkdtemp(path.join(tmpdir(), "codex-toml-adapter-"));
  await mkdir(root, { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
