import {
  validateExecutableInstallPlan,
} from "./executable-install-plan.ts";
import type {
  ExecutableInstallPlan,
  InstallTransition,
  InstallTransitionAdapter,
  ObservedOpaqueSemanticState,
  OpaqueResourcePostimage,
  PreparedTransition,
  PreparedTransitionDisposition,
  ResourcePostimage,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";
import type { InstallWarning } from "./install-plan.ts";

export type InstallTransactionPhase =
  | "validation"
  | "staging"
  | "precondition"
  | "apply"
  | "verification";

export interface InstallTransactionIssue {
  readonly transitionId?: string;
  readonly operation: "inspect" | "prepare" | "apply" | "rollback" | "cleanup";
  readonly message: string;
}

export interface InstallTransactionResidual {
  readonly transitionId: string;
  readonly target: InstallTransition["target"];
  readonly reason:
    | "unknown-state"
    | "transaction-postimage-retained"
    | "rollback-postcondition-failed";
  readonly observed?: TransitionObservation;
  readonly recoveryArtifacts: readonly string[];
}

export interface InstallRollbackResult {
  readonly attempted: boolean;
  readonly complete: boolean;
  readonly errors: readonly InstallTransactionIssue[];
  readonly residuals: readonly InstallTransactionResidual[];
}

export interface InstallTransactionResult {
  readonly status: "committed";
  readonly committed: true;
  readonly appliedTransitionIds: readonly string[];
  readonly intentTransitionIds: readonly string[];
  readonly warnings: readonly InstallWarning[];
  readonly cleanupErrors: readonly InstallTransactionIssue[];
}

export interface InstallTransactionFailure {
  readonly status: "failed";
  readonly committed: false;
  readonly phase: InstallTransactionPhase;
  readonly cause: {
    readonly name: string;
    readonly message: string;
  };
  readonly appliedTransitionIds: readonly string[];
  readonly intentTransitionIds: readonly string[];
  readonly warnings: readonly InstallWarning[];
  readonly rollback: InstallRollbackResult;
  readonly cleanupErrors: readonly InstallTransactionIssue[];
}

export class InstallTransactionError extends Error {
  readonly details: InstallTransactionFailure;

  constructor(cause: unknown, details: Omit<InstallTransactionFailure, "cause">) {
    const serializedCause = serializeError(cause);
    super(`Install transaction failed during ${details.phase}: ${serializedCause.message}`, {
      cause,
    });
    this.name = "InstallTransactionError";
    this.details = { ...details, cause: serializedCause };
  }
}

export interface ExecuteInstallTransactionRequest {
  /** The executor clones and runtime-validates this value before resolving adapters. */
  readonly plan: unknown;
  readonly resolveAdapter: (
    context: TransitionAdapterContext,
  ) => InstallTransitionAdapter;
  readonly signal?: AbortSignal;
}

interface TransactionEntry {
  readonly context: TransitionAdapterContext;
  readonly adapter: InstallTransitionAdapter;
  stagingAttempted: boolean;
  prepared?: PreparedTransition;
  intent: boolean;
  invoked: boolean;
  applied: boolean;
  receipt?: TransitionReceipt;
}

interface MutableRollbackResult {
  attempted: boolean;
  complete: boolean;
  errors: InstallTransactionIssue[];
  residuals: InstallTransactionResidual[];
}

const MAX_RECONCILIATION_INSPECTIONS = 2;

export async function executeInstallTransaction(
  request: ExecuteInstallTransactionRequest,
): Promise<InstallTransactionResult> {
  let plan: ExecutableInstallPlan;
  try {
    plan = cloneAndValidatePlan(request.plan);
  } catch (cause) {
    throw new InstallTransactionError(cause, {
      status: "failed",
      committed: false,
      phase: "validation",
      appliedTransitionIds: [],
      intentTransitionIds: [],
      warnings: [],
      rollback: emptyRollbackResult(),
      cleanupErrors: [],
    });
  }

  const signal = request.signal ?? new AbortController().signal;
  const entries: TransactionEntry[] = [];
  try {
    for (const transition of plan.transitions) {
      const context = { plan, transition };
      entries.push({
        context,
        adapter: request.resolveAdapter(context),
        stagingAttempted: false,
        intent: false,
        invoked: false,
        applied: false,
      });
    }
  } catch (cause) {
    throw new InstallTransactionError(cause, {
      status: "failed",
      committed: false,
      phase: "staging",
      appliedTransitionIds: [],
      intentTransitionIds: [],
      warnings: plan.warnings,
      rollback: emptyRollbackResult(),
      cleanupErrors: [],
    });
  }

  const transaction = new InstallTransaction(plan, entries, signal);
  return await transaction.execute();
}

class InstallTransaction {
  private readonly plan: ExecutableInstallPlan;
  private readonly entries: TransactionEntry[];
  private readonly signal: AbortSignal;
  private phase: InstallTransactionPhase = "staging";
  private committed = false;
  private rollbackPromise?: Promise<InstallRollbackResult>;
  private cleanupPromise?: Promise<readonly InstallTransactionIssue[]>;

  constructor(
    plan: ExecutableInstallPlan,
    entries: TransactionEntry[],
    signal: AbortSignal,
  ) {
    this.plan = plan;
    this.entries = entries;
    this.signal = signal;
  }

  async execute(): Promise<InstallTransactionResult> {
    try {
      await this.stageAll();
      this.phase = "precondition";
      await this.verifyBaselineBarrier();
      throwIfAborted(this.signal);

      this.phase = "apply";
      for (const entry of this.entries) {
        if (!entry.context.transition.mutates) continue;
        throwIfAborted(this.signal);
        entry.intent = true;
        entry.invoked = true;
        const receipt = await entry.adapter.apply(
          entry.context,
          entry.prepared!,
          this.signal,
        );
        validateApplyReceipt(entry.context.transition, receipt);
        entry.receipt = receipt;

        const observation = await entry.adapter.inspect(entry.context, this.signal);
        validateObservationIdentity(entry.context.transition, observation);
        if (!observationMatchesDesired(entry.context.transition, observation)) {
          throw new Error(
            `Transition "${entry.context.transition.id}" did not reach its planned postcondition.`,
          );
        }
        entry.applied = true;
        throwIfAborted(this.signal);
      }

      this.phase = "verification";
      await this.verifyFinalPostimages();
      throwIfAborted(this.signal);
      this.committed = true;

      const cleanupErrors = await this.cleanup(new Set(), "committed");
      return {
        status: "committed",
        committed: true,
        appliedTransitionIds: this.appliedIds(),
        intentTransitionIds: this.intentIds(),
        warnings: this.plan.warnings,
        cleanupErrors,
      };
    } catch (cause) {
      if (this.committed) throw cause;
      const rollback = await this.rollback();
      const residualIds = new Set(
        rollback.residuals.map((residual) => residual.transitionId),
      );
      const cleanupErrors = await this.cleanup(residualIds, "rolled-back");
      throw new InstallTransactionError(cause, {
        status: "failed",
        committed: false,
        phase: this.phase,
        appliedTransitionIds: this.appliedIds(),
        intentTransitionIds: this.intentIds(),
        warnings: this.plan.warnings,
        rollback,
        cleanupErrors,
      });
    }
  }

  private async stageAll(): Promise<void> {
    for (const entry of this.entries) {
      if (!entry.context.transition.mutates) continue;
      throwIfAborted(this.signal);
      const observation = await entry.adapter.inspect(entry.context, this.signal);
      validateObservationIdentity(entry.context.transition, observation);
      if (!observationMatchesBaseline(entry.context.transition, observation)) {
        throw new Error(
          `Transition "${entry.context.transition.id}" changed before staging.`,
        );
      }

      entry.stagingAttempted = true;
      const prepared = await entry.adapter.prepare(
        entry.context,
        observation,
        this.signal,
      );
      validatePrepared(entry.context.transition, prepared);
      entry.prepared = prepared;
      throwIfAborted(this.signal);
    }
  }

  private async verifyBaselineBarrier(): Promise<void> {
    const observations: TransitionObservation[] = [];
    for (const entry of this.entries) {
      throwIfAborted(this.signal);
      const observation = await entry.adapter.inspect(entry.context, this.signal);
      validateObservationIdentity(entry.context.transition, observation);
      observations.push(observation);
    }
    throwIfAborted(this.signal);

    for (const [index, entry] of this.entries.entries()) {
      if (!observationMatchesBaseline(entry.context.transition, observations[index])) {
        throw new Error(
          `Transition "${entry.context.transition.id}" baseline changed before apply.`,
        );
      }
    }
  }

  private async verifyFinalPostimages(): Promise<void> {
    for (const entry of this.entries) {
      throwIfAborted(this.signal);
      if (entry.context.transition.mutates && (!entry.intent || !entry.receipt)) {
        throw new Error(
          `Transition "${entry.context.transition.id}" has no successful apply receipt.`,
        );
      }
      const observation = await entry.adapter.inspect(entry.context, this.signal);
      validateObservationIdentity(entry.context.transition, observation);
      if (!observationMatchesDesired(entry.context.transition, observation)) {
        throw new Error(
          `Transition "${entry.context.transition.id}" changed before commit.`,
        );
      }
    }
  }

  private rollback(): Promise<InstallRollbackResult> {
    if (this.rollbackPromise) return this.rollbackPromise;
    this.rollbackPromise = this.reconcileAndRollback();
    return this.rollbackPromise;
  }

  private async reconcileAndRollback(): Promise<InstallRollbackResult> {
    const result: MutableRollbackResult = {
      attempted: this.entries.some((entry) => entry.invoked),
      complete: true,
      errors: [],
      residuals: [],
    };
    const rollbackSignal = new AbortController().signal;

    for (const entry of [...this.entries].reverse()) {
      if (!entry.invoked) continue;
      const transition = entry.context.transition;
      const before = await inspectForReconciliation(
        entry,
        rollbackSignal,
        result.errors,
      );
      if (!before) {
        addResidual(result, entry, "unknown-state");
        continue;
      }
      if (observationMatchesRollbackBaseline(transition, before)) continue;
      if (!observationIsSafelyCompensatable(transition, before)) {
        addResidual(result, entry, "unknown-state", before);
        continue;
      }

      try {
        const rollbackReceipt = await entry.adapter.rollback(
          entry.context,
          entry.receipt,
          rollbackSignal,
        );
        validateRollbackReceipt(transition, rollbackReceipt);
      } catch (error) {
        result.errors.push(issue(transition.id, "rollback", error));
      }

      const after = await inspectForReconciliation(
        entry,
        rollbackSignal,
        result.errors,
      );
      if (after && observationMatchesRollbackBaseline(transition, after)) continue;
      if (after && observationIsSafelyCompensatable(transition, after)) {
        addResidual(result, entry, "transaction-postimage-retained", after);
      } else {
        addResidual(result, entry, "rollback-postcondition-failed", after);
      }
    }

    result.complete = result.residuals.length === 0;
    return freezeRollbackResult(result);
  }

  private cleanup(
    residualIds: ReadonlySet<string>,
    defaultDisposition: PreparedTransitionDisposition,
  ): Promise<readonly InstallTransactionIssue[]> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = this.cleanupPrepared(residualIds, defaultDisposition);
    return this.cleanupPromise;
  }

  private async cleanupPrepared(
    residualIds: ReadonlySet<string>,
    defaultDisposition: PreparedTransitionDisposition,
  ): Promise<readonly InstallTransactionIssue[]> {
    const errors: InstallTransactionIssue[] = [];
    const cleanupSignal = new AbortController().signal;
    for (const entry of [...this.entries].reverse()) {
      if (!entry.stagingAttempted) continue;
      const disposition = residualIds.has(entry.context.transition.id)
        ? "residual"
        : defaultDisposition;
      try {
        await entry.adapter.cleanup(
          entry.context,
          entry.prepared,
          disposition,
          cleanupSignal,
        );
      } catch (error) {
        errors.push(issue(entry.context.transition.id, "cleanup", error));
      }
    }
    return Object.freeze(errors);
  }

  private appliedIds(): string[] {
    return this.entries
      .filter((entry) => entry.applied)
      .map((entry) => entry.context.transition.id);
  }

  private intentIds(): string[] {
    return this.entries
      .filter((entry) => entry.intent)
      .map((entry) => entry.context.transition.id);
  }
}

async function inspectForReconciliation(
  entry: TransactionEntry,
  signal: AbortSignal,
  errors: InstallTransactionIssue[],
): Promise<TransitionObservation | undefined> {
  for (let attempt = 0; attempt < MAX_RECONCILIATION_INSPECTIONS; attempt += 1) {
    try {
      const observation = await entry.adapter.inspect(entry.context, signal);
      validateObservationIdentity(entry.context.transition, observation);
      return observation;
    } catch (error) {
      errors.push(issue(entry.context.transition.id, "inspect", error));
    }
  }
  return undefined;
}

function validatePrepared(
  transition: InstallTransition,
  prepared: PreparedTransition,
): void {
  if (!prepared || prepared.transitionId !== transition.id) {
    throw new Error(`Transition "${transition.id}" returned invalid staged output.`);
  }
  if (!resourcePostimagesEqual(prepared.postimage, transition.desired)) {
    throw new Error(
      `Transition "${transition.id}" staged output does not match its planned fingerprint.`,
    );
  }
  if (
    prepared.recoveryArtifacts !== undefined &&
    (!Array.isArray(prepared.recoveryArtifacts) ||
      !prepared.recoveryArtifacts.every((artifact) =>
        typeof artifact === "string" && pathIsAbsolute(artifact)
      ))
  ) {
    throw new Error(
      `Transition "${transition.id}" returned invalid private recovery artifacts.`,
    );
  }
}

function validateApplyReceipt(
  transition: InstallTransition,
  receipt: TransitionReceipt,
): void {
  validateReceiptIdentity(transition, receipt, "apply");
  if (!resourcePostimagesEqual(receipt.before, transition.baseline)) {
    throw new Error(`Transition "${transition.id}" apply receipt has the wrong preimage.`);
  }
  if (
    !resourcePostimagesEqual(receipt.after, transition.desired) &&
    !(transition.desired.type === "opaque" && semanticsMatchDesired(
      transition.desired,
      receipt.semantics,
    ))
  ) {
    throw new Error(`Transition "${transition.id}" apply receipt has the wrong postimage.`);
  }
}

function validateRollbackReceipt(
  transition: InstallTransition,
  receipt: TransitionReceipt,
): void {
  validateReceiptIdentity(transition, receipt, "rollback");
  if (transition.rollbackGuard.type !== "adapter-proven-bounded-inverse") {
    if (
      !resourcePostimagesEqual(receipt.before, transition.desired) ||
      !resourcePostimagesEqual(receipt.after, transition.baseline)
    ) {
      throw new Error(`Transition "${transition.id}" rollback receipt is not exact.`);
    }
    return;
  }

  if (
    transition.desired.type !== "opaque" ||
    !(
      resourcePostimagesEqual(receipt.before, transition.desired) ||
      semanticsMatchDesired(transition.desired, receipt.semantics)
    ) ||
    !(
      resourcePostimagesEqual(receipt.after, transition.baseline) ||
      semanticsMatchBaseline(transition.desired, receipt.semantics)
    )
  ) {
    throw new Error(`Transition "${transition.id}" rollback receipt lacks a bounded inverse proof.`);
  }
}

function validateReceiptIdentity(
  transition: InstallTransition,
  receipt: TransitionReceipt,
  operation: TransitionReceipt["operation"],
): void {
  if (
    !receipt || receipt.transitionId !== transition.id ||
    receipt.operation !== operation
  ) {
    throw new Error(`Transition "${transition.id}" returned an invalid ${operation} receipt.`);
  }
}

function validateObservationIdentity(
  transition: InstallTransition,
  observation: TransitionObservation,
): void {
  if (!observation || observation.transitionId !== transition.id) {
    throw new Error(`Transition "${transition.id}" returned an invalid observation.`);
  }
}

function observationMatchesBaseline(
  transition: InstallTransition,
  observation: TransitionObservation,
): boolean {
  return resourcePostimagesEqual(observation.state, transition.baseline);
}

function observationMatchesDesired(
  transition: InstallTransition,
  observation: TransitionObservation,
): boolean {
  if (transition.desired.type !== "opaque") {
    return resourcePostimagesEqual(observation.state, transition.desired);
  }
  return resourcePostimagesEqual(observation.state, transition.desired) ||
    semanticsMatchDesired(
      transition.desired,
      observation.semantics ?? opaqueSemantics(observation.state),
    );
}

function observationMatchesRollbackBaseline(
  transition: InstallTransition,
  observation: TransitionObservation,
): boolean {
  if (resourcePostimagesEqual(observation.state, transition.baseline)) return true;
  return transition.desired.type === "opaque" &&
    transition.rollbackGuard.type === "adapter-proven-bounded-inverse" &&
    semanticsMatchBaseline(
      transition.desired,
      observation.semantics ?? opaqueSemantics(observation.state),
    );
}

function observationIsSafelyCompensatable(
  transition: InstallTransition,
  observation: TransitionObservation,
): boolean {
  if (transition.rollbackGuard.type === "adapter-proven-bounded-inverse") {
    return transition.desired.type === "opaque" && semanticsMatchDesired(
      transition.desired,
      observation.semantics ?? opaqueSemantics(observation.state),
    );
  }
  return resourcePostimagesEqual(observation.state, transition.desired);
}

function semanticsMatchDesired(
  desired: OpaqueResourcePostimage,
  observed: readonly ObservedOpaqueSemanticState[] | undefined,
): boolean {
  if (!observed) return false;
  return desired.semantics.every((expected) => {
    const actual = observed.find((candidate) => candidate.semanticId === expected.semanticId);
    if (!actual || actual.harness !== expected.harness || actual.key !== expected.key) {
      return false;
    }
    if (expected.action === "remove") {
      return actual.state === "absent" && actual.valueSha256 === undefined;
    }
    return actual.state === "value" && actual.valueSha256 === expected.valueSha256;
  });
}

function semanticsMatchBaseline(
  desired: OpaqueResourcePostimage,
  observed: readonly ObservedOpaqueSemanticState[] | undefined,
): boolean {
  if (!observed) return false;
  return desired.semantics.every((expected) => {
    const actual = observed.find((candidate) => candidate.semanticId === expected.semanticId);
    if (
      !actual || actual.harness !== expected.harness || actual.key !== expected.key
    ) {
      return false;
    }
    if (expected.expectedValueSha256 === undefined) {
      return actual.state === "absent" && actual.valueSha256 === undefined;
    }
    return actual.state === "value" &&
      actual.valueSha256 === expected.expectedValueSha256;
  });
}

function opaqueSemantics(
  state: ResourcePostimage,
): readonly ObservedOpaqueSemanticState[] | undefined {
  return state.type === "opaque" ? desiredSemanticStates(state) : undefined;
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

function resourcePostimagesEqual(
  left: ResourcePostimage,
  right: ResourcePostimage,
): boolean {
  if (!left || !right || left.type !== right.type) return false;
  if (left.type === "opaque" && right.type === "opaque") {
    if (left.adapterKind !== right.adapterKind) return false;
    return left.semantics.length === right.semantics.length &&
      left.semantics.every((semantic) => {
        const other = right.semantics.find(
          (candidate) => candidate.semanticId === semantic.semanticId,
        );
        return other !== undefined && other.harness === semantic.harness &&
          other.key === semantic.key && other.action === semantic.action &&
          other.valueSha256 === semantic.valueSha256 &&
          other.expectedValueSha256 === semantic.expectedValueSha256;
      });
  }
  if (left.type === "opaque" || right.type === "opaque") return false;
  if (left.type === "file" && right.type === "file") return left.sha256 === right.sha256;
  if (
    left.type === "directory-tree" && right.type === "directory-tree" ||
    left.type === "dependency-tree" && right.type === "dependency-tree"
  ) {
    return left.sha256 === right.sha256;
  }
  return true;
}

function addResidual(
  result: MutableRollbackResult,
  entry: TransactionEntry,
  reason: InstallTransactionResidual["reason"],
  observed?: TransitionObservation,
): void {
  const transition = entry.context.transition;
  if (result.residuals.some((entry) => entry.transitionId === transition.id)) return;
  result.residuals.push({
    transitionId: transition.id,
    target: transition.target,
    reason,
    observed,
    recoveryArtifacts: Object.freeze([
      ...(entry.prepared?.recoveryArtifacts ?? []),
    ]),
  });
}

function pathIsAbsolute(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value);
}

function cloneAndValidatePlan(value: unknown): ExecutableInstallPlan {
  const clone = structuredClone(value);
  validateExecutableInstallPlan(clone);
  return deepFreeze(clone);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function freezeRollbackResult(result: MutableRollbackResult): InstallRollbackResult {
  return Object.freeze({
    attempted: result.attempted,
    complete: result.complete,
    errors: Object.freeze([...result.errors]),
    residuals: Object.freeze([...result.residuals]),
  });
}

function emptyRollbackResult(): InstallRollbackResult {
  return {
    attempted: false,
    complete: true,
    errors: [],
    residuals: [],
  };
}

function issue(
  transitionId: string | undefined,
  operation: InstallTransactionIssue["operation"],
  error: unknown,
): InstallTransactionIssue {
  return {
    transitionId,
    operation,
    message: serializeError(error).message,
  };
}

function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(
    signal.reason === undefined ? "The install transaction was cancelled." : String(signal.reason),
  );
  error.name = "AbortError";
  throw error;
}
