import {
  chmod,
  lstat,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";

import { hashOwnedValue } from "./ownership-manifest.ts";
import type {
  ExactResourceState,
  InstallTransitionAdapter,
  OpaqueAdapterChange,
  OpaqueRegistrationTransition,
  ObservedOpaqueSemanticState,
  PreparedTransition,
  PreparedTransitionDisposition,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";

interface InsertedBlockResource {
  readonly state: ExactResourceState;
  readonly content: string;
  readonly exists: boolean;
  readonly mode?: number;
}

interface InsertedBlockPreparedHandle {
  readonly token: symbol;
  readonly targetPath: string;
  readonly baselineContent: string;
  readonly baselineExists: boolean;
  readonly baselineMode?: number;
}

/**
 * Mutates only marked text blocks while preserving all other profile bytes.
 * The marker is the semantic key and the desired value is the exact block.
 */
export class InsertedBlockInstallAdapter implements InstallTransitionAdapter {
  private readonly handles = new Map<string, InsertedBlockPreparedHandle>();

  async inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation> {
    const transition = assertInsertedBlockTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(context, signal);
    return {
      transitionId: transition.id,
      state: resource.state,
      semantics: semanticStates(transition, resource.content),
    };
  }

  async prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const transition = assertInsertedBlockTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(context, signal);
    if (!resourceStatesEqual(resource.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" was not prepared from its baseline.`);
    }
    if (observation.transitionId !== transition.id ||
      !resourceStatesEqual(observation.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" received an invalid baseline observation.`);
    }
    assertBaselineSemantics(transition, resource.content);
    const handle: InsertedBlockPreparedHandle = {
      token: Symbol(transition.id),
      targetPath: resolveTargetPath(transition),
      baselineContent: resource.content,
      baselineExists: resource.exists,
      baselineMode: resource.mode,
    };
    if (this.handles.has(transition.id)) {
      throw new Error(`Transition "${transition.id}" was prepared more than once.`);
    }
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
    const transition = assertInsertedBlockTransition(context.transition);
    const handle = this.requireHandle(transition, prepared);
    throwIfAborted(signal);
    const current = await readResource(context, signal);
    assertExactState(current.state, transition.baseline, transition.id, "apply");
    assertBaselineSemantics(transition, current.content);
    const next = applyChanges(current.content, transition.stage.changes);
    await writeResource(handle.targetPath, next, current.mode ?? handle.baselineMode ?? 0o600, signal);
    return {
      transitionId: transition.id,
      operation: "apply",
      before: structuredClone(transition.baseline),
      after: structuredClone(transition.desired),
      semantics: semanticStates(transition, next),
    };
  }

  async rollback(
    context: TransitionAdapterContext,
    preparedReceipt: TransitionReceipt | undefined,
    signal: AbortSignal,
  ): Promise<TransitionReceipt> {
    const transition = assertInsertedBlockTransition(context.transition);
    const handle = this.requireHandleById(transition);
    if (preparedReceipt &&
      (preparedReceipt.transitionId !== transition.id || preparedReceipt.operation !== "apply")) {
      throw new Error(`Transition "${transition.id}" received an invalid apply receipt.`);
    }
    throwIfAborted(signal);
    const current = await readResource(context, signal);
    assertDesiredSemantics(transition, current.content);
    const next = restoreChanges(current.content, transition.stage.changes, handle.baselineContent);
    if (!handle.baselineExists && next.length === 0) {
      await rm(handle.targetPath, { force: true });
    } else {
      await writeResource(handle.targetPath, next, current.mode ?? handle.baselineMode ?? 0o600, signal);
    }
    return {
      transitionId: transition.id,
      operation: "rollback",
      before: structuredClone(transition.desired),
      after: structuredClone(transition.baseline),
      semantics: semanticStates(transition, next),
    };
  }

  async cleanup(
    context: TransitionAdapterContext,
    _prepared: PreparedTransition | undefined,
    _disposition: PreparedTransitionDisposition,
    signal: AbortSignal,
  ): Promise<void> {
    const transition = assertInsertedBlockTransition(context.transition);
    throwIfAborted(signal);
    this.handles.delete(transition.id);
  }

  private requireHandle(
    transition: OpaqueRegistrationTransition,
    prepared: PreparedTransition,
  ): InsertedBlockPreparedHandle {
    const handle = this.requireHandleById(transition);
    if (prepared.transitionId !== transition.id || prepared.stagingHandle !== handle) {
      throw new Error(`Transition "${transition.id}" received unknown staged output.`);
    }
    return handle;
  }

  private requireHandleById(
    transition: OpaqueRegistrationTransition,
  ): InsertedBlockPreparedHandle {
    const handle = this.handles.get(transition.id) as InsertedBlockPreparedHandle | undefined;
    if (!handle || handle.token.description !== transition.id) {
      throw new Error(`Transition "${transition.id}" has no private rollback state.`);
    }
    return handle;
  }
}

function assertInsertedBlockTransition(
  transition: TransitionAdapterContext["transition"],
): OpaqueRegistrationTransition {
  if (
    transition.kind !== "opaque-registration" ||
    transition.desired.adapterKind !== "inserted-block" ||
    transition.stage.type !== "adapter-prepare" ||
    transition.stage.adapterKind !== "inserted-block"
  ) {
    throw new Error(`Transition "${transition.id}" is not an inserted-block registration.`);
  }
  for (const change of transition.stage.changes) assertBlockChange(change);
  return transition;
}

function assertBlockChange(change: OpaqueAdapterChange): void {
  if (!change.key || /[\u0000-\u001f\u007f]/.test(change.key)) {
    throw new Error(`Inserted block "${change.semanticId}" has an invalid marker.`);
  }
  if (change.desiredValue !== undefined && typeof change.desiredValue !== "string") {
    throw new Error(`Inserted block "${change.semanticId}" has non-text content.`);
  }
}

async function readResource(
  context: TransitionAdapterContext,
  signal: AbortSignal,
): Promise<InsertedBlockResource> {
  const targetPath = resolveTargetPath(context.transition);
  try {
    const info = await lstat(targetPath);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Inserted block target is not a physical file: ${targetPath}`);
    }
    const content = await readFile(targetPath, "utf8");
    throwIfAborted(signal);
    return {
      state: { type: "file", sha256: hashBytes(content) },
      content,
      exists: true,
      mode: info.mode & 0o777,
    };
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
    throwIfAborted(signal);
    return { state: { type: "absent" }, content: "", exists: false };
  }
}

function semanticStates(
  transition: OpaqueRegistrationTransition,
  content: string,
): ObservedOpaqueSemanticState[] {
  return transition.stage.changes.map((change) => {
    const block = findBlock(content, change.key);
    return {
      semanticId: change.semanticId,
      harness: change.harness,
      key: change.key,
      state: block === undefined ? "absent" : "value",
      valueSha256: block === undefined ? undefined : hashOwnedValue(block),
    };
  });
}

function assertBaselineSemantics(
  transition: OpaqueRegistrationTransition,
  content: string,
): void {
  for (const change of transition.stage.changes) {
    const block = findBlock(content, change.key);
    const observedHash = block === undefined ? undefined : hashOwnedValue(block);
    if (observedHash !== change.expectedValueSha256) {
      throw new Error(`Inserted block "${change.key}" changed from its planned baseline.`);
    }
  }
}

function assertDesiredSemantics(
  transition: OpaqueRegistrationTransition,
  content: string,
): void {
  for (const change of transition.stage.changes) {
    const block = findBlock(content, change.key);
    const expectedHash = change.action === "remove" || change.desiredValue === undefined
      ? undefined
      : hashOwnedValue(change.desiredValue);
    const observedHash = block === undefined ? undefined : hashOwnedValue(block);
    if (observedHash !== expectedHash) {
      throw new Error(`Inserted block "${change.key}" changed before rollback.`);
    }
  }
}

function applyChanges(content: string, changes: readonly OpaqueAdapterChange[]): string {
  let next = content;
  for (const change of changes) {
    if (change.action === "remove") next = removeBlock(next, change.key);
    else if (typeof change.desiredValue !== "string") {
      throw new Error(`Inserted block "${change.key}" has no desired text.`);
    } else next = replaceOrAppendBlock(next, change.key, change.desiredValue);
  }
  return next;
}

function restoreChanges(
  content: string,
  changes: readonly OpaqueAdapterChange[],
  baselineContent: string,
): string {
  let next = content;
  for (const change of changes) {
    const baselineBlock = findBlock(baselineContent, change.key);
    if (baselineBlock === undefined) next = removeBlock(next, change.key);
    else next = replaceOrAppendBlock(next, change.key, baselineBlock);
  }
  return next;
}

function findBlock(content: string, marker: string): string | undefined {
  const startMarker = `# >>> ${marker} >>>`;
  const endMarker = `# <<< ${marker} <<<`;
  const markerStart = lineStartIndex(content, startMarker);
  if (markerStart < 0) return undefined;
  const start = markerStart > 0 && content[markerStart - 1] === "\n"
    ? markerStart - 1
    : markerStart;
  const endStart = lineStartIndex(content, endMarker, markerStart + startMarker.length);
  if (endStart < 0) throw new Error(`Inserted block "${marker}" has no closing marker.`);
  const end = lineEndIndex(content, endStart + endMarker.length);
  if (lineStartIndex(content, startMarker, end) >= 0) {
    throw new Error(`Inserted block "${marker}" appears more than once.`);
  }
  return content.slice(start, end);
}

function replaceOrAppendBlock(content: string, marker: string, block: string): string {
  const existing = findBlock(content, marker);
  if (existing !== undefined) {
    const markerStart = lineStartIndex(content, `# >>> ${marker} >>>`);
    const start = markerStart > 0 && content[markerStart - 1] === "\n"
      ? markerStart - 1
      : markerStart;
    const endStart = lineStartIndex(content, `# <<< ${marker} <<<`, markerStart + 1);
    const end = lineEndIndex(content, endStart + `# <<< ${marker} <<<`.length);
    return `${content.slice(0, start)}${ensureTrailingNewline(block)}${content.slice(end)}`;
  }
  return `${content}${ensureTrailingNewline(block)}`;
}

function removeBlock(content: string, marker: string): string {
  const existing = findBlock(content, marker);
  if (existing === undefined) return content;
  const startMarker = `# >>> ${marker} >>>`;
  const endMarker = `# <<< ${marker} <<<`;
  const markerStart = lineStartIndex(content, startMarker);
  const start = markerStart > 0 && content[markerStart - 1] === "\n"
    ? markerStart - 1
    : markerStart;
  const endStart = lineStartIndex(content, endMarker, markerStart + startMarker.length);
  const end = lineEndIndex(content, endStart + endMarker.length);
  return `${content.slice(0, start)}${content.slice(end)}`;
}

function lineStartIndex(content: string, marker: string, from = 0): number {
  let index = content.indexOf(marker, from);
  while (index >= 0 && index > 0 && content[index - 1] !== "\n") {
    index = content.indexOf(marker, index + marker.length);
  }
  return index;
}

function lineEndIndex(content: string, from: number): number {
  const newline = content.indexOf("\n", from);
  return newline < 0 ? content.length : newline + 1;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

async function writeResource(
  targetPath: string,
  content: string,
  mode: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  await writeFile(targetPath, content, { encoding: "utf8", mode });
  await chmod(targetPath, mode);
}

function resolveTargetPath(transition: OpaqueRegistrationTransition): string {
  return `${transition.target.root}/${transition.target.relativePath.split("/").join("/")}`;
}

function resourceStatesEqual(left: ExactResourceState, right: ExactResourceState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertExactState(
  actual: ExactResourceState,
  expected: ExactResourceState,
  transitionId: string,
  operation: string,
): void {
  if (!resourceStatesEqual(actual, expected)) {
    throw new Error(`Inserted block transition "${transitionId}" changed before ${operation}.`);
  }
}

function hashBytes(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("Operation aborted.");
}
