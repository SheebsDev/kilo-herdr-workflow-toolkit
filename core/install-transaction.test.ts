import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  compileExecutableInstallPlan,
} from "./executable-install-plan.ts";
import type {
  ExecutableInstallPlan,
  InstallTransition,
  InstallTransitionAdapter,
  ObservedOpaqueSemanticState,
  OpaqueResourcePostimage,
  PreparedTransition,
  PreparedTransitionDisposition,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";
import type { InstallPlan, PlannedOwnedChange } from "./install-plan.ts";
import {
  InstallTransactionError,
  executeInstallTransaction,
} from "./install-transaction.ts";
import {
  createOwnershipManifest,
  hashOwnedValue,
} from "./ownership-manifest.ts";
import type { OwnershipManifest } from "./ownership-manifest.ts";

const PROJECTED_AT = "2026-08-20T12:00:00.000Z";

test("fresh, update, partial uninstall, and full uninstall plans commit through fake adapters", async () => {
  for (const [name, plan] of [
    ["fresh", makeFreshFilePlan("matrix-fresh")],
    ["dependency", makeFreshDependencyPlan("matrix-dependency")],
    ["update", makeUpdateFilePlan("matrix-update")],
    ["partial-uninstall", makePartialUninstallPlan("matrix-partial")],
    ["full-uninstall", makeFullUninstallPlan("matrix-full")],
  ] as const) {
    const adapter = new FakeTransitionAdapter(plan);

    const result = await executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
    });

    assert.equal(result.committed, true, name);
    assert.deepEqual(result.intentTransitionIds, mutatingIds(plan), name);
    assert.deepEqual(result.appliedTransitionIds, mutatingIds(plan), name);
    assert.deepEqual(result.cleanupErrors, [], name);
    assert.deepEqual(
      adapter.cleanupCalls.map((call) => call.disposition),
      mutatingIds(plan).map(() => "committed").reverse(),
      name,
    );
    assertPlanAtDesiredState(plan, adapter);
  }
});

test("invalid plans are rejected before adapters resolve or staging begins", async () => {
  let resolutions = 0;

  await assert.rejects(
    executeInstallTransaction({
      plan: { schemaVersion: 999 },
      resolveAdapter: () => {
        resolutions += 1;
        throw new Error("must not resolve");
      },
    }),
    (error: unknown) => {
      assertTransactionError(error, "validation");
      return true;
    },
  );
  assert.equal(resolutions, 0);
});

test("staging failure cleans attempted stages and changes no live resource", async () => {
  const plan = makeFreshFilePlan("stage-failure");
  const adapter = new FakeTransitionAdapter(plan);
  const manifest = plan.transitions.find((transition) => transition.kind === "ownership-manifest")!;
  adapter.prepareModes.set(manifest.id, "throw");

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "staging");
      assert.equal(details.rollback.attempted, false);
      assert.equal(details.rollback.complete, true);
      assert.deepEqual(details.intentTransitionIds, []);
      return true;
    },
  );

  assert.equal(adapter.calls.some((call) => call.startsWith("apply:")), false);
  assertPlanAtBaselineState(plan, adapter);
  assert.deepEqual(
    adapter.cleanupCalls.map((call) => [call.transitionId, call.prepared]),
    [
      [manifest.id, false],
      [plan.transitions.find((transition) => transition.kind === "file")!.id, true],
    ],
  );
});

test("cancellation during staging changes no live state and uses an uncancelled cleanup signal", async () => {
  const plan = makeFreshFilePlan("stage-cancel");
  const adapter = new FakeTransitionAdapter(plan);
  const controller = new AbortController();
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  adapter.afterPrepare.set(file.id, () => controller.abort(new Error("cancel staging")));

  await assert.rejects(
    executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
      signal: controller.signal,
    }),
    (error: unknown) => {
      const details = assertTransactionError(error, "staging");
      assert.match(details.cause.message, /cancel staging/);
      assert.equal(details.rollback.attempted, false);
      return true;
    },
  );

  assert.equal(adapter.calls.some((call) => call.startsWith("apply:")), false);
  assert.ok(adapter.cleanupSignals.length > 0);
  assert.equal(adapter.cleanupSignals.every((aborted) => !aborted), true);
  assertPlanAtBaselineState(plan, adapter);
});

test("the precondition barrier rejects a concurrent change before the first mutation", async () => {
  const plan = makeFreshFilePlan("barrier-change");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  const manifest = plan.transitions.find((transition) => transition.kind === "ownership-manifest")!;
  adapter.afterPrepare.set(manifest.id, () => {
    adapter.setObservation(file.id, {
      transitionId: file.id,
      state: { type: "file", sha256: sha256("concurrent") },
    });
  });

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "precondition");
      assert.equal(details.rollback.attempted, false);
      return true;
    },
  );

  assert.equal(adapter.calls.some((call) => call.startsWith("apply:")), false);
  assert.equal(adapter.observation(file.id).state.type, "file");
});

test("cancellation after the barrier prevents all forward adapter invocation", async () => {
  const plan = makeFreshFilePlan("cancel-before-apply");
  const adapter = new FakeTransitionAdapter(plan);
  const controller = new AbortController();
  const manifest = plan.transitions.find((transition) => transition.kind === "ownership-manifest")!;
  adapter.afterInspect.set(`${manifest.id}:2`, () => {
    controller.abort(new Error("cancel before apply"));
  });

  await assert.rejects(
    executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
      signal: controller.signal,
    }),
    (error: unknown) => {
      const details = assertTransactionError(error, "precondition");
      assert.deepEqual(details.intentTransitionIds, []);
      assert.equal(details.rollback.attempted, false);
      return true;
    },
  );
  assert.equal(adapter.calls.some((call) => call.startsWith("apply:")), false);
});

test("throw-before-write still records intent and recognizes the unchanged baseline", async () => {
  const plan = makeFreshFilePlan("throw-before-write");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  adapter.applyModes.set(file.id, "throw-before-write");

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.deepEqual(details.intentTransitionIds, [file.id]);
      assert.equal(details.rollback.complete, true);
      return true;
    },
  );

  assert.equal(adapter.calls.includes(`rollback:${file.id}`), false);
  assert.deepEqual(adapter.observation(file.id).state, file.baseline);
});

test("a first post-write inspection failure is retried during reconciliation", async () => {
  const plan = makeFreshFilePlan("inspect-retry");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  adapter.applyModes.set(file.id, "write-then-throw");
  adapter.failInspectAt.set(file.id, new Set([3]));

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.equal(details.rollback.complete, true);
      assert.equal(details.rollback.errors.some((issue) => issue.operation === "inspect"), true);
      return true;
    },
  );

  assert.ok((adapter.inspectCounts.get(file.id) ?? 0) > 3, "expected inspection after the injected failure");
  assert.deepEqual(adapter.observation(file.id).state, file.baseline);
});

test("an explicit success receipt without the planned write still fails", async () => {
  const plan = makeFreshFilePlan("receipt-without-write");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  adapter.applyModes.set(file.id, "success-without-write");

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.match(details.cause.message, /postcondition/);
      assert.equal(details.rollback.complete, true);
      return true;
    },
  );
  assert.equal(adapter.calls.includes(`rollback:${file.id}`), false);
});

test("cancellation after one invocation rolls it back and starts no later transition", async () => {
  const plan = makeFreshFilePlan("cancel-after-apply");
  const adapter = new FakeTransitionAdapter(plan);
  const controller = new AbortController();
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  const manifest = plan.transitions.find((transition) => transition.kind === "ownership-manifest")!;
  adapter.afterApply.set(file.id, () => controller.abort(new Error("cancel after apply")));

  await assert.rejects(
    executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
      signal: controller.signal,
    }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.deepEqual(details.intentTransitionIds, [file.id]);
      assert.equal(details.rollback.complete, true);
      return true;
    },
  );

  assert.equal(adapter.calls.includes(`apply:${manifest.id}`), false);
  assert.equal(adapter.rollbackSignals.every((aborted) => !aborted), true);
  assert.deepEqual(adapter.observation(file.id).state, file.baseline);
});

test("ownership manifest write-then-throw rolls back metadata and resources in reverse order", async () => {
  const plan = makeFreshFilePlan("manifest-failure");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  const manifest = plan.transitions.find((transition) => transition.kind === "ownership-manifest")!;
  adapter.applyModes.set(manifest.id, "write-then-throw");

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.deepEqual(details.intentTransitionIds, [file.id, manifest.id]);
      assert.equal(details.rollback.complete, true);
      return true;
    },
  );

  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("rollback:")),
    [`rollback:${manifest.id}`, `rollback:${file.id}`],
  );
  assertPlanAtBaselineState(plan, adapter);
});

test("restore-data failure rolls back private metadata and the opaque resource", async () => {
  const plan = makeForcedOpaquePlan("restore-failure");
  const adapter = new FakeTransitionAdapter(plan);
  const opaque = plan.transitions.find((transition) => transition.kind === "opaque-registration")!;
  const restore = plan.transitions.find((transition) => transition.kind === "restore-data")!;
  adapter.applyModes.set(restore.id, "write-then-throw");

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.equal(details.rollback.complete, true);
      return true;
    },
  );

  assert.deepEqual(
    adapter.calls.filter((call) => call.startsWith("rollback:")),
    [`rollback:${restore.id}`, `rollback:${opaque.id}`],
  );
  assertPlanAtBaselineState(plan, adapter);
});

test("rollback errors remain reported even when the restored baseline is verified", async () => {
  for (const scenario of [
    { name: "rollback-write-throw", rollbackMode: "restore-then-throw" },
    { name: "rollback-without-write", rollbackMode: "success-without-write" },
  ] as const) {
    const plan = makeFreshFilePlan(scenario.name);
    const adapter = new FakeTransitionAdapter(plan);
    const file = plan.transitions.find((transition) => transition.kind === "file")!;
    adapter.applyModes.set(file.id, "write-then-throw");
    adapter.rollbackModes.set(file.id, scenario.rollbackMode);

    await assert.rejects(
      executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
      (error: unknown) => {
        const details = assertTransactionError(error, "apply");
        if (scenario.rollbackMode === "restore-then-throw") {
          assert.equal(details.rollback.complete, true, scenario.name);
          assert.equal(
            details.rollback.errors.some((issue) => issue.operation === "rollback"),
            true,
            scenario.name,
          );
        } else {
          assert.equal(details.rollback.complete, false, scenario.name);
          assert.equal(
            details.rollback.residuals[0].reason,
            "transaction-postimage-retained",
            scenario.name,
          );
        }
        return true;
      },
    );
    if (scenario.rollbackMode === "restore-then-throw") {
      assert.deepEqual(adapter.observation(file.id).state, file.baseline, scenario.name);
    }
  }
});

test("bounded opaque rollback preserves an unrelated concurrent physical edit", async () => {
  const plan = makeForcedOpaquePlan("bounded-opaque");
  const adapter = new FakeTransitionAdapter(plan);
  const controller = new AbortController();
  const opaque = plan.transitions.find((transition) => transition.kind === "opaque-registration")!;
  const desired = opaque.desired as OpaqueResourcePostimage;
  const concurrentState = { type: "file" as const, sha256: sha256("unrelated edit") };
  adapter.preserveConcurrentOpaque.add(opaque.id);
  adapter.afterInspect.set(`${opaque.id}:3`, () => {
    adapter.setObservation(opaque.id, {
      transitionId: opaque.id,
      state: concurrentState,
      semantics: desiredSemanticStates(desired),
    });
    controller.abort(new Error("cancel with concurrent edit"));
  });

  await assert.rejects(
    executeInstallTransaction({
      plan,
      resolveAdapter: () => adapter,
      signal: controller.signal,
    }),
    (error: unknown) => {
      const details = assertTransactionError(error, "apply");
      assert.equal(details.rollback.complete, true);
      assert.deepEqual(details.rollback.residuals, []);
      return true;
    },
  );

  const final = adapter.observation(opaque.id);
  assert.deepEqual(final.state, concurrentState);
  assert.deepEqual(final.semantics, baselineSemantics(desired));
});

test("final revalidation prevents commit after a provisional resource changes", async () => {
  const plan = makeFreshFilePlan("final-revalidation");
  const adapter = new FakeTransitionAdapter(plan);
  const file = plan.transitions.find((transition) => transition.kind === "file")!;
  adapter.afterInspect.set(`${file.id}:3`, () => {
    adapter.setObservation(file.id, {
      transitionId: file.id,
      state: { type: "file", sha256: sha256("changed before commit") },
    });
  });

  await assert.rejects(
    executeInstallTransaction({ plan, resolveAdapter: () => adapter }),
    (error: unknown) => {
      const details = assertTransactionError(error, "verification");
      assert.equal(details.committed, false);
      assert.equal(details.rollback.complete, false);
      assert.deepEqual(details.rollback.residuals.map((residual) => residual.transitionId), [file.id]);
      return true;
    },
  );
});

test("an abort observed only after the commit point does not retroactively roll back", async () => {
  const plan = makeFreshFilePlan("post-commit-abort");
  const adapter = new FakeTransitionAdapter(plan);
  const controller = new AbortController();
  adapter.beforeCleanup = () => controller.abort(new Error("late abort"));

  const result = await executeInstallTransaction({
    plan,
    resolveAdapter: () => adapter,
    signal: controller.signal,
  });

  assert.equal(result.committed, true);
  assert.equal(adapter.calls.some((call) => call.startsWith("rollback:")), false);
  assertPlanAtDesiredState(plan, adapter);
});

type ApplyMode =
  | "throw-before-write"
  | "write-then-throw"
  | "success-without-write";
type RollbackMode = "restore-then-throw" | "success-without-write";

class FakeTransitionAdapter implements InstallTransitionAdapter {
  readonly calls: string[] = [];
  readonly cleanupCalls: Array<{
    transitionId: string;
    prepared: boolean;
    disposition: PreparedTransitionDisposition;
  }> = [];
  readonly cleanupSignals: boolean[] = [];
  readonly rollbackSignals: boolean[] = [];
  readonly inspectCounts = new Map<string, number>();
  readonly prepareModes = new Map<string, "throw">();
  readonly applyModes = new Map<string, ApplyMode>();
  readonly rollbackModes = new Map<string, RollbackMode>();
  readonly failInspectAt = new Map<string, Set<number>>();
  readonly afterPrepare = new Map<string, () => void>();
  readonly afterApply = new Map<string, () => void>();
  readonly afterInspect = new Map<string, () => void>();
  readonly preserveConcurrentOpaque = new Set<string>();
  beforeCleanup?: () => void;

  private readonly observations = new Map<string, TransitionObservation>();
  private cleanupStarted = false;

  constructor(plan: ExecutableInstallPlan) {
    for (const transition of plan.transitions) {
      this.observations.set(transition.id, {
        transitionId: transition.id,
        state: clone(transition.baseline),
      });
    }
  }

  async inspect(
    context: TransitionAdapterContext,
    _signal: AbortSignal,
  ): Promise<TransitionObservation> {
    const id = context.transition.id;
    const count = (this.inspectCounts.get(id) ?? 0) + 1;
    this.inspectCounts.set(id, count);
    this.calls.push(`inspect:${id}`);
    if (this.failInspectAt.get(id)?.has(count)) {
      throw new Error(`inspect failure ${id}:${count}`);
    }
    const result = clone(this.observation(id));
    this.afterInspect.get(`${id}:${count}`)?.();
    return result;
  }

  async prepare(
    context: TransitionAdapterContext,
    _observation: TransitionObservation,
    _signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const id = context.transition.id;
    this.calls.push(`prepare:${id}`);
    if (this.prepareModes.get(id) === "throw") {
      throw new Error(`prepare failure ${id}`);
    }
    const prepared = {
      transitionId: id,
      postimage: clone(context.transition.desired),
      stagingHandle: `staged-${id}`,
    };
    this.afterPrepare.get(id)?.();
    return prepared;
  }

  async apply(
    context: TransitionAdapterContext,
    _prepared: PreparedTransition,
    _signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = context.transition;
    const id = transition.id;
    const before = clone(this.observation(id).state);
    const mode = this.applyModes.get(id);
    this.calls.push(`apply:${id}`);
    if (mode === "throw-before-write") {
      throw new Error(`apply failed before write ${id}`);
    }
    if (mode !== "success-without-write") {
      this.setObservation(id, desiredObservation(transition));
    }
    this.afterApply.get(id)?.();
    if (mode === "write-then-throw") {
      throw new Error(`apply failed after write ${id}`);
    }
    return {
      transitionId: id,
      operation: "apply",
      before,
      after: clone(transition.desired),
      semantics: transition.desired.type === "opaque"
        ? desiredSemanticStates(transition.desired)
        : undefined,
    };
  }

  async rollback(
    context: TransitionAdapterContext,
    _receipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = context.transition;
    const id = transition.id;
    const mode = this.rollbackModes.get(id);
    const current = clone(this.observation(id));
    this.calls.push(`rollback:${id}`);
    this.rollbackSignals.push(signal.aborted);

    if (mode !== "success-without-write") {
      if (
        transition.desired.type === "opaque" &&
        this.preserveConcurrentOpaque.has(id) &&
        current.state.type !== "opaque"
      ) {
        this.setObservation(id, {
          transitionId: id,
          state: current.state,
          semantics: baselineSemantics(transition.desired),
        });
      } else {
        this.setObservation(id, {
          transitionId: id,
          state: clone(transition.baseline),
        });
      }
    }
    if (mode === "restore-then-throw") {
      throw new Error(`rollback failed after restore ${id}`);
    }

    const after = clone(this.observation(id));
    return {
      transitionId: id,
      operation: "rollback",
      before: clone(transition.desired),
      after: after.state,
      semantics: after.semantics,
    };
  }

  async cleanup(
    context: TransitionAdapterContext,
    prepared: PreparedTransition | undefined,
    disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    if (!this.cleanupStarted) {
      this.cleanupStarted = true;
      this.beforeCleanup?.();
    }
    this.calls.push(`cleanup:${context.transition.id}`);
    this.cleanupSignals.push(signal.aborted);
    this.cleanupCalls.push({
      transitionId: context.transition.id,
      prepared: prepared !== undefined,
      disposition,
    });
  }

  observation(transitionId: string): TransitionObservation {
    const observation = this.observations.get(transitionId);
    assert.ok(observation, `Missing fake observation for ${transitionId}`);
    return observation;
  }

  setObservation(transitionId: string, observation: TransitionObservation): void {
    this.observations.set(transitionId, clone(observation));
  }
}

function makeFreshFilePlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "payload/runtime.js";
  const desiredHash = sha256("runtime-v1");
  const plan = basePreflight(roots, {
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath: resolveRelative(roots.destination, relativePath),
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: desiredHash,
      size: 10,
    }],
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, relativePath),
      relativePath,
      exists: false,
      ownership: "unrelated",
    }],
    ownedChanges: [fileChange(
      "runtime-file",
      roots.destination,
      relativePath,
      "create",
      desiredHash,
    )],
  });
  return compile(plan, roots);
}

function makeFreshDependencyPlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "payload/node_modules";
  const desiredHash = sha256("prepared dependency tree");
  const plan = basePreflight(roots, {
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, relativePath),
      relativePath,
      exists: false,
      ownership: "unrelated",
    }],
    ownedChanges: [{
      id: "runtime-dependencies",
      artifactType: "dependency",
      harnesses: ["kilo"],
      destinationPath: resolveRelative(roots.destination, relativePath),
      destinationRelativePath: relativePath,
      action: "create",
      sha256: desiredHash,
      dependencyInput: {
        packageManager: "npm",
        packageNames: ["@kilocode/plugin", "zod"],
        lockfilePath: "payload/package-lock.json",
      },
    }],
  });
  return compile(plan, roots);
}

function makeUpdateFilePlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "payload/runtime.js";
  const oldHash = sha256("runtime-v1");
  const desiredHash = sha256("runtime-v2");
  const manifest = singleFileManifest(relativePath, oldHash, ["kilo"]);
  const plan = basePreflight(roots, {
    operation: "update",
    sourceInventory: [{
      artifactType: "shared-runtime",
      sourcePath: "core/runtime.js",
      destinationPath: resolveRelative(roots.destination, relativePath),
      destinationRelativePath: relativePath,
      harnesses: ["kilo"],
      sha256: desiredHash,
      size: 10,
    }],
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, relativePath),
      relativePath,
      exists: true,
      kind: "file",
      sha256: oldHash,
      ownership: "owned-unchanged",
      expectedSha256: oldHash,
    }],
    ownedChanges: [fileChange(
      "runtime-file",
      roots.destination,
      relativePath,
      "replace",
      desiredHash,
    )],
  });
  return compile(plan, roots, manifest);
}

function makeFullUninstallPlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "payload/runtime.js";
  const installedHash = sha256("runtime-v1");
  const manifest = singleFileManifest(relativePath, installedHash, ["kilo"]);
  const plan = basePreflight(roots, {
    operation: "uninstall",
    sourceInventory: [],
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, relativePath),
      relativePath,
      exists: true,
      kind: "file",
      sha256: installedHash,
      ownership: "owned-unchanged",
      expectedSha256: installedHash,
    }],
    ownedChanges: [fileChange(
      "runtime-file",
      roots.destination,
      relativePath,
      "remove",
      installedHash,
    )],
  });
  return compile(plan, roots, manifest);
}

function makePartialUninstallPlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "payload/runtime.js";
  const installedHash = sha256("runtime-v1");
  const manifest = singleFileManifest(relativePath, installedHash, ["kilo", "claude"]);
  const plan = basePreflight(roots, {
    operation: "uninstall",
    sourceInventory: [],
    destinationPreconditions: [{
      path: resolveRelative(roots.destination, relativePath),
      relativePath,
      exists: true,
      kind: "file",
      sha256: installedHash,
      ownership: "owned-unchanged",
      expectedSha256: installedHash,
    }],
    ownedChanges: [{
      ...fileChange(
        "runtime-file",
        roots.destination,
        relativePath,
        "preserve",
        installedHash,
      ),
      harnesses: ["kilo", "claude"],
    }],
  });
  return compile(plan, roots, manifest);
}

function makeForcedOpaquePlan(name: string): ExecutableInstallPlan {
  const roots = fixtureRoots(name);
  const relativePath = "config/claude.json";
  const absolutePath = resolveRelative(roots.destination, relativePath);
  const baselineHash = sha256("config baseline");
  const previousValue = { command: "old" };
  const desiredValue = { command: "node", args: ["server.ts"] };
  const change: PlannedOwnedChange = {
    id: "claude-registration",
    artifactType: "config-registration",
    harnesses: ["claude"],
    destinationPath: absolutePath,
    destinationRelativePath: relativePath,
    action: "replace",
    sha256: hashOwnedValue(desiredValue),
    desiredValue,
    semanticKey: "mcpServers.engineering-workflow",
    adapterKind: "claude-json",
    ownershipState: "unrelated",
  };
  const plan = basePreflight(roots, {
    harnesses: ["claude"],
    sourceInventory: [],
    destinationPreconditions: [{
      path: absolutePath,
      relativePath,
      exists: true,
      kind: "file",
      sha256: baselineHash,
      ownership: "unrelated",
    }],
    ownedChanges: [change],
    rollbackInputs: [{
      type: "config",
      path: absolutePath,
      key: change.semanticKey!,
      existed: true,
      sha256: hashOwnedValue(previousValue),
      value: previousValue,
    }],
  });
  return compile(plan, roots);
}

function basePreflight(
  roots: ReturnType<typeof fixtureRoots>,
  overrides: Partial<InstallPlan>,
): InstallPlan {
  return {
    operation: "install",
    scope: "project",
    harnesses: ["kilo"],
    checkoutRoot: roots.checkout,
    destinationRoot: roots.destination,
    sourceInventory: [],
    destinationPreconditions: [],
    requiredParentDirectories: [],
    ownedChanges: [],
    rollbackInputs: [],
    prerequisites: [],
    warnings: [],
    ...overrides,
  };
}

function compile(
  preflightPlan: InstallPlan,
  roots: ReturnType<typeof fixtureRoots>,
  manifest?: OwnershipManifest,
): ExecutableInstallPlan {
  return compileExecutableInstallPlan({
    preflightPlan,
    projectedAt: PROJECTED_AT,
    ownership: {
      manifest,
      manifestResource: {
        target: {
          root: roots.destination,
          relativePath: ".agents/toolkits/kilo-herdr-engineering-workflow/ownership.json",
        },
        baseline: manifest
          ? { type: "file", sha256: serializedHash(manifest) }
          : { type: "absent" },
        requiredParentDirectories: [],
      },
      restoreDataResource: {
        target: { root: roots.privateRoot, relativePath: "restore-data.json" },
        baseline: { type: "absent" },
        requiredParentDirectories: [],
      },
    },
  });
}

function singleFileManifest(
  relativePath: string,
  hash: string,
  harnesses: Array<"kilo" | "claude">,
): OwnershipManifest {
  return createOwnershipManifest({
    manifestId: "transaction-fixture-manifest",
    scope: "project",
    harnesses,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    files: [{
      id: "runtime-file",
      artifactType: "shared-runtime",
      harnesses,
      path: relativePath,
      sha256: hash,
    }],
  });
}

function fileChange(
  id: string,
  destinationRoot: string,
  relativePath: string,
  action: "create" | "replace" | "remove" | "preserve",
  hash: string,
): PlannedOwnedChange {
  return {
    id,
    artifactType: "shared-runtime",
    harnesses: ["kilo"],
    sourcePath: action === "create" || action === "replace" ? "core/runtime.js" : undefined,
    destinationPath: resolveRelative(destinationRoot, relativePath),
    destinationRelativePath: relativePath,
    action,
    sha256: hash,
  };
}

function desiredObservation(transition: InstallTransition): TransitionObservation {
  return {
    transitionId: transition.id,
    state: clone(transition.desired),
    semantics: transition.desired.type === "opaque"
      ? desiredSemanticStates(transition.desired)
      : undefined,
  };
}

function baselineSemantics(
  desired: OpaqueResourcePostimage,
): ObservedOpaqueSemanticState[] {
  return desired.semantics.map((semantic) => ({
    semanticId: semantic.semanticId,
    harness: semantic.harness,
    key: semantic.key,
    state: semantic.expectedValueSha256 === undefined ? "absent" : "value",
    valueSha256: semantic.expectedValueSha256,
  }));
}

function desiredSemanticStates(
  desired: OpaqueResourcePostimage,
): ObservedOpaqueSemanticState[] {
  return desired.semantics.map((semantic) => ({
    semanticId: semantic.semanticId,
    harness: semantic.harness,
    key: semantic.key,
    state: semantic.action === "remove" ? "absent" : "value",
    valueSha256: semantic.valueSha256,
  }));
}

function assertPlanAtBaselineState(
  plan: ExecutableInstallPlan,
  adapter: FakeTransitionAdapter,
): void {
  for (const transition of plan.transitions) {
    assert.deepEqual(adapter.observation(transition.id).state, transition.baseline);
  }
}

function assertPlanAtDesiredState(
  plan: ExecutableInstallPlan,
  adapter: FakeTransitionAdapter,
): void {
  for (const transition of plan.transitions) {
    assert.deepEqual(adapter.observation(transition.id).state, transition.desired);
  }
}

function assertTransactionError(
  error: unknown,
  phase: InstallTransactionError["details"]["phase"],
): InstallTransactionError["details"] {
  assert.ok(error instanceof InstallTransactionError);
  assert.equal(error.details.phase, phase);
  assert.equal(error.details.committed, false);
  return error.details;
}

function mutatingIds(plan: ExecutableInstallPlan): string[] {
  return plan.transitions
    .filter((transition) => transition.mutates)
    .map((transition) => transition.id);
}

function fixtureRoots(name: string) {
  const root = path.resolve(tmpdir(), `install-transaction-${name}`);
  return {
    checkout: path.join(root, "checkout"),
    destination: path.join(root, "destination"),
    privateRoot: path.join(root, "private"),
  };
}

function resolveRelative(root: string, relativePath: string): string {
  return path.resolve(root, ...relativePath.split("/"));
}

function serializedHash(value: unknown): string {
  return sha256(`${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
