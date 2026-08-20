import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";

import type { JsonValue } from "./model.ts";
import { hashOwnedValue } from "./ownership-manifest.ts";
import type {
  ExactResourceState,
  InstallTransitionAdapter,
  OpaqueAdapterChange,
  OpaqueRegistrationTransition,
  ObservedOpaqueSemanticState,
  PreparedTransition,
  PreparedTransitionDisposition,
  ResourcePostimage,
  TransitionAdapterContext,
  TransitionObservation,
  TransitionReceipt,
} from "./executable-install-plan.ts";

interface ClaudeJsonPreparedHandle {
  readonly token: symbol;
  readonly transitionId: string;
  readonly targetPath: string;
  readonly baselineDocument: JsonObject;
  readonly baselineMode?: number;
}

interface ClaudeJsonResource {
  readonly state: ExactResourceState;
  readonly document: JsonObject;
  readonly exists: boolean;
  readonly mode?: number;
}

type JsonObject = { [key: string]: JsonValue };

/**
 * Mutates only Claude's named MCP registrations. Unrelated JSON is read and
 * carried through each postimage rather than restored from a whole-file copy.
 */
export class ClaudeJsonInstallAdapter implements InstallTransitionAdapter {
  private readonly handles = new Map<string, ClaudeJsonPreparedHandle>();

  async inspect(
    context: TransitionAdapterContext,
    signal: AbortSignal,
  ): Promise<TransitionObservation> {
    const transition = assertClaudeTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(context, signal, false);
    return {
      transitionId: transition.id,
      state: resource.state,
      semantics: semanticStates(transition, resource.document),
    };
  }

  async prepare(
    context: TransitionAdapterContext,
    observation: TransitionObservation,
    signal: AbortSignal,
  ): Promise<PreparedTransition> {
    const transition = assertClaudeTransition(context.transition);
    throwIfAborted(signal);
    const resource = await readResource(context, signal, false);
    if (!resourceStatesEqual(resource.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" was not prepared from its baseline.`);
    }
    if (observation.transitionId !== transition.id ||
      !resourceStatesEqual(observation.state, transition.baseline)) {
      throw new Error(`Transition "${transition.id}" received an invalid baseline observation.`);
    }
    assertBaselineSemantics(transition, resource.document);
    const handle: ClaudeJsonPreparedHandle = {
      token: Symbol(transition.id),
      transitionId: transition.id,
      targetPath: resolveTargetPath(transition),
      baselineDocument: cloneObject(resource.document),
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
    const transition = assertClaudeTransition(context.transition);
    const handle = this.requireHandle(transition, prepared);
    throwIfAborted(signal);

    // This is deliberately repeated immediately before mutation. The generic
    // transaction barrier protects the full plan; this protects this file from
    // edits made after that barrier.
    const current = await readResource(context, signal, true);
    assertExactState(current.state, transition.baseline, transition.id, "apply");
    assertBaselineSemantics(transition, current.document);
    const next = applyChanges(current.document, transition.stage.changes);
    await writeResource(handle.targetPath, next, current.mode ?? 0o600, signal);

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
    const transition = assertClaudeTransition(context.transition);
    const handle = this.requireHandleById(transition);
    if (
      preparedReceipt &&
      (preparedReceipt.transitionId !== transition.id || preparedReceipt.operation !== "apply")
    ) {
      throw new Error(`Transition "${transition.id}" received an invalid apply receipt.`);
    }
    throwIfAborted(signal);

    const current = await readResource(context, signal, true);
    assertDesiredSemantics(transition, current.document);
    const next = restoreChanges(
      current.document,
      transition.stage.changes,
      handle.baselineDocument,
    );
    await writeResource(handle.targetPath, next, current.mode ?? handle.baselineMode ?? 0o600, signal);

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
    const transition = assertClaudeTransition(context.transition);
    throwIfAborted(signal);
    this.handles.delete(transition.id);
  }

  private requireHandle(
    transition: OpaqueRegistrationTransition,
    prepared: PreparedTransition,
  ): ClaudeJsonPreparedHandle {
    const handle = this.requireHandleById(transition);
    if (prepared.transitionId !== transition.id || prepared.stagingHandle !== handle) {
      throw new Error(`Transition "${transition.id}" received unknown staged output.`);
    }
    return handle;
  }

  private requireHandleById(
    transition: OpaqueRegistrationTransition,
  ): ClaudeJsonPreparedHandle {
    const handle = this.handles.get(transition.id);
    if (!handle || handle.token.description !== transition.id) {
      throw new Error(`Transition "${transition.id}" has no private rollback state.`);
    }
    return handle;
  }
}

function assertClaudeTransition(
  transition: TransitionAdapterContext["transition"],
): OpaqueRegistrationTransition {
  if (
    transition.kind !== "opaque-registration" ||
    transition.desired.adapterKind !== "claude-json" ||
    transition.stage.type !== "adapter-prepare" ||
    transition.stage.adapterKind !== "claude-json"
  ) {
    throw new Error(`Transition "${transition.id}" is not a Claude JSON registration.`);
  }
  for (const change of transition.stage.changes) assertClaudeChange(change);
  const keys = transition.stage.changes.map((change) => change.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Transition "${transition.id}" contains duplicate Claude registration keys.`);
  }
  return transition;
}

function assertClaudeChange(change: OpaqueAdapterChange): void {
  const parts = change.key.split(".");
  if (
    parts.length !== 2 ||
    parts[0] !== "mcpServers" ||
    !parts[1] ||
    parts[1].includes("/") ||
    ["__proto__", "constructor", "prototype"].includes(parts[1])
  ) {
    throw new Error(`Claude registration key "${change.key}" is not a named MCP server.`);
  }
  if ((change.action === "set" || change.action === "restore") && change.desiredValue === undefined) {
    throw new Error(`Claude registration "${change.semanticId}" has no desired value.`);
  }
}

async function readResource(
  context: TransitionAdapterContext,
  signal: AbortSignal,
  requireParent: boolean,
): Promise<ClaudeJsonResource> {
  const transition = assertClaudeTransition(context.transition);
  const targetPath = await assertSafeTarget(transition, requireParent);
  throwIfAborted(signal);
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(targetPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) {
      return { state: { type: "absent" }, document: {}, exists: false };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Claude configuration is not a physical file: ${targetPath}`);
  }
  const content = await readFile(targetPath, "utf8");
  const after = await lstat(targetPath);
  if (
    info.dev !== after.dev || info.ino !== after.ino ||
    info.size !== after.size || info.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`Claude configuration changed while it was being read: ${targetPath}`);
  }
  const document = parseDocument(content, targetPath);
  return {
    state: { type: "file", sha256: hashText(content) },
    document,
    exists: true,
    mode: info.mode & 0o777,
  };
}

function parseDocument(content: string, targetPath: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`Claude configuration is not valid JSON: ${targetPath}: ${errorMessage(error)}`);
  }
  if (!isJsonObject(value)) {
    throw new Error(`Claude configuration must be a JSON object: ${targetPath}`);
  }
  const servers = value.mcpServers;
  if (servers !== undefined && !isJsonObject(servers)) {
    throw new Error(`Claude configuration has an ambiguous mcpServers value: ${targetPath}`);
  }
  return value;
}

async function assertSafeTarget(
  transition: OpaqueRegistrationTransition,
  requireParent: boolean,
): Promise<string> {
  const root = transition.target.root;
  if (!path.isAbsolute(root) || path.resolve(root) !== root) {
    throw new Error(`Claude transition "${transition.id}" has a non-canonical root.`);
  }
  const relativePath = transition.target.relativePath;
  const components = relativePath.split("/");
  if (
    !relativePath ||
    components.some((component) =>
      !component || component === "." || component === ".." ||
      component.includes("\\") || component.toLowerCase() === ".workflow"
    )
  ) {
    throw new Error(`Claude transition "${transition.id}" has an unsafe target path.`);
  }
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Claude transition root is not a physical directory: ${root}`);
  }
  const rootRealPath = await realpath(root);
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        if (requireParent && index < components.length - 1) {
          throw new Error(`Claude transition parent directory is missing: ${current}`);
        }
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Claude transition path contains a link or junction: ${current}`);
    }
    if (index < components.length - 1 && !info.isDirectory()) {
      throw new Error(`Claude transition path has a non-directory parent: ${current}`);
    }
    if (index < components.length - 1 && !isPathInside(rootRealPath, await realpath(current))) {
      throw new Error(`Claude transition path escapes its resource root: ${current}`);
    }
  }
  return path.resolve(root, ...components);
}

function applyChanges(
  document: JsonObject,
  changes: readonly OpaqueAdapterChange[],
): JsonObject {
  const next = cloneObject(document);
  const servers = ensureServers(next);
  for (const change of changes) {
    if (change.action === "remove") delete servers[serverName(change.key)];
    else setServerValue(servers, serverName(change.key), structuredClone(change.desiredValue!));
  }
  return next;
}

function restoreChanges(
  document: JsonObject,
  changes: readonly OpaqueAdapterChange[],
  baseline: JsonObject,
): JsonObject {
  const next = cloneObject(document);
  const servers = ensureServers(next);
  const baselineServers = isJsonObject(baseline.mcpServers) ? baseline.mcpServers : undefined;
  for (const change of changes) {
    const name = serverName(change.key);
    if (baselineServers && Object.prototype.hasOwnProperty.call(baselineServers, name)) {
      setServerValue(servers, name, structuredClone(baselineServers[name]));
    } else {
      delete servers[name];
    }
  }
  return next;
}

function setServerValue(servers: JsonObject, name: string, value: JsonValue): void {
  Object.defineProperty(servers, name, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function ensureServers(document: JsonObject): JsonObject {
  if (document.mcpServers === undefined) {
    document.mcpServers = {};
  }
  if (!isJsonObject(document.mcpServers)) {
    throw new Error("Claude configuration has an ambiguous mcpServers value.");
  }
  return document.mcpServers;
}

function semanticStates(
  transition: OpaqueRegistrationTransition,
  document: JsonObject,
): ObservedOpaqueSemanticState[] {
  const servers = isJsonObject(document.mcpServers) ? document.mcpServers : {};
  return transition.stage.changes.map((change) => {
    const name = serverName(change.key);
    if (!Object.prototype.hasOwnProperty.call(servers, name)) {
      return {
        semanticId: change.semanticId,
        harness: change.harness,
        key: change.key,
        state: "absent" as const,
      };
    }
    return {
      semanticId: change.semanticId,
      harness: change.harness,
      key: change.key,
      state: "value" as const,
      valueSha256: hashOwnedValue(servers[name]),
    };
  });
}

function assertBaselineSemantics(
  transition: OpaqueRegistrationTransition,
  document: JsonObject,
): void {
  const actual = semanticStates(transition, document);
  for (const change of transition.stage.changes) {
    const observed = actual.find((candidate) => candidate.semanticId === change.semanticId)!;
    const expectedState = change.expectedValueSha256 === undefined ? "absent" : "value";
    if (
      observed.state !== expectedState ||
      observed.valueSha256 !== change.expectedValueSha256
    ) {
      throw new Error(`Claude registration "${change.key}" changed from its planned baseline.`);
    }
  }
}

function assertDesiredSemantics(
  transition: OpaqueRegistrationTransition,
  document: JsonObject,
): void {
  const actual = semanticStates(transition, document);
  for (const change of transition.stage.changes) {
    const observed = actual.find((candidate) => candidate.semanticId === change.semanticId)!;
    const expectedHash = change.action === "remove" ? undefined : hashOwnedValue(change.desiredValue!);
    const expectedState = expectedHash === undefined ? "absent" : "value";
    if (observed.state !== expectedState || observed.valueSha256 !== expectedHash) {
      throw new Error(`Claude registration "${change.key}" was modified before rollback.`);
    }
  }
}

async function writeResource(
  targetPath: string,
  document: JsonObject,
  mode: number,
  signal: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  try {
    await writeFile(temporaryPath, content, { flag: "wx", mode: mode || 0o600 });
    await chmod(temporaryPath, mode || 0o600);
    throwIfAborted(signal);
    await replaceFile(temporaryPath, targetPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function replaceFile(temporaryPath: string, targetPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await rename(temporaryPath, targetPath);
    return;
  }

  const displacedPath = `${targetPath}.${randomUUID()}.old`;
  let displaced = false;
  try {
    try {
      await rename(targetPath, displacedPath);
      displaced = true;
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
    try {
      await rename(temporaryPath, targetPath);
    } catch (error) {
      if (displaced) await rename(displacedPath, targetPath);
      throw error;
    }
  } finally {
    if (displaced) await rm(displacedPath, { force: true }).catch(() => undefined);
  }
}

function assertExactState(
  actual: ExactResourceState,
  expected: ExactResourceState,
  transitionId: string,
  operation: string,
): void {
  if (!resourceStatesEqual(actual, expected)) {
    throw new Error(`Transition "${transitionId}" changed before ${operation}.`);
  }
}

function resourceStatesEqual(left: ResourcePostimage, right: ResourcePostimage): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "file" && right.type === "file") return left.sha256 === right.sha256;
  return left.type === "absent" && right.type === "absent";
}

function serverName(key: string): string {
  return key.slice("mcpServers.".length);
}

function resolveTargetPath(transition: OpaqueRegistrationTransition): string {
  return path.resolve(transition.target.root, ...transition.target.relativePath.split("/"));
}

function cloneObject(value: JsonObject): JsonObject {
  return structuredClone(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null &&
    "code" in error && (error as { code?: unknown }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(signal.reason === undefined ? "The install operation was cancelled." : String(signal.reason));
  error.name = "AbortError";
  throw error;
}
