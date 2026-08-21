import { hashOwnedValue } from "./ownership-manifest.ts";
import type {
  ExternalRegistrationTransition,
  InstallTransitionAdapter,
  PreparedTransition,
  PreparedTransitionDisposition,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";

export interface ExternalRegistrationReplaceRequest {
  readonly key: string;
  readonly expectedValue?: string;
  readonly value?: string;
}

export interface ExternalRegistrationBackend {
  read(key: string, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  replace(
    request: ExternalRegistrationReplaceRequest,
    signal: AbortSignal,
  ): void | Promise<void>;
}

interface PreparedHandle {
  readonly token: symbol;
  readonly baselineValue?: string;
}

/**
 * Executes one semantic external registration through an injected compare-and-set
 * backend. Platform-specific environment and profile stores remain outside core.
 */
export class ExternalRegistrationInstallAdapter implements InstallTransitionAdapter {
  private readonly handles = new Map<string, PreparedHandle>();
  private readonly backend: ExternalRegistrationBackend;

  constructor(backend: ExternalRegistrationBackend) {
    this.backend = backend;
  }

  async inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation> {
    const transition = assertExternalTransition(context);
    throwIfAborted(signal);
    const value = await this.backend.read(transition.stage.key, signal);
    throwIfAborted(signal);
    return { transitionId: transition.id, state: stateFor(value) };
  }

  async prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const transition = assertExternalTransition(context);
    throwIfAborted(signal);
    const baselineValue = await this.backend.read(transition.stage.key, signal);
    const baseline = stateFor(baselineValue);
    if (
      observation.transitionId !== transition.id ||
      !statesEqual(observation.state, transition.baseline) ||
      !statesEqual(baseline, transition.baseline)
    ) {
      throw new Error(`External registration transition "${transition.id}" was not prepared from its baseline.`);
    }
    if (this.handles.has(transition.id)) {
      throw new Error(`External registration transition "${transition.id}" was prepared more than once.`);
    }
    const handle = { token: Symbol(transition.id), baselineValue };
    this.handles.set(transition.id, handle);
    return {
      transitionId: transition.id,
      postimage: structuredClone(transition.desired),
      stagingHandle: handle,
    };
  }

  async apply(
    context: TransitionAdapterContext,
    prepared: PreparedTransition,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = assertExternalTransition(context);
    const handle = this.requireHandle(transition, prepared);
    throwIfAborted(signal);
    const current = await this.backend.read(transition.stage.key, signal);
    if (!statesEqual(stateFor(current), transition.baseline)) {
      throw new Error(`External registration transition "${transition.id}" changed before apply.`);
    }
    await this.backend.replace({
      key: transition.stage.key,
      expectedValue: handle.baselineValue,
      value: transition.stage.desiredValue,
    }, signal);
    throwIfAborted(signal);
    return {
      transitionId: transition.id,
      operation: "apply",
      before: structuredClone(transition.baseline),
      after: structuredClone(transition.desired),
    };
  }

  async rollback(
    context: TransitionAdapterContext,
    receipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = assertExternalTransition(context);
    const handle = this.requireHandleById(transition);
    if (receipt && (receipt.transitionId !== transition.id || receipt.operation !== "apply")) {
      throw new Error(`External registration transition "${transition.id}" received an invalid receipt.`);
    }
    throwIfAborted(signal);
    const current = await this.backend.read(transition.stage.key, signal);
    if (!statesEqual(stateFor(current), transition.desired)) {
      throw new Error(`External registration transition "${transition.id}" changed before rollback.`);
    }
    await this.backend.replace({
      key: transition.stage.key,
      expectedValue: transition.stage.desiredValue,
      value: handle.baselineValue,
    }, signal);
    throwIfAborted(signal);
    return {
      transitionId: transition.id,
      operation: "rollback",
      before: structuredClone(transition.desired),
      after: structuredClone(transition.baseline),
    };
  }

  async cleanup(
    context: TransitionAdapterContext,
    _prepared: PreparedTransition | undefined,
    _disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    const transition = assertExternalTransition(context);
    throwIfAborted(signal);
    this.handles.delete(transition.id);
  }

  private requireHandle(
    transition: ExternalRegistrationTransition,
    prepared: PreparedTransition,
  ): PreparedHandle {
    const handle = this.requireHandleById(transition);
    if (prepared.transitionId !== transition.id || prepared.stagingHandle !== handle) {
      throw new Error(`External registration transition "${transition.id}" received unknown staged output.`);
    }
    return handle;
  }

  private requireHandleById(
    transition: ExternalRegistrationTransition,
  ): PreparedHandle {
    const handle = this.handles.get(transition.id);
    if (!handle || handle.token.description !== transition.id) {
      throw new Error(`External registration transition "${transition.id}" has no private rollback state.`);
    }
    return handle;
  }
}

function assertExternalTransition(
  context: TransitionAdapterContext,
): ExternalRegistrationTransition {
  const transition = context.transition;
  if (
    transition.kind !== "external-registration" ||
    transition.stage.type !== "external-registration"
  ) {
    throw new Error(`Transition "${transition.id}" is not an external registration.`);
  }
  return transition;
}

function stateFor(value: string | undefined): ExternalRegistrationTransition["baseline"] {
  return value === undefined
    ? { type: "external-registration" }
    : { type: "external-registration", valueSha256: hashOwnedValue(value) };
}

function statesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
}
